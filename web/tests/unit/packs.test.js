import test from 'node:test';
import assert from 'node:assert/strict';
import { registerPack, unregisterPack, validatePack, packApi, installPackHook, missingPlugins, takeMissing, noteMissing, packOfType, loadedPacks } from '../../src/core/packs.js';
import { createInstrument, hasInstrument, instrumentSchema, INSTRUMENTS } from '../../src/core/instruments/index.js';
import { createEffect, hasEffect, EFFECTS } from '../../src/core/effects/index.js';
import { INSTRUMENT_PRESETS, EFFECT_PRESETS } from '../../src/core/presets.js';
import { createProject, createChannel, createFxSlot, createNote, normalize } from '../../src/core/project.js';
import { renderOffline } from '../../src/core/offline.js';
import { defaultPatch, addNode, connect, normalizePatch } from '../../src/core/patcher/spec.js';
import { createEffect as mkFx } from '../../src/core/effects/index.js';

const SR = 44100;
const peak = (a) => { let m = 0; for (const v of a) m = Math.max(m, Math.abs(v)); return m; };

// a small but complete pack: one sine instrument and one gain effect
const makePack = (over = {}) => ({
  id: 'test-pack', name: 'Test Pack', version: '1.0.0', author: 'tests', license: 'MIT', description: 'for the unit tests', api: 1,
  plugins: (api) => {
    const { def, defaults } = api.params, { TAU, mtof } = api.dsp;
    const isch = [def('gain', 'Gain', 0, 1, 0.5), def('detune', 'Detune', -100, 100, 0, { unit: 'cents' })];
    const fsch = [def('level', 'Level', 0, 2, 1)];
    class Sine {
      constructor(sr) { this.sr = sr; this.p = defaults(isch); this.v = new Map(); }
      get active() { return this.v.size > 0; }
      setParam(id, x) { this.p[id] = x; }
      noteOn(ev) { this.v.set(ev.key, { ph: 0, f: mtof(ev.key + this.p.detune / 100), vel: ev.vel }); }
      noteOff(k) { this.v.delete(k); }
      allOff() { this.v.clear(); }
      process(L, R, i0, i1) { for (const v of this.v.values()) for (let i = i0; i < i1; i++) { const s = Math.sin(TAU * v.ph) * this.p.gain * v.vel; v.ph = (v.ph + v.f / this.sr) % 1; L[i] += s; R[i] += s; } }
    }
    class Gain { constructor() { this.p = defaults(fsch); } setParam(id, x) { this.p[id] = x; } process(L, R, n) { for (let i = 0; i < n; i++) { L[i] *= this.p.level; R[i] *= this.p.level; } } }
    return {
      instruments: { sine: { schema: isch, meta: { name: 'Test Sine', kind: 'test', rootDefault: 60, description: 'a sine' }, create: (sr) => new Sine(sr), presets: { Quiet: { gain: 0.1 } } } },
      effects: { gain: { schema: fsch, meta: { name: 'Test Gain', category: 'Utility', description: 'level' }, create: () => new Gain(), presets: { Half: { level: 0.5 } } } },
    };
  },
  ...over,
});

test('a valid pack registers namespaced plugins, presets and works through the normal registries', () => {
  const info = registerPack(makePack());
  assert.equal(info.id, 'test-pack');
  assert.deepEqual(info.plugins.map((p) => p.type).sort(), ['test-pack.gain', 'test-pack.sine']);
  assert.ok(hasInstrument('test-pack.sine') && hasEffect('test-pack.gain'));
  assert.equal(INSTRUMENTS['test-pack.sine'].meta.id, 'test-pack.sine');
  assert.equal(INSTRUMENTS['test-pack.sine'].meta.pack, 'test-pack');
  assert.deepEqual(INSTRUMENT_PRESETS['test-pack.sine'], { Quiet: { gain: 0.1 } });
  assert.deepEqual(EFFECT_PRESETS['test-pack.gain'], { Half: { level: 0.5 } });
  const inst = createInstrument('test-pack.sine', SR, { sr: SR });
  inst.noteOn({ key: 69, vel: 1 });
  const L = new Float32Array(2000), R = new Float32Array(2000);
  inst.process(L, R, 0, 2000);
  assert.ok(peak(L) > 0.4 && peak(L) <= 0.5);
  const fx = createEffect('test-pack.gain', SR, { sr: SR });
  fx.setParam('level', 0.5); fx.process(L, R, 2000);
  assert.ok(peak(L) < 0.26);
  assert.equal(packOfType('test-pack.sine'), 'test-pack');
  assert.equal(packOfType('subsynth'), null);
  assert.ok(loadedPacks().some((p) => p.id === 'test-pack'));
});

