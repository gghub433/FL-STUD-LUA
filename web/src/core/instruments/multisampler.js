// Multisampler: several samples spread over the keyboard (and velocity), like a sampled piano or a drum kit with
// round velocity layers. Zones live in the channel (`ch.zones`):
//   { sample: { id, name }, lo, hi, root, vlo, vhi, gain (dB), tune (cents), pan, loop (0/1), ls, le (0..1) }
// A note plays every zone whose key and velocity ranges contain it, pitched from the zone's root key.
// Shared: amp envelope, velocity sensitivity, low-pass filter with key / velocity tracking, polyphony, glide.
import { def, bool, defaults } from '../schema.js';
import { ADSR, SVF, hermite, clamp, timeCoef } from '../dsp.js';

export const schema = [
  def('attack', 'Attack', 0, 5, 0.002, { unit: 's', curve: 'pow', group: 'Amp' }),
  def('decay', 'Decay', 0.01, 10, 1, { unit: 's', curve: 'pow', group: 'Amp' }),
  def('sustain', 'Sustain', 0, 1, 1, { group: 'Amp' }),
  def('release', 'Release', 0.005, 10, 0.25, { unit: 's', curve: 'pow', group: 'Amp' }),
  def('velSens', 'Velocity → volume', 0, 1, 0.7, { group: 'Amp' }),
  def('gain', 'Gain', -24, 12, 0, { unit: 'dB', group: 'Amp' }),
  def('cutoff', 'Cutoff', 40, 20000, 20000, { unit: 'Hz', curve: 'log', group: 'Filter' }),
  def('res', 'Resonance', 0, 1, 0, { group: 'Filter' }),
  def('velCut', 'Velocity → cutoff', 0, 1, 0, { group: 'Filter' }),
  def('keyTrack', 'Key tracking', 0, 1, 0, { group: 'Filter' }),
  def('tune', 'Tune', -24, 24, 0, { unit: 'st', step: 0.01, group: 'Play' }),
  def('glide', 'Glide (slide notes)', 0, 1, 0.05, { unit: 's', group: 'Play' }),
  def('poly', 'Polyphony', 1, 64, 24, { int: true, group: 'Play' }),
  bool('ignoreOff', 'One-shot (ignore note off)', 0, { group: 'Play' }),
];
export const meta = { id: 'multi', name: 'Multisampler', kind: 'sampler', rootDefault: 60, description: 'Many samples over the keyboard and velocity: key zones, root keys, loops' };

export function defaultZone(sample, opts = {}) {
  return { sample: sample ? { id: sample.id, name: sample.name } : null, lo: 0, hi: 127, root: 60, vlo: 1, vhi: 127, gain: 0, tune: 0, pan: 0, loop: 0, ls: 0, le: 1, ...opts };
}

// spread zones between their root keys: each zone reaches halfway to its neighbours
export function autoRanges(zones) {
  const z = zones.slice().sort((a, b) => a.root - b.root);
  z.forEach((x, i) => {
    x.lo = i === 0 ? 0 : Math.floor((z[i - 1].root + x.root) / 2) + 1;
    x.hi = i === z.length - 1 ? 127 : Math.floor((x.root + z[i + 1].root) / 2);
  });
  return z;
}

class Voice { constructor() { this.alive = false; this.env = new ADSR(); this.f = new SVF(); this.f2 = new SVF(); } }

export class Multisampler {
  constructor(sr, host) {
    this.sr = sr; this.host = host;
    this.p = defaults(schema);
    this.zones = [];
    this.voices = Array.from({ length: 64 }, () => new Voice());
    this.counter = 0;
    this.last = null;
  }

  get active() { for (const v of this.voices) if (v.alive) return true; return false; }
  setParam(id, v) { this.p[id] = v; }
  setData(ch) { this.zones = Array.isArray(ch.zones) ? ch.zones.filter((z) => z && z.sample) : []; }
  allOff() { for (const v of this.voices) v.alive = false; }
  chokeAll() { for (const v of this.voices) if (v.alive) v.env.release(); }

