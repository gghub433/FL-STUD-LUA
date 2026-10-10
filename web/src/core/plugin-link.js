// The engine's side of native plugins (VST3 / CLAP in the desktop app's plugin host, see desktop/native/).
// Each block that has linked plugins gets a number (seq) and a frame in the shared ring (plugin-layout.js):
//   instrument  its notes and parameter changes go into its slot of frame seq; what it plays comes back
//               K blocks later (the host works in parallel), read from frame seq - K
//   effect      the track's signal goes into its slot of frame seq; the result comes back K blocks later
// K (latencyBlocks) blocks plus the plugin's own latency are reported to the mixer's delay compensation.
// Live, a block that is not back in time plays silence (an xrun); an export waits for every block.
// host.plug = { v: typed views, K, links: Map(owner -> { slot, latency }), seq, ... }
import { BLOCK, PPQ } from './constants.js';
import * as L from './plugin-layout.js';

export const DEFAULT_K = 3;

export function plugState(host) {
  return host.plug || (host.plug = { v: null, K: DEFAULT_K, links: new Map(), seq: 0, firstSeq: 0, inBlock: false, blockFrame: 0, frames: BLOCK, paused: false, offline: false, sleeper: null });
}

export function attach(host, sab, K = DEFAULT_K, offline = false) {
  const pl = plugState(host);
  pl.v = sab ? L.views(sab) : null;
  pl.K = Math.max(1, Math.min(L.RING - 2, K | 0 || DEFAULT_K));
  pl.offline = offline;
  pl.firstSeq = 0;
  if (offline) { try { pl.sleeper = new Int32Array(new SharedArrayBuffer(4)); } catch (_) { pl.sleeper = null; } }
}

export function setLink(host, owner, link) {
  const pl = plugState(host);
  if (link) pl.links.set(owner, { slot: link.slot | 0, latency: Math.max(0, link.latency | 0) });
  else pl.links.delete(owner);
}

export const linkOf = (host, owner) => (host.plug && owner ? host.plug.links.get(owner) || null : null);
export const running = (pl) => !!(pl && pl.v && pl.seq);
export const latencyOf = (host, link) => (link ? host.plug.K * BLOCK + link.latency : 0);

function sleep(pl) {
  if (pl.sleeper) { try { Atomics.wait(pl.sleeper, 0, 0, 0.25); return; } catch (_) { pl.sleeper = null; } }
  // AudioWorklet (offline context): a short busy wait
  const t = Date.now();
  while (Date.now() - t < 1) { /* spin */ }
}

// start of an engine block: takes the next block number and writes the transport into its frame.
// t = { playing, tempo, tick, sampleRate, tsNum, tsDen, barTick, loopS, loopE, samplePos }
export function blockBegin(host, frames, t) {
  const pl = host.plug;
  if (!pl || !pl.v || !pl.links.size || pl.paused || Atomics.load(pl.v.u32, L.H.hostState) === 2) { if (pl) pl.seq = 0; return; }
  const seq = Atomics.add(pl.v.u32, L.H.nextSeq, 1) + 1;
  pl.seq = seq;
  if (!pl.firstSeq) pl.firstSeq = seq;
  pl.inBlock = true;
  pl.blockFrame = host.evFrame || 0;
  pl.frames = frames;
  let flags = t.playing ? L.FLAG.PLAYING : 0;
  if (t.loopE !== undefined && Number.isFinite(t.loopE)) flags |= L.FLAG.LOOP;
  if (pl.offline) flags |= L.FLAG.OFFLINE;
  L.writeFrame(pl.v, seq, frames, t.sampleRate, {
    flags, tempo: t.tempo, ppq: Math.max(0, t.tick) / PPQ, samplePos: t.samplePos || 0, barPpq: Math.max(0, t.barTick || 0) / PPQ,
    tsNum: t.tsNum, tsDen: t.tsDen, loopStart: Number.isFinite(t.loopS) ? t.loopS / PPQ : 0, loopEnd: Number.isFinite(t.loopE) ? t.loopE / PPQ : 0,
  });
  // an export waits until the block it reads from (seq - K) is back
  if (pl.offline) {
    const need = seq - pl.K;
    if (need >= pl.firstSeq) {
      const t0 = Date.now();
      while (((Atomics.load(pl.v.u32, L.H.doneSeq) - need) | 0) < 0) {
        if (Date.now() - t0 > 5000 || Atomics.load(pl.v.u32, L.H.hostState) === 2) { Atomics.store(pl.v.u32, L.H.hostState, 2); break; }
        sleep(pl);
      }
    }
  }
}

// end of the block: the frame is complete, the bridge may take it
export function blockEnd(host) {
  const pl = host.plug;
  if (!pl) return;
  pl.inBlock = false;
  if (pl.seq && pl.v) Atomics.store(pl.v.u32, L.H.reqSeq, pl.seq);
}

