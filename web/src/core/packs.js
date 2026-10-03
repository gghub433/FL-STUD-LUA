// Plugin packs: downloadable bundles of instruments and effects.
//
// A pack is ONE self-contained ES module (no imports) that announces itself to the host:
//
//   globalThis.__flluaRegisterPack({
//     id: 'my-pack', name: 'My Pack', version: '1.0.0', author: 'Me', license: 'MIT', description: '…', api: 1,
//     plugins: (api) => ({ instruments: { bass: { schema, meta, create(sr, host) {…}, presets: {…} } }, effects: {…} }),
//   });
//
// `api` carries what a plugin needs (parameter helpers, the DSP toolkit, FFT), so a pack never imports anything and the
// same file can be evaluated in every realm that renders audio: the page (parameter schemas, UI), the AudioWorklet
// (live sound) and the export Worker (offline render). Plugin types are namespaced: `<pack id>.<plugin name>`.
//
// registerPack() validates everything before it registers anything: shape, parameter definitions, and a smoke test that
// plays notes / feeds noise through every plugin (with each parameter at its extremes) and rejects NaN, runaway levels
// and plugins that are far too slow.
import * as schemaMod from './schema.js';
import * as dsp from './dsp.js';
import { FFT, getFFT, hann } from './fft.js';
import { BLOCK, PPQ } from './constants.js';
import { INSTRUMENTS, registerInstrument, hasInstrument } from './instruments/index.js';
import { EFFECTS, registerEffect, hasEffect } from './effects/index.js';
import { INSTRUMENT_PRESETS, EFFECT_PRESETS } from './presets.js';
import { extraSounds } from './factory.js';

export const PACK_API_VERSION = 1;
export const ID_RE = /^[a-z0-9][a-z0-9-]{1,30}$/;
const PARAM_RE = /^[A-Za-z][A-Za-z0-9_]{0,30}$/;

export function packApi() {
  const { def, bool, choice, defaults, schemaMap, clampParam, toNorm, fromNorm, format } = schemaMod;
  return Object.freeze({
    version: PACK_API_VERSION,
    params: Object.freeze({ def, bool, choice, defaults, schemaMap, clampParam, toNorm, fromNorm, format }),
    dsp: Object.freeze({ ...dsp }),
    fft: Object.freeze({ FFT, getFFT, hann }),
    BLOCK, PPQ,
  });
}

// ---------------------------------------------------------------------------------------------- registry
const packs = new Map();                 // id -> info
export let lastPack = null;              // info of the pack registered last (read by the loader right after an import)
export const loadedPacks = () => [...packs.values()];
// MIDI controller scripts from packs: id -> { name, description, ports: [substring of the device name], create(api) }
export const controllerScripts = new Map();
// Sounds from packs (samples made by code when first used): 'pack:<pack id>:<sound>' -> { name, cat, pack, gen(sr) }
export const packSounds = new Map();
export const isPackSoundId = (id) => typeof id === 'string' && id.startsWith('pack:');
extraSounds.render = (id, sr) => renderPackSound(id, sr);
export function renderPackSound(id, sr) {
  const s = packSounds.get(id);
  if (!s) return null;
  const out = s.gen(sr);
  return Array.isArray(out) ? out.slice(0, 2) : [out];
}
export const resetLastPack = () => { lastPack = null; };
export const packOfType = (type) => { const i = String(type).indexOf('.'); return i > 0 ? String(type).slice(0, i) : null; };

// ---------------------------------------------------------------------------------------------- validation
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());     // AudioWorklet scopes have no `performance`
const fail = (where, msg) => { throw new Error(`${where}: ${msg}`); };
const finite = (v) => typeof v === 'number' && Number.isFinite(v);