test('pack plugins work everywhere built-in ones do: channels, effect slots, project files, the Patcher and offline rendering', () => {
  registerPack(makePack());
  const p = createProject();
  const ch = createChannel(p, 'test-pack.sine', { mixer: 1 });
  assert.equal(ch.name, 'Test Sine');
  assert.deepEqual(Object.keys(ch.params), ['gain', 'detune']);
  p.channels.push(ch);
  p.patterns[p.currentPattern].notes[ch.id] = [createNote(p, 0, 96, 69, 100)];
  p.mixer.tracks[1].fx[0] = createFxSlot('test-pack.gain');
  const q = normalize(JSON.parse(JSON.stringify(p)));
  assert.equal(q.channels[0].type, 'test-pack.sine');
  assert.equal(q.mixer.tracks[1].fx[0].type, 'test-pack.gain');
  const loud = renderOffline(q, new Map(), { mode: 'pat', tail: 0.2 });
  assert.ok(peak(loud.left) > 0.2, `audible ${peak(loud.left)}`);
  q.mixer.tracks[1].fx[0].params.level = 0.25;
  const quiet = renderOffline(q, new Map(), { mode: 'pat', tail: 0.2 });
  assert.ok(Math.abs(peak(quiet.left) / peak(loud.left) - 0.25) < 0.02, 'the effect of the pack is in the chain');
  // inside the Patcher
  const patch = defaultPatch('instrument');
  const inst = addNode(patch, 'inst', { ref: 'test-pack.sine' });
  assert.ok(inst, 'a pack generator can be a Patcher node');
  assert.ok(addNode(patch, 'fx', { ref: 'test-pack.gain' }));
  assert.equal(normalizePatch(JSON.parse(JSON.stringify(patch))).nodes.filter((n) => n.ref && n.ref.startsWith('test-pack.')).length, 2);
});

test('packs whose plugins are missing are reported, grouped by pack, and the project still loads', () => {
  const p = createProject();
  const raw = JSON.parse(JSON.stringify(p));
  raw.channels = [{ id: 1, type: 'ghost-pack.lead', name: 'x', params: {} }, { id: 2, type: 'subsynth', name: 'ok', params: {} }];
  raw.mixer.tracks[2].fx[0] = { type: 'ghost-pack.verb', params: {} };
  raw.mixer.tracks[2].fx[1] = { type: 'other.thing', params: {} };
  const m = missingPlugins(raw);
  assert.deepEqual([...m.get('ghost-pack')].sort(), ['ghost-pack.lead', 'ghost-pack.verb']);
  assert.deepEqual([...m.get('other')], ['other.thing']);
  takeMissing();
  const q = normalize(raw);
  assert.equal(q.channels.length, 1, 'the unknown generator is dropped instead of crashing the loader');
  assert.equal(q.mixer.tracks[2].fx[0], null);
  const rep = takeMissing();
  assert.deepEqual(rep.map((r) => r.pack).sort(), ['ghost-pack', 'other']);
  assert.deepEqual(takeMissing(), [], 'reported once');
});

