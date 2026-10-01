// Project data model: plain JSON, shared by UI (authoritative copy), AudioWorklet (mirror),
// offline renderer and tests. Samples are NOT part of the JSON (they live in the sample bank).
import { PPQ, STEP, MAX_INSERT, FX_SLOTS, MIDDLE_C, KEY_MAX } from './constants.js';
import { defaults, clampParam } from './schema.js';
import { instrumentSchema, hasInstrument, instrumentMeta } from './instruments/index.js';
import { effectSchema, hasEffect } from './effects/index.js';
import { CHANNEL_BUILTIN, TRACK_BUILTIN } from './addr.js';
import { defaultPads, PADS, MAX_LAYERS } from './instruments/fpc.js';

export const FORMAT = 'stepwise';
export const VERSION = 1;

export const COLORS = [
  '#e35d5d', '#e8894a', '#e0b84a', '#a9cf4f', '#5cc46a', '#4cc3a6', '#4aaedc', '#5b86e0',
  '#8a72e0', '#b968d6', '#e062a8', '#c4787a', '#9aa4ad', '#c7b79a', '#7fb0a0', '#d98c6b',
];

export const clone = (o) => JSON.parse(JSON.stringify(o));
export const nextId = (p) => p.seq++;

export function createTrack(n) {
  return {
    name: '', color: null, icon: null,
    vol: 0.8, pan: 0, sep: 0, delay: 0,
    eqLowG: 0, eqLowF: 120, eqMidG: 0, eqMidF: 1200, eqMidQ: 1, eqHighG: 0, eqHighF: 8000,
    mute: 0, solo: 0, arm: 0, input: 0, swapLR: 0, invertPhase: 0,
    routes: n === 0 ? [] : [[0, 1, 0]],          // [destTrack, level, sidechain?1:0]
    fx: new Array(FX_SLOTS).fill(null),          // { type, on, mix, params, preset? }
  };
}

export function createFxSlot(type) {
  const s = effectSchema(type);
  return { type, on: 1, mix: 1, params: s ? defaults(s) : {} };
}

export function createArrangement(id, name = 'Arrangement') {
  return {
    id, name,
    tracks: {},          // sparse overrides: { [n]: {name,color,mute,solo,lock,height,mode} }
    clips: [],           // see createClip
    markers: [],         // { id, t, type: 'marker'|'timesig'|'patlen', name, num, den, len }
    loop: null,          // { s, e } ticks
    start: null,         // start marker in ticks
    punch: null,         // { in, out }
  };
}

export function createProject() {
  const p = {
    format: FORMAT, version: VERSION,
    meta: { title: 'Untitled', author: '', comment: '', created: Date.now() },
    seq: 1,
    tempo: 130, swing: 0, masterPitch: 0,
    timeSig: { num: 4, den: 4 },
    settings: { snap: 'cell', metronome: 0, countIn: 0, overdub: 0, blend: 0, loopRec: 0, stepKey: MIDDLE_C },
    channels: [],
    patterns: {},
    currentPattern: 1,
    playlist: { arrangements: [], current: 1 },
    mixer: { tracks: [], selected: 1 },
    samples: {},         // { id: { name, rate, length, channels } } metadata only
    controllers: [],     // MIDI links: { addr, chan, cc, min, max, invert }
    groups: ['All'],
  };
  for (let n = 0; n <= MAX_INSERT; n++) p.mixer.tracks.push(createTrack(n));
  p.playlist.arrangements.push(createArrangement(nextId(p)));
  p.playlist.current = p.playlist.arrangements[0].id;
  createPattern(p, 1);
  return p;
}

export function createPattern(p, id, name) {
  if (!id) { id = 1; while (p.patterns[id]) id++; }
  p.patterns[id] = { id, name: name || `Pattern ${id}`, color: null, len: null, notes: {} };
  return p.patterns[id];
}

export function barTicks(timeSig) { return Math.round((timeSig.num * PPQ * 4) / timeSig.den); }
export function stepsPerBar(timeSig) { return Math.round(barTicks(timeSig) / STEP); }