function checkSchema(where, schema) {
  if (!Array.isArray(schema) || !schema.length) fail(where, 'schema must be a non-empty array of parameter definitions');
  if (schema.length > 200) fail(where, 'more than 200 parameters');
  const seen = new Set();
  for (const d of schema) {
    if (!d || typeof d !== 'object' || !PARAM_RE.test(d.id || '')) fail(where, `bad parameter id "${d && d.id}"`);
    if (seen.has(d.id)) fail(where, `duplicate parameter "${d.id}"`);
    seen.add(d.id);
    if (typeof d.name !== 'string' || !d.name) fail(where, `parameter "${d.id}" has no name`);
    if (!finite(d.min) || !finite(d.max) || !finite(d.def) || d.max < d.min || d.def < d.min || d.def > d.max) fail(where, `parameter "${d.id}" has an invalid range or default`);
    if (d.curve === 'log' && d.min <= 0) fail(where, `parameter "${d.id}" is logarithmic, so its minimum must be above 0`);
  }
}

const HOST = () => ({ tempo: 120, tick: 0, playing: false, sr: 44100, getSample: () => null });
const bounded = (buf, limit) => { for (let i = 0; i < buf.length; i++) { const v = buf[i]; if (!(v === v) || v > limit || v < -limit) return false; } return true; };

function setAll(inst, schema, pick) { for (const d of schema) inst.setParam(d.id, pick(d)); }

function smokeInstrument(where, mod, t0) {
  const SR = 44100, N = 128 * 40;
  const run = (pick) => {
    const inst = mod.create(SR, HOST());
    for (const fn of ['setParam', 'noteOn', 'noteOff', 'allOff', 'process']) if (typeof inst[fn] !== 'function') fail(where, `instrument has no ${fn}()`);
    setAll(inst, mod.schema, pick);
    if (inst.setData) inst.setData({ params: {}, sample: null });
    const L = new Float32Array(N), R = new Float32Array(N);
    const notes = [[0, 36], [0, 60], [0, 64], [2000, 84], [3000, 24]];
    for (let b = 0; b < N; b += 128) {
      for (const [at, key] of notes) if (at >= b && at < b + 128) inst.noteOn({ key, vel: key === 60 ? 1 : 0.6, pan: 0, fine: 0, rel: 64, len: 0 });
      if (b === 128 * 24) for (const [, key] of notes) inst.noteOff(key);
      inst.process(L, R, b, b + 128);
    }
    if (!bounded(L, 16) || !bounded(R, 16)) fail(where, 'the output contains NaN or runaway levels (more than +24 dB)');
    inst.allOff();
    inst.process(new Float32Array(128), new Float32Array(128), 0, 128);
  };
  run((d) => d.def);
  for (const d of mod.schema) { run((q) => (q === d ? q.min : q.def)); run((q) => (q === d ? q.max : q.def)); }
  if (now() - t0 > 8000) fail(where, 'the plugin is too slow to run in real time');
}

function smokeEffect(where, mod, t0) {
  const SR = 44100, N = 128 * 40;
  const run = (pick, noise) => {
    const fx = mod.create(SR, HOST());
    for (const fn of ['setParam', 'process']) if (typeof fx[fn] !== 'function') fail(where, `effect has no ${fn}()`);
    setAll(fx, mod.schema, pick);
    let seed = 12345;
    for (let b = 0; b < N; b += 128) {
      const L = new Float32Array(128), R = new Float32Array(128);
      for (let i = 0; i < 128; i++) {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        const n = noise ? (seed / 2147483648 - 1) * 0.6 : 0;
        const s = Math.sin((b + i) * 0.07) * 0.5;
        L[i] = n + s; R[i] = noise ? n * 0.7 - s : 0;
      }
      fx.process(L, R, 128, { scL: null, scR: null });
      if (!bounded(L, 32) || !bounded(R, 32)) fail(where, 'the output contains NaN or runaway levels (more than +30 dB)');
    }
    if (fx.latency !== undefined && !(finite(fx.latency) && fx.latency >= 0 && fx.latency < 44100)) fail(where, 'latency must be a number of samples below one second');
  };
  run((d) => d.def, true); run((d) => d.def, false);
  for (const d of mod.schema) { run((q) => (q === d ? q.min : q.def), true); run((q) => (q === d ? q.max : q.def), true); }
  if (now() - t0 > 8000) fail(where, 'the plugin is too slow to run in real time');
}