  noteOn(ev) {
    const p = this.p, vel127 = Math.max(1, Math.round(clamp(ev.vel ?? 0.8, 0, 1) * 127));
    const hit = this.zones.filter((z) => ev.key >= z.lo && ev.key <= z.hi && vel127 >= (z.vlo || 1) && vel127 <= (z.vhi || 127));
    if (!hit.length) return;
    // polyphony: the oldest voices make room
    const alive = this.voices.filter((v) => v.alive).sort((a, b) => a.time - b.time);
    const excess = alive.length + hit.length - p.poly;
    for (let i = 0; i < excess && i < alive.length; i++) alive[i].env.release();
    const velAmp = 1 - p.velSens + p.velSens * Math.pow(vel127 / 127, 1.6);
    for (const z of hit) {
      const smp = this.host.getSample(z.sample.id);
      if (!smp) continue;
      let v = this.voices.find((x) => !x.alive);
      if (!v) v = this.voices.reduce((a, b) => (a.time < b.time ? a : b));
      const semis = ev.key - z.root + p.tune + (z.tune || 0) / 100 + (ev.fine || 0) / 100;
      v.alive = true; v.time = ++this.counter; v.key = ev.key; v.held = true;
      v.l = smp.ch[0]; v.r = smp.ch[1] || smp.ch[0]; v.len = smp.length;
      v.rate = (smp.rate / this.sr) * Math.pow(2, semis / 12);
      v.target = v.rate;
      if (ev.slide && this.last && this.last.alive && p.glide > 0) { v.rate = this.last.rate * (v.target / this.last.target || 1); }
      v.pos = 0;
      v.loop = !!z.loop && smp.length > 32;
      v.le = Math.min(smp.length - 2, Math.max(16, Math.floor(clamp(z.le ?? 1, 0, 1) * smp.length)));
      v.ls = Math.min(v.le - 16, Math.floor(clamp(z.ls ?? 0, 0, 1) * smp.length));
      const pan = clamp((z.pan || 0) + (ev.pan || 0), -1, 1), a = (pan + 1) * 0.7853981634;
      const g = velAmp * Math.pow(10, ((z.gain || 0) + p.gain) / 20);
      v.gl = Math.cos(a) * 1.41421356 * g; v.gr = Math.sin(a) * 1.41421356 * g;
      const cut = clamp(p.cutoff * Math.pow(2, (p.keyTrack * (ev.key - 60)) / 12) * Math.pow(2, -p.velCut * 4 * (1 - vel127 / 127)), 30, this.sr * 0.45);
      v.cut = cut; v.filt = cut < 19000 || p.res > 0;
      if (v.filt) { v.f.reset(); v.f2.reset(); v.f.setup(this.sr, cut, p.res); v.f2.setup(this.sr, cut, p.res); }
      v.env.v = 0; v.env.trigger();
      this.last = v;
    }
  }

  noteOff(key) {
    if (this.p.ignoreOff) return;
    for (const v of this.voices) if (v.alive && v.held && v.key === key) { v.held = false; v.env.release(); }
  }

  process(L, R, a, b) {
    const p = this.p, sr = this.sr;
    const aInc = p.attack > 0 ? 1 / (p.attack * sr) : 1, dCo = timeCoef(p.decay, sr), rCo = timeCoef(p.release, sr);
    const gCo = p.glide > 0 ? Math.exp(-1 / (p.glide * 0.25 * sr)) : 0;
    for (const v of this.voices) {
      if (!v.alive) continue;
      const { l, r, len } = v;
      for (let i = a; i < b; i++) {
        if (v.rate !== v.target) v.rate = v.target + (v.rate - v.target) * gCo;
        let pos = v.pos;
        if (v.loop && pos >= v.le) { pos = v.ls + ((pos - v.ls) % (v.le - v.ls)); v.pos = pos; }
        if (pos >= len - 1) { v.alive = false; break; }
        const e = v.env.next(aInc, dCo, p.sustain, rCo);
        if (v.env.done) { v.alive = false; break; }
        let xl = hermite(l, pos, len), xr = l === r ? xl : hermite(r, pos, len);
        if (v.filt) { xl = v.f.process(xl); if (l !== r) xr = v.f2.process(xr); else xr = xl; }
        L[i] += xl * v.gl * e; R[i] += xr * v.gr * e;
        v.pos = pos + v.rate;
      }
    }
  }
}

export function create(sr, host) { return new Multisampler(sr, host); }