// Length of a pattern in ticks: explicit len or content rounded up to whole bars (min 1 bar).
export function patternLength(p, pat) {
  if (pat.len) return pat.len;
  const bar = barTicks(p.timeSig);
  let end = 0;
  for (const id in pat.notes) for (const n of pat.notes[id]) end = Math.max(end, n.s + n.l);
  return Math.max(1, Math.ceil(end / bar)) * bar;
}

export function createChannel(p, type, opts = {}) {
  const ch = {
    id: nextId(p), type, name: opts.name || defaultName(type), color: opts.color ?? COLORS[p.channels.length % COLORS.length],
    enabled: 1, vol: 0.8, pan: 0, pitch: 0, mixer: opts.mixer ?? 0, group: opts.group || '',
    params: {},
  };
  const schema = instrumentSchema(type);
  if (schema) ch.params = defaults(schema);
  if (opts.params) Object.assign(ch.params, opts.params);
  if (type === 'sampler' || type === 'audio') ch.sample = opts.sample || null;
  if (type === 'layer') ch.children = opts.children || [];
  if (type === 'fpc') { ch.pads = opts.pads || defaultPads(); ch.padBank = 0; }
  if (type === 'slicer') { ch.sample = opts.sample || null; ch.slices = opts.slices || []; ch.loopBpm = opts.loopBpm || 0; }
  if (type === 'automation') { ch.target = opts.target || null; ch.points = opts.points || []; ch.len = opts.len || barTicks(p.timeSig); ch.mixer = 0; }
  return ch;
}

function defaultName(type) {
  const m = instrumentMeta(type);
  if (m) return m.name;
  return { audio: 'Audio clip', automation: 'Automation', layer: 'Layer' }[type] || type;
}

export const isInstrumentType = (t) => hasInstrument(t);
export const isSoundChannel = (ch) => ch.type !== 'automation' && ch.type !== 'layer' && ch.type !== 'audio';

export function createNote(p, s, l, k, v = 100) {
  return { id: nextId(p), s, l, k, v };
}

// Optional note fields default when absent (keeps JSON and undo snapshots small).
export const NOTE_DEFAULT = { pan: 0, rel: 64, fine: 0, mx: 128, my: 128, c: 0, slide: 0, mute: 0 };
export const noteProp = (n, k) => (n[k] === undefined ? NOTE_DEFAULT[k] : n[k]);

export function createClip(p, type, track, s, l, ref, extra = {}) {
  return { id: nextId(p), type, track, s, l, ref, o: 0, mute: 0, ...extra };
}

export const currentArrangement = (p) => p.playlist.arrangements.find((a) => a.id === p.playlist.current) || p.playlist.arrangements[0];

export function songLength(p, arr = currentArrangement(p)) {
  let end = 0;
  for (const c of arr.clips) end = Math.max(end, c.s + c.l);
  return end;
}

// ---------------------------------------------------------------------------------------
// Normalization: used when loading files / IndexedDB / zip. Never trusts its input.
// ---------------------------------------------------------------------------------------
const num = (v, lo, hi, d) => (typeof v === 'number' && v === v ? Math.min(hi, Math.max(lo, v)) : d);
const int = (v, lo, hi, d) => Math.round(num(v, lo, hi, d));
const str = (v, d = '', max = 80) => (typeof v === 'string' ? v.slice(0, max) : d);
const bit = (v) => (v ? 1 : 0);
const colorOk = (c) => (typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c) ? c : null);

function normParams(schema, raw) {
  const out = schema ? defaults(schema) : {};
  if (schema && raw && typeof raw === 'object') {
    for (const d of schema) if (raw[d.id] !== undefined) out[d.id] = clampParam(d, raw[d.id]);
  }
  return out;
}