// A controller script must survive a burst of messages with a do-nothing API
function smokeScript(where, mod, t0) {
  const noop = () => {};
  const api = new Proxy({}, { get: (_, k) => (k === 'channels' || k === 'channelParams' ? () => [] : k === 'tempo' ? 120 : k === 'playing' ? false : k === 'selected' ? null : noop) });
  const inst = mod.create(api) || {};
  if (inst.onMidi && typeof inst.onMidi !== 'function') throw new Error('onMidi must be a function');
  for (let i = 0; i < 64 && inst.onMidi; i++) inst.onMidi([0x90 | (i & 15), i, i & 1 ? 0 : 100], 'test device');
  for (let i = 0; i < 64 && inst.onMidi; i++) inst.onMidi([0xb0 | (i & 15), i, i * 2], 'test device');
  if (inst.dispose) inst.dispose();
  if (now() - t0 > 500) fail(where, 'the script is far too slow');
}

// -> { id, name, version, plugins: [{ kind, type, name, desc, mod }], desc } or throws a readable Error
export function validatePack(desc, { smoke = true } = {}) {
  if (!desc || typeof desc !== 'object') fail('pack', 'the pack did not describe itself');
  if (!ID_RE.test(desc.id || '')) fail('pack', 'the id must be 2 to 31 characters of a-z, 0-9 and "-"');
  if (typeof desc.name !== 'string' || !desc.name || desc.name.length > 60) fail('pack', 'the name is missing or longer than 60 characters');
  if (typeof desc.version !== 'string' || !/^\d+\.\d+\.\d+/.test(desc.version)) fail('pack', 'the version must look like 1.0.0');
  if ((desc.api || 1) > PACK_API_VERSION) fail('pack', `this pack needs plugin API ${desc.api} (this FL LUA has ${PACK_API_VERSION}): update FL LUA`);
  if (typeof desc.plugins !== 'function' && typeof desc.sounds !== 'function') fail('pack', 'plugins must be a function that receives the API');
  let made = {};
  if (typeof desc.plugins === 'function') { try { made = desc.plugins(packApi()); } catch (e) { fail('pack', `plugins() threw: ${e.message || e}`); } }
  const plugins = [];
  const take = (kind, group) => {
    for (const [name, mod] of Object.entries(group || {})) {
      const where = `${desc.id}.${name}`;
      if (!ID_RE.test(name)) fail(where, 'plugin names are 2 to 31 characters of a-z, 0-9 and "-"');
      const type = `${desc.id}.${name}`;
      if (kind === 'instrument' ? (hasInstrument(type) && !(packs.has(desc.id))) : (hasEffect(type) && !(packs.has(desc.id)))) fail(where, 'this plugin type already exists');
      if (!mod || typeof mod.create !== 'function') fail(where, 'create(sr, host) is missing');
      if (!mod.meta || typeof mod.meta.name !== 'string' || !mod.meta.name) fail(where, 'meta.name is missing');
      checkSchema(where, mod.schema);
      plugins.push({ kind, type, name, mod, desc: String(mod.meta.description || ''), title: mod.meta.name });
    }
  };
  take('instrument', made && made.instruments);
  take('effect', made && made.effects);
  // controller scripts: { name: { meta: { name, description }, ports: ['MPK', …], create(api) -> { onMidi(bytes, port) -> true when handled, dispose() } } }
  for (const [name, mod] of Object.entries((made && made.controllers) || {})) {
    const where = `${desc.id}.${name}`;
    if (!ID_RE.test(name)) fail(where, 'script names are 2 to 31 characters of a-z, 0-9 and "-"');
    if (!mod || typeof mod.create !== 'function') fail(where, 'create(api) is missing');
    if (!mod.meta || typeof mod.meta.name !== 'string' || !mod.meta.name) fail(where, 'meta.name is missing');
    if (mod.ports !== undefined && !(Array.isArray(mod.ports) && mod.ports.every((x) => typeof x === 'string'))) fail(where, 'ports must be a list of device names');
    plugins.push({ kind: 'controller', type: where, name, mod, desc: String(mod.meta.description || ''), title: mod.meta.name });
  }
  // sounds: { category: { id: { name, gen(sr) -> Float32Array | [L, R] } } }
  const sounds = [];
  const sdesc = typeof desc.sounds === 'function' ? (() => { try { return desc.sounds(packApi()); } catch (e) { return fail('pack', `sounds() threw: ${e.message || e}`); } })() : null;
  for (const [cat, list] of Object.entries(sdesc || {})) {
    if (typeof cat !== 'string' || !cat || cat.length > 40) fail('pack', 'sound categories are names up to 40 characters');
    for (const [name, snd] of Object.entries(list || {})) {
      const where = `${desc.id}.${name}`;
      if (!ID_RE.test(name)) fail(where, 'sound ids are 2 to 31 characters of a-z, 0-9 and "-"');
      if (!snd || typeof snd.gen !== 'function' || typeof snd.name !== 'string' || !snd.name) fail(where, 'a sound needs a name and gen(sampleRate)');
      if (sounds.some((x) => x.id === name)) fail(where, 'duplicate sound id');
      sounds.push({ id: name, name: snd.name.slice(0, 60), cat, gen: snd.gen });
    }
  }
  if (sounds.length > 500) fail('pack', 'more than 500 sounds in one pack');
  if (!plugins.length && !sounds.length) fail('pack', 'the pack contains no plugins');
  if (plugins.length > 40) fail('pack', 'more than 40 plugins in one pack');
  for (const p of smoke ? plugins : []) {
    const t0 = now();
    try { (p.kind === 'instrument' ? smokeInstrument : p.kind === 'effect' ? smokeEffect : smokeScript)(p.type, p.mod, t0); }
    catch (e) { if (/^[\w.-]+: /.test(e.message)) throw e; fail(p.type, `crashed during the self-test: ${e.message || e}`); }
  }
  if (smoke && sounds.length) {
    const t0 = now();
    for (const s of sounds) {
      let out;
      try { out = s.gen(11025); } catch (e) { fail(`${desc.id}.${s.id}`, `could not render: ${e.message || e}`); }
      const chs = Array.isArray(out) ? out : [out];
      if (!chs.length || !chs.every((c) => c instanceof Float32Array && c.length > 0 && c.length <= 11025 * 60)) fail(`${desc.id}.${s.id}`, 'a sound must be one or two Float32Arrays, up to 60 seconds');
      if (!chs.every((c) => bounded(c, 4))) fail(`${desc.id}.${s.id}`, 'the sound contains NaN or runaway levels');
    }
    if (now() - t0 > 20000) fail('pack', 'the sounds take far too long to make');
  }
  return { id: desc.id, name: desc.name, version: desc.version, author: String(desc.author || ''), license: String(desc.license || ''), description: String(desc.description || ''), plugins, sounds };
}