// The part both plugin instruments and plugin effects share: their slot, the events they queue, the audio they get back.
export class PluginPort {
  constructor(host) {
    this.host = host;
    this.owner = null;
    this.touched = 0;            // block whose slot this instance has started
    this.first = 0;              // first block it used (its output exists from first + K on)
    this.pending = [];           // events that arrived between blocks: they go out at the start of the next one
    this.known = new Map();      // parameter values the plugin has (as far as FL LUA knows)
  }
  get link() { return linkOf(this.host, this.owner); }
  get live() { const pl = this.host.plug; return !!(pl && pl.seq && this.link); }

  // the slot of the current block, started on first use
  slot() {
    const pl = this.host.plug, l = this.link;
    if (!pl || !pl.seq || !l) return -1;
    if (this.touched !== pl.seq) {
      this.touched = pl.seq;
      if (!this.first || this.first < pl.firstSeq) this.first = pl.seq;
      L.beginSlot(pl.v, pl.seq, l.slot);
      if (pl.offline && this.first === pl.seq) L.addEvent(pl.v, pl.seq, l.slot, 0, L.EV.ALL_OFF, 0, 0, -1, 0, 0);    // an export starts from silence
      for (const e of this.pending.splice(0)) L.addEvent(pl.v, pl.seq, l.slot, 0, e[0], e[1], e[2], e[3], e[4], e[5]);
    }
    return l.slot;
  }

  event(type, channel, key, noteId, param, value) {
    const pl = this.host.plug;
    if (!pl || !pl.inBlock || !pl.seq || !this.link) {
      if (this.pending.length < 512 && this.owner) this.pending.push([type, channel, key, noteId, param, value]);
      return;
    }
    const s = this.slot();
    const off = Math.max(0, Math.min(pl.frames - 1, (this.host.evFrame || 0) - pl.blockFrame));
    L.addEvent(pl.v, pl.seq, s, off, type, channel, key, noteId, param, value);
  }

  // a parameter value from FL LUA (knob, automation, undo). The first value seen for a parameter is what the plugin
  // already has (its saved state); only changes go out.
  param(key, v, initial = false) {
    const id = Number(key);
    if (!Number.isInteger(id) || id < 0 || typeof v !== 'number') return;
    const had = this.known.has(key);
    if (had && this.known.get(key) === v) return;
    this.known.set(key, v);
    if (!had && initial) return;
    this.event(L.EV.PARAM, 0, 0, -1, id, Math.max(0, Math.min(1, v)));
  }

  // adds what the plugin returned for block seq - K into L/R (frames a..b); false when nothing came back
  readOut(Lb, Rb, a, b, replace = false) {
    const pl = this.host.plug, l = this.link;
    if (!pl || !pl.seq || !l) return false;
    const src = pl.seq - pl.K;
    if (src < 1 || L.outSeqOf(pl.v, src, l.slot) !== src) {
      if (this.first && src >= this.first) Atomics.add(pl.v.u32, L.H.xruns, 1);     // it was sent but is not back in time
      if (replace) { Lb.fill(0, a, b); Rb.fill(0, a, b); }
      return false;
    }
    const f = pl.v.f32, ol = L.outIndex(src, l.slot, 0), or = L.outIndex(src, l.slot, 1);
    if (replace) for (let i = a; i < b; i++) { Lb[i] = f[ol + i]; Rb[i] = f[or + i]; }
    else for (let i = a; i < b; i++) { Lb[i] += f[ol + i]; Rb[i] += f[or + i]; }
    return true;
  }

  writeIn(Lb, Rb, n) {
    const pl = this.host.plug, s = this.slot();
    if (s < 0) return;
    const il = L.inIndex(pl.seq, s, 0), ir = L.inIndex(pl.seq, s, 1);
    pl.v.f32.set(Lb.subarray(0, n), il);
    pl.v.f32.set(Rb.subarray(0, n), ir);
  }
}

// which channels and effect slots of a project use native plugins: [{ owner, kind, data }]
export function pluginUses(project) {
  const out = [];
  for (const ch of project.channels) if (ch.type === 'plugin' && ch.plugin && ch.plugin.path) out.push({ owner: `ch:${ch.id}`, kind: 'inst', data: ch.plugin, params: ch.params, name: ch.name });
  project.mixer.tracks.forEach((t, n) => t.fx.forEach((s, i) => {
    const pdata = s && s.type === 'plugin' && s.extra && s.extra.plugin;
    if (pdata && pdata.path && pdata.id) out.push({ owner: `fx:${pdata.id}`, kind: 'fx', data: pdata, params: s.params, name: pdata.name, track: n, slot: i });
  }));
  return out;
}