function normNote(n, seq) {
  if (!n || typeof n !== 'object') return null;
  const o = {
    id: int(n.id, 1, 1e9, seq),
    s: int(n.s, 0, 1e8, 0), l: int(n.l, 1, 1e8, STEP), k: int(n.k, 0, KEY_MAX, MIDDLE_C), v: int(n.v, 1, 127, 100),
  };
  if (n.pan) o.pan = int(n.pan, -64, 64, 0);
  if (n.rel !== undefined && n.rel !== 64) o.rel = int(n.rel, 0, 127, 64);
  if (n.fine) o.fine = int(n.fine, -120, 120, 0);
  if (n.mx !== undefined && n.mx !== 128) o.mx = int(n.mx, 0, 255, 128);
  if (n.my !== undefined && n.my !== 128) o.my = int(n.my, 0, 255, 128);
  if (n.c) o.c = int(n.c, 0, 15, 0);
  if (n.slide) o.slide = 1;
  if (n.mute) o.mute = 1;
  return o;
}

export function normalize(raw) {
  if (!raw || typeof raw !== 'object' || raw.format !== FORMAT) throw new Error('Not an FL LUA project');
  if (typeof raw.version === 'number' && raw.version > VERSION) throw new Error('Project was made with a newer version');
  const p = createProject();
  p.meta = {
    title: str(raw.meta?.title, 'Untitled'), author: str(raw.meta?.author), comment: str(raw.meta?.comment, '', 2000),
    created: num(raw.meta?.created, 0, 4e12, Date.now()),
  };
  p.tempo = num(raw.tempo, 10, 522, 130);
  p.swing = num(raw.swing, 0, 1, 0);
  p.masterPitch = num(raw.masterPitch, -12, 12, 0);
  const den = [1, 2, 4, 8, 16, 32].includes(raw.timeSig?.den) ? raw.timeSig.den : 4;
  p.timeSig = { num: int(raw.timeSig?.num, 1, 32, 4), den };
  const st = raw.settings || {};
  p.settings = {
    snap: str(st.snap, 'cell', 20), metronome: bit(st.metronome), countIn: bit(st.countIn), overdub: bit(st.overdub),
    blend: bit(st.blend), loopRec: bit(st.loopRec), stepKey: int(st.stepKey, 0, KEY_MAX, MIDDLE_C),
  };
  p.groups = Array.isArray(raw.groups) ? raw.groups.filter((g) => typeof g === 'string').slice(0, 32) : ['All'];
  if (!p.groups.includes('All')) p.groups.unshift('All');

  let maxId = 0;
  const seenIds = new Set();
  const useId = (v) => {
    let id = int(v, 1, 1e9, 0);
    if (!id || seenIds.has(id)) id = maxId + 1;
    seenIds.add(id); if (id > maxId) maxId = id;
    return id;
  };

  // channels
  p.channels = [];
  for (const c of Array.isArray(raw.channels) ? raw.channels.slice(0, 256) : []) {
    if (!c || typeof c !== 'object' || typeof c.type !== 'string') continue;
    const type = c.type;
    const known = hasInstrument(type) || ['audio', 'automation', 'layer'].includes(type);
    if (!known) continue;
    const ch = {
      id: useId(c.id), type, name: str(c.name, type, 40), color: colorOk(c.color) || COLORS[p.channels.length % COLORS.length],
      enabled: c.enabled === 0 ? 0 : 1, vol: num(c.vol, 0, 1, 0.8), pan: num(c.pan, -1, 1, 0),
      pitch: num(c.pitch, -12, 12, 0), mixer: int(c.mixer, 0, MAX_INSERT, 0), group: str(c.group, '', 40),
      params: normParams(instrumentSchema(type), c.params),
    };
    if (type === 'sampler' || type === 'audio' || type === 'slicer') {
      ch.sample = c.sample && typeof c.sample.id === 'string' ? { id: str(c.sample.id, '', 80), name: str(c.sample.name, '', 80) } : null;
      if (ch.sample && typeof c.sample.use === 'string') ch.sample.use = str(c.sample.use, '', 120);
    }
    if (type === 'slicer') {
      ch.slices = Array.isArray(c.slices) ? c.slices.filter((x) => Number.isFinite(x) && x >= 0).slice(0, 64).map((x) => Math.floor(x)) : [];
      ch.loopBpm = num(c.loopBpm, 0, 999, 0);
    }
    if (type === 'fpc') {
      ch.padBank = int(c.padBank, 0, 3, 0);
      ch.pads = defaultPads();
      if (Array.isArray(c.pads)) {
        for (let i = 0; i < PADS; i++) {
          const pd = c.pads[i];
          if (!pd || typeof pd !== 'object') continue;
          const out = ch.pads[i];
          out.name = str(pd.name, '', 24); out.vol = num(pd.vol, 0, 2, 1); out.pan = num(pd.pan, -1, 1, 0); out.pitch = num(pd.pitch, -48, 48, 0);
          out.note = int(pd.note, 0, 127, out.note); out.mute = bit(pd.mute); out.solo = bit(pd.solo); out.choke = int(pd.choke, 0, 8, 0); out.gate = bit(pd.gate);
          out.layers = [];
          for (const l of Array.isArray(pd.layers) ? pd.layers.slice(0, MAX_LAYERS) : []) {
            if (!l || !l.sample || typeof l.sample.id !== 'string') continue;
            out.layers.push({ sample: { id: str(l.sample.id, '', 80), name: str(l.sample.name, '', 80) }, vol: num(l.vol, 0, 2, 1), pan: num(l.pan, -1, 1, 0), pitch: num(l.pitch, -48, 48, 0), start: num(l.start, 0, 0.99, 0) });
          }
        }
      }
    }
    if (type === 'layer') ch.children = Array.isArray(c.children) ? c.children.filter((x) => Number.isInteger(x)).slice(0, 64) : [];
    if (type === 'automation') {
      ch.target = typeof c.target === 'string' ? c.target.slice(0, 80) : null;
      ch.len = int(c.len, 1, 1e8, barTicks(p.timeSig));
      ch.points = Array.isArray(c.points) ? c.points.slice(0, 4096).map((q) => ({
        t: int(q?.t, 0, 1e8, 0), v: num(q?.v, 0, 1, 0), type: str(q?.type, 'single', 12),
        tension: num(q?.tension, -1, 1, 0), count: int(q?.count, 1, 64, 4),
      })).sort((a, b) => a.t - b.t) : [];
      ch.mixer = 0;
    }
    p.channels.push(ch);
  }
  const chIds = new Set(p.channels.map((c) => c.id));
  for (const c of p.channels) if (c.children) c.children = c.children.filter((id) => chIds.has(id) && id !== c.id);

  // patterns
  p.patterns = {};
  const rp = raw.patterns && typeof raw.patterns === 'object' ? raw.patterns : {};
  for (const key of Object.keys(rp).slice(0, 999)) {
    const id = int(Number(key), 1, 999, 0);
    const src = rp[key];
    if (!id || !src || typeof src !== 'object') continue;
    const pat = { id, name: str(src.name, `Pattern ${id}`, 40), color: colorOk(src.color), len: src.len ? int(src.len, STEP, 1e7, 0) || null : null, notes: {} };
    if (src.notes && typeof src.notes === 'object') {
      for (const cid of Object.keys(src.notes)) {
        if (!chIds.has(+cid) || !Array.isArray(src.notes[cid])) continue;
        const list = [];
        for (const n of src.notes[cid].slice(0, 20000)) {
          const nn = normNote(n, 1); if (nn) { nn.id = useId(nn.id); list.push(nn); }
        }
        list.sort((a, b) => a.s - b.s || a.k - b.k);
        pat.notes[cid] = list;
      }
    }
    p.patterns[id] = pat;
  }
  if (!Object.keys(p.patterns).length) createPattern(p, 1);
  const pids = Object.keys(p.patterns).map(Number).sort((a, b) => a - b);
  p.currentPattern = p.patterns[raw.currentPattern] ? raw.currentPattern : pids[0];

  // mixer
  const rt = Array.isArray(raw.mixer?.tracks) ? raw.mixer.tracks : [];
  for (let n = 0; n <= MAX_INSERT; n++) {
    const t = rt[n];
    const tr = p.mixer.tracks[n];
    if (!t || typeof t !== 'object') continue;
    tr.name = str(t.name, '', 24); tr.color = colorOk(t.color); tr.icon = str(t.icon, '', 24) || null;
    for (const d of TRACK_BUILTIN) tr[d.id] = clampParam(d, t[d.id] ?? d.def);
    tr.mute = bit(t.mute); tr.solo = bit(t.solo); tr.arm = bit(t.arm); tr.input = int(t.input, 0, 64, 0);
    tr.swapLR = bit(t.swapLR); tr.invertPhase = bit(t.invertPhase);
    if (Array.isArray(t.routes)) {
      tr.routes = [];
      for (const r of t.routes.slice(0, 126)) {
        if (!Array.isArray(r)) continue;
        const dest = r[0];
        if (!Number.isInteger(dest) || dest < 0 || dest > MAX_INSERT || dest === n) continue;
        tr.routes.push([dest, num(r[1], 0, 2, 1), bit(r[2])]);
      }
    }
    for (let s = 0; s < FX_SLOTS; s++) {
      const f = Array.isArray(t.fx) ? t.fx[s] : null;
      if (!f || typeof f.type !== 'string' || !hasEffect(f.type)) continue;
      tr.fx[s] = { type: f.type, on: f.on === 0 ? 0 : 1, mix: num(f.mix, 0, 1, 1), params: normParams(effectSchema(f.type), f.params) };
      if (f.extra && typeof f.extra === 'object') tr.fx[s].extra = clone(f.extra); // effect-specific data (IR id, curves)
    }
  }
  breakCycles(p);
  p.mixer.selected = int(raw.mixer?.selected, 0, MAX_INSERT, 1);

  // samples metadata
  p.samples = {};
  if (raw.samples && typeof raw.samples === 'object') {
    for (const id of Object.keys(raw.samples).slice(0, 4096)) {
      const s = raw.samples[id];
      if (!s || typeof s !== 'object') continue;
      p.samples[id.slice(0, 80)] = { name: str(s.name, id, 80), rate: int(s.rate, 8000, 192000, 44100), length: int(s.length, 0, 1e9, 0), channels: int(s.channels, 1, 2, 1) };
    }
  }

  // playlist
  p.playlist = { arrangements: [], current: 1 };
  const arrs = Array.isArray(raw.playlist?.arrangements) ? raw.playlist.arrangements.slice(0, 32) : [];
  for (const a of arrs) {
    if (!a || typeof a !== 'object') continue;
    const arr = createArrangement(useId(a.id), str(a.name, 'Arrangement', 40));
    if (a.tracks && typeof a.tracks === 'object') {
      for (const k of Object.keys(a.tracks).slice(0, 500)) {
        const n = int(Number(k), 1, 500, 0); const t = a.tracks[k];
        if (!n || !t || typeof t !== 'object') continue;
        arr.tracks[n] = { name: str(t.name, '', 24), color: colorOk(t.color), mute: bit(t.mute), solo: bit(t.solo), lock: bit(t.lock), height: int(t.height, 0, 2, 1), mode: t.mode === 'audio' ? 'audio' : 'instrument' };
      }
    }
    for (const c of Array.isArray(a.clips) ? a.clips.slice(0, 50000) : []) {
      if (!c || typeof c !== 'object' || !['pattern', 'audio', 'automation'].includes(c.type)) continue;
      const clip = {
        id: useId(c.id), type: c.type, track: int(c.track, 1, 500, 1), s: int(c.s, 0, 1e8, 0), l: int(c.l, 1, 1e8, 384),
        ref: int(c.ref, 1, 1e9, 0), o: int(c.o, 0, 1e8, 0), mute: bit(c.mute),
      };
      if (c.type === 'pattern' && !p.patterns[clip.ref]) continue;
      if (c.type !== 'pattern' && !chIds.has(clip.ref)) continue;
      if (colorOk(c.color)) clip.color = c.color;
      if (c.name) clip.name = str(c.name, '', 40);
      if (c.fi) clip.fi = int(c.fi, 0, 1e8, 0);
      if (c.fo) clip.fo = int(c.fo, 0, 1e8, 0);
      if (c.rev) clip.rev = 1;
      if (c.gain !== undefined && c.gain !== 0) clip.gain = num(c.gain, -60, 24, 0);
      if (c.pitch) clip.pitch = num(c.pitch, -48, 48, 0);
      if (c.stretch) clip.stretch = num(c.stretch, 0.1, 10, 1);
      if (c.norm) clip.norm = 1;
      if (typeof c.use === 'string' && c.use) clip.use = c.use.slice(0, 200);
      arr.clips.push(clip);
    }
    arr.clips.sort((x, y) => x.s - y.s);
    for (const m of Array.isArray(a.markers) ? a.markers.slice(0, 2000) : []) {
      if (!m || !['marker', 'timesig', 'patlen'].includes(m.type)) continue;
      arr.markers.push({ id: useId(m.id), t: int(m.t, 0, 1e8, 0), type: m.type, name: str(m.name, '', 40), num: int(m.num, 1, 32, 4), den: [1, 2, 4, 8, 16, 32].includes(m.den) ? m.den : 4, len: int(m.len, STEP, 1e7, 384) });
    }
    if (a.loop && Number.isFinite(a.loop.s) && Number.isFinite(a.loop.e) && a.loop.e > a.loop.s) arr.loop = { s: int(a.loop.s, 0, 1e8, 0), e: int(a.loop.e, 1, 1e8, 384) };
    if (Number.isFinite(a.start)) arr.start = int(a.start, 0, 1e8, 0);
    if (a.punch && Number.isFinite(a.punch.in) && Number.isFinite(a.punch.out) && a.punch.out > a.punch.in) arr.punch = { in: int(a.punch.in, 0, 1e8, 0), out: int(a.punch.out, 1, 1e8, 384) };
    p.playlist.arrangements.push(arr);
  }
  if (!p.playlist.arrangements.length) p.playlist.arrangements.push(createArrangement(useId(0)));
  p.playlist.current = p.playlist.arrangements.some((a) => a.id === raw.playlist?.current) ? raw.playlist.current : p.playlist.arrangements[0].id;

  p.controllers = [];
  if (Array.isArray(raw.controllers)) {
    for (const c of raw.controllers.slice(0, 512)) {
      if (!c || typeof c.addr !== 'string') continue;
      p.controllers.push({ addr: c.addr.slice(0, 80), chan: int(c.chan, 0, 16, 0), cc: int(c.cc, 0, 127, 0), min: num(c.min, 0, 1, 0), max: num(c.max, 0, 1, 1), invert: bit(c.invert) });
    }
  }
  p.seq = Math.max(int(raw.seq, 1, 1e9, 1), maxId + 1);
  return p;
}

// Mixer routing must stay acyclic; drop any route that would close a loop.
export function breakCycles(p) {
  const tracks = p.mixer.tracks;
  for (let n = 0; n <= MAX_INSERT; n++) {
    tracks[n].routes = tracks[n].routes.filter(([dest], i, arr) => arr.findIndex((r) => r[0] === dest) === i);
  }
  for (let n = 1; n <= MAX_INSERT; n++) {
    for (let i = tracks[n].routes.length - 1; i >= 0; i--) {
      if (reaches(tracks, tracks[n].routes[i][0], n)) tracks[n].routes.splice(i, 1);
    }
  }
}

// does `from` (transitively) route into `target`?
export function reaches(tracks, from, target, seen = new Set()) {
  if (from === target) return true;
  if (seen.has(from)) return false;
  seen.add(from);
  for (const [dest] of tracks[from].routes) if (reaches(tracks, dest, target, seen)) return true;
  return false;
}