// Validates and registers a pack. Registering a pack id again replaces it (an update).
export function registerPack(desc, opts) {
  const v = validatePack(desc, opts);
  for (const p of v.plugins) {
    const mod = { schema: p.mod.schema, meta: { ...p.mod.meta, id: p.type, pack: v.id }, create: p.mod.create };
    for (const k of Object.keys(p.mod)) if (!(k in mod) && k !== 'presets') mod[k] = p.mod[k];
    if (p.kind === 'instrument') { registerInstrument(p.type, mod); if (p.mod.presets) INSTRUMENT_PRESETS[p.type] = { ...p.mod.presets }; }
    else if (p.kind === 'effect') { registerEffect(p.type, mod); if (p.mod.presets) EFFECT_PRESETS[p.type] = { ...p.mod.presets }; }
    else controllerScripts.set(p.type, { name: p.title, description: p.desc, ports: p.mod.ports || [], create: p.mod.create, pack: v.id });
  }
  for (const k of [...packSounds.keys()]) if (packSounds.get(k).pack === v.id) packSounds.delete(k);
  for (const s of v.sounds) packSounds.set(`pack:${v.id}:${s.id}`, { name: s.name, cat: s.cat, pack: v.id, gen: s.gen });
  const info = { id: v.id, name: v.name, version: v.version, author: v.author, license: v.license, description: v.description, plugins: v.plugins.map((p) => ({ kind: p.kind, type: p.type, name: p.title, description: p.desc })), sounds: v.sounds.length };
  packs.set(v.id, info);
  lastPack = info;
  return info;
}