test('invalid packs are rejected with a readable reason and nothing gets registered', () => {
  const bad = (over, re) => {
    assert.throws(() => registerPack(makePack(over)), re);
    assert.equal(hasInstrument('bad-pack.sine'), false);
  };
  bad({ id: 'Bad Pack!' }, /id must be/);
  bad({ id: 'bad-pack', name: '' }, /name is missing/);
  bad({ id: 'bad-pack', version: 'one' }, /version/);
  bad({ id: 'bad-pack', api: 99 }, /plugin API 99/);
  bad({ id: 'bad-pack', plugins: 'nope' }, /must be a function/);
  bad({ id: 'bad-pack', plugins: () => ({}) }, /no plugins/);
  bad({ id: 'bad-pack', plugins: () => { throw new Error('boom'); } }, /plugins\(\) threw: boom/);
  const withPlugin = (mod, kind = 'instruments') => ({ id: 'bad-pack', plugins: (api) => ({ [kind]: { sine: mod(api) } }) });
  const okSchema = (api) => [api.params.def('a', 'A', 0, 1, 0.5)];
  bad(withPlugin((api) => ({ schema: okSchema(api), meta: { name: 'x' } })), /create\(sr, host\) is missing/);
  bad(withPlugin((api) => ({ schema: [], meta: { name: 'x' }, create: () => ({}) })), /non-empty array/);
  bad(withPlugin((api) => ({ schema: [{ ...api.params.def('a', 'A', 0, 1, 0.5), def: 5 }], meta: { name: 'x' }, create: () => ({}) })), /invalid range or default/);
  bad(withPlugin((api) => ({ schema: [api.params.def('a:b', 'A', 0, 1, 0.5)], meta: { name: 'x' }, create: () => ({}) })), /bad parameter id/);
  bad(withPlugin((api) => ({ schema: [api.params.def('a', 'A', 0, 1, 0.5), api.params.def('a', 'B', 0, 1, 0.5)], meta: { name: 'x' }, create: () => ({}) })), /duplicate parameter/);
  bad(withPlugin((api) => ({ schema: okSchema(api), meta: { name: 'x' }, create: () => ({ setParam() {}, noteOn() {}, noteOff() {}, allOff() {}, process(L) { L[0] = NaN; } }) })), /NaN or runaway/);
  bad(withPlugin((api) => ({ schema: okSchema(api), meta: { name: 'x' }, create: () => ({ setParam() {}, noteOn() {}, noteOff() {}, allOff() {}, process(L, R, a, b) { for (let i = a; i < b; i++) L[i] = 100; } }) })), /NaN or runaway/);
  bad(withPlugin((api) => ({ schema: okSchema(api), meta: { name: 'x' }, create: () => ({ setParam() {} }) })), /no noteOn/);
  bad(withPlugin((api) => ({ schema: okSchema(api), meta: { name: 'x' }, create: () => { throw new Error('nope'); } }), 'effects'), /self-test|nope/);
  bad(withPlugin((api) => ({ schema: okSchema(api), meta: { name: 'x' }, create: () => ({ setParam() {}, process(L) { L[0] = Infinity; } }) }), 'effects'), /NaN or runaway/);
  bad(withPlugin((api) => ({ schema: okSchema(api), meta: { name: 'x' }, create: () => ({ setParam() {}, process() {}, latency: -4 }) }), 'effects'), /latency/);
  // a parameter extreme that breaks the plugin is caught too (the self-test sets every parameter to its minimum and maximum)
  bad(withPlugin((api) => ({ schema: [api.params.def('a', 'A', 0, 1, 0.5)], meta: { name: 'x' }, create: () => { let a = 0.5; return { setParam(id, v) { a = v; }, process(L, R, n) { for (let i = 0; i < n; i++) L[i] = a === 1 ? NaN : 0; } }; } }), 'effects'), /NaN or runaway/);
});

test('updating a pack (same id, new version) replaces the plugins; unregister removes them from the registries', () => {
  registerPack(makePack({ version: '1.0.0' }));
  const v2 = makePack({ version: '1.1.0' });
  const info = registerPack(v2);
  assert.equal(info.version, '1.1.0');
  assert.equal(loadedPacks().filter((p) => p.id === 'test-pack').length, 1);
  assert.ok(unregisterPack('test-pack'));
  assert.equal(hasInstrument('test-pack.sine'), false);
  assert.equal(hasEffect('test-pack.gain'), false);
  assert.equal(INSTRUMENT_PRESETS['test-pack.sine'], undefined);
  assert.equal(unregisterPack('test-pack'), false);
});

test('two packs with the same plugin names do not clash: types are namespaced by the pack id', () => {
  registerPack(makePack());
  const clash = makePack({ id: 'clash-pack', plugins: (api) => makePack().plugins(api) });
  registerPack(clash);                                    // different id -> different namespace: no clash
  assert.ok(hasInstrument('clash-pack.sine') && hasInstrument('test-pack.sine'));
  assert.notEqual(INSTRUMENTS['clash-pack.sine'], INSTRUMENTS['test-pack.sine']);
  unregisterPack('clash-pack'); unregisterPack('test-pack');
});

test('the API handed to packs is frozen and offers the schema helpers, the DSP toolkit and the FFT', () => {
  const api = packApi();
  assert.equal(api.version, 1);
  assert.ok(Object.isFrozen(api) && Object.isFrozen(api.dsp) && Object.isFrozen(api.params));
  for (const k of ['def', 'bool', 'choice', 'defaults', 'schemaMap', 'clampParam']) assert.equal(typeof api.params[k], 'function', k);
  for (const k of ['Biquad', 'SVF', 'OnePole', 'DelayLine', 'Noise', 'LFO', 'ADSR', 'DAHDSR', 'polyBlep', 'hermite', 'mtof', 'fastTanh', 'panGains', 'clamp']) assert.ok(api.dsp[k], k);
  assert.ok(api.fft.getFFT && api.fft.hann);
  const scope = {};
  installPackHook(scope, { smoke: false });
  assert.equal(typeof scope.__flluaRegisterPack, 'function');
  scope.__flluaRegisterPack(makePack({ id: 'hook-pack' }));
  assert.ok(hasInstrument('hook-pack.sine'));
  unregisterPack('hook-pack');
});
