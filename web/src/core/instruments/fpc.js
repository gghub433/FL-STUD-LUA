// FPC: drum sampler with 4 banks x 16 pads. Each pad has up to 4 layers (all sound together),
// its own volume / pan / pitch / MIDI note, choke group, mute and solo. Pad data lives in the
// channel (`ch.pads`, `ch.padBank`); this module only plays it.
import { def, bool, defaults, schemaMap } from '../schema.js';
import { hermite, clamp } from '../dsp.js';

export const PADS = 64;
export const BANKS = ['A', 'B', 'C', 'D'];
export const MAX_LAYERS = 4;

export const schema = [
  def('gain', 'Master gain', 0, 1.5, 1, { group: 'Main' }),
  bool('velToVol', 'Velocity affects volume', 1, { group: 'Main' }),
  def('velCurve', 'Velocity curve', 0.3, 3, 1, { curve: 'log', group: 'Main' }),
];

export const meta = { id: 'fpc', name: 'FPC', kind: 'drums', rootDefault: 60, description: 'Drum sampler: 4 banks x 16 pads, layers, choke groups' };
export const paramMap = schemaMap(schema);

// default MIDI note of a pad: bank A starts at C5 (60) so step-sequenced notes at C5 hit pad 1
export const defaultNote = (i) => [60, 76, 92, 24][Math.floor(i / 16)] + (i % 16);

export function defaultPads() {
  return Array.from({ length: PADS }, (_, i) => ({ name: '', layers: [], vol: 1, pan: 0, pitch: 0, note: defaultNote(i), mute: 0, solo: 0, choke: 0, gate: 0 }));
}

class V { constructor() { this.alive = false; } }

export class FPC {
  constructor(sr, host) {
    this.sr = sr; this.host = host;
    this.p = defaults(schema);
    this.pads = defaultPads();
    this.byNote = new Map();
    this.voices = Array.from({ length: 48 }, () => new V());
    this.counter = 0;
    this.anySolo = false;
  }

  get active() { for (const v of this.voices) if (v.alive) return true; return false; }
  setParam(id, v) { this.p[id] = v; }

  setData(ch) {
    this.pads = Array.isArray(ch.pads) ? ch.pads : defaultPads();
    this.byNote.clear();
    this.anySolo = false;
    this.pads.forEach((pad, i) => {
      if (pad.solo) this.anySolo = true;
      let list = this.byNote.get(pad.note);
      if (!list) { list = []; this.byNote.set(pad.note, list); }
      list.push(i);
    });
  }

  allOff() { for (const v of this.voices) v.alive = false; }
  chokeAll() { for (const v of this.voices) if (v.alive) v.kill = 1; }

  noteOn(ev) {
    const pads = this.byNote.get(ev.key);
    if (!pads) return;
    const p = this.p;
    for (const idx of pads) {
      const pad = this.pads[idx];
      if (!pad || pad.mute || (this.anySolo && !pad.solo)) continue;
      // choke: same group (or same pad retrigger) fades out older voices
      for (const v of this.voices) {
        if (!v.alive || v.kill) continue;
        if ((pad.choke > 0 && v.choke === pad.choke) || v.pad === idx) v.kill = 1;
      }
      const velAmp = p.velToVol ? Math.pow(clamp(ev.vel, 0, 1), p.velCurve) : 1;
      for (const layer of pad.layers || []) {
        if (!layer || !layer.sample) continue;
        const smp = this.host.getSample(layer.sample.id);
        if (!smp) continue;
        let v = this.voices.find((x) => !x.alive);
        if (!v) { v = this.voices.reduce((a, b) => (a.time < b.time ? a : b)); }
        v.alive = true; v.kill = 0; v.time = ++this.counter; v.pad = idx; v.choke = pad.choke;
        v.l = smp.ch[0]; v.r = smp.ch[1] || smp.ch[0]; v.len = smp.length;
        v.pos = Math.max(0, Math.floor((layer.start || 0) * smp.length));
        v.inc = (smp.rate / this.sr) * Math.pow(2, ((pad.pitch || 0) + (layer.pitch || 0) + (ev.fine || 0) / 100) / 12);
        const pan = clamp((pad.pan || 0) + (layer.pan || 0) + (ev.pan || 0), -1, 1);
        const a = (pan + 1) * 0.7853981634;
        const g = velAmp * (pad.vol ?? 1) * (layer.vol ?? 1) * p.gain;
        v.gl = Math.cos(a) * 1.41421356 * g; v.gr = Math.sin(a) * 1.41421356 * g;
        v.gate = !!pad.gate; v.held = true; v.fade = 1; v.fadeIn = 24;
        v.noteKey = ev.key;
      }
    }
  }

  noteOff(key) {
    for (const v of this.voices) if (v.alive && v.gate && v.noteKey === key && v.held) { v.held = false; v.kill = 1; }
  }

  process(L, R, i0, i1) {
    const killStep = 1 / (0.006 * this.sr);
    for (const v of this.voices) {
      if (!v.alive) continue;
      const l = v.l, r = v.r, len = v.len, mono = l === r;
      for (let i = i0; i < i1; i++) {
        if (v.pos >= len) { v.alive = false; break; }
        let g = 1;
        if (v.fadeIn > 0) { g *= 1 - v.fadeIn / 25; v.fadeIn--; }
        if (v.kill) { v.kill -= killStep; if (v.kill <= 0) { v.alive = false; break; } g *= v.kill; }
        const a = hermite(l, v.pos, len), b = mono ? a : hermite(r, v.pos, len);
        L[i] += a * v.gl * g; R[i] += b * v.gr * g;
        v.pos += v.inc;
      }
    }
  }
}

export function create(sr, host) { return new FPC(sr, host); }