// Removes a pack's plugins from the registries of this realm (the worklet can only forget them after a reload).
export function unregisterPack(id) {
  const info = packs.get(id);
  if (!info) return false;
  for (const p of info.plugins) {
    if (p.kind === 'instrument') { delete INSTRUMENTS[p.type]; delete INSTRUMENT_PRESETS[p.type]; }
    else if (p.kind === 'effect') { delete EFFECTS[p.type]; delete EFFECT_PRESETS[p.type]; }
    else controllerScripts.delete(p.type);
  }
  for (const k of [...packSounds.keys()]) if (packSounds.get(k).pack === id) packSounds.delete(k);
  packs.delete(id);
  return true;
}

// Makes `scope.__flluaRegisterPack` available: this is what a pack module calls when it is evaluated.
// `smoke: false` is for realms that load packs the page has already validated (the worklet, the export worker).
export function installPackHook(scope = globalThis, opts) {
  scope.__flluaRegisterPack = (desc) => registerPack(desc, opts);
}

// ---------------------------------------------------------------------------------------------- projects that need packs
// Plugin types in raw project data that no loaded plugin provides, grouped by the pack they would come from.
export function missingPlugins(raw) {
  const out = new Map();
  const add = (type) => {
    if (typeof type !== 'string') return;
    const pack = packOfType(type) || 'unknown';
    if (!out.has(pack)) out.set(pack, new Set());
    out.get(pack).add(type);
  };
  const scanPatch = (patch) => { for (const n of (patch && Array.isArray(patch.nodes) ? patch.nodes : [])) if (n && (n.type === 'inst' ? !hasInstrument(n.ref) : n.type === 'fx' ? !hasEffect(n.ref) : false)) add(n.ref); };
  for (const c of (raw && Array.isArray(raw.channels) ? raw.channels : [])) {
    if (!c || typeof c.type !== 'string') continue;
    if (!hasInstrument(c.type) && !['audio', 'automation', 'layer'].includes(c.type)) add(c.type);
    else if (c.type === 'patcher') scanPatch(c.patch);
  }
  const tracks = raw && raw.mixer && Array.isArray(raw.mixer.tracks) ? raw.mixer.tracks : [];
  for (const t of tracks) for (const f of (t && Array.isArray(t.fx) ? t.fx : [])) {
    if (!f || typeof f.type !== 'string') continue;
    if (!hasEffect(f.type)) add(f.type); else if (f.type === 'patcher' && f.extra) scanPatch(f.extra.patch);
  }
  return out;
}

// Types that were dropped while loading projects, waiting to be reported to the user (see Store.replaceProject).
const dropped = new Map();
export function noteMissing(raw) {
  for (const [pack, types] of missingPlugins(raw)) {
    if (!dropped.has(pack)) dropped.set(pack, new Set());
    for (const t of types) dropped.get(pack).add(t);
  }
}
// a 'pack:<id>:<sound>' sample that neither the pack nor the saved project could provide
export function noteMissingSound(id) {
  const pack = String(id).split(':')[1] || 'unknown';
  if (!dropped.has(pack)) dropped.set(pack, new Set());
  dropped.get(pack).add('sounds');
}
export function takeMissing() {
  const out = [...dropped].map(([pack, types]) => ({ pack, types: [...types] }));
  dropped.clear();
  return out;
}
