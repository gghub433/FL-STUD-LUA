// Pure note-editing tools for the piano roll. Every tool takes an array of notes (the selection) and
// returns the notes that should replace it: tools may change notes in place, drop some or create new
// ones (ids come from `newId`). The caller swaps the result into the pattern in one undo step.
//
// Note fields: id, s (start tick), l (length), k (key 0..120), v (velocity 1..127) and the optional
// pan, rel, fine, mx, my, c (colour), slide, mute (see project.js NOTE_DEFAULT).
import { PPQ, STEP, KEY_MAX } from './constants.js';
import { SCALE_BY_ID, snapToScale, scaleStep, inScale } from './scales.js';

const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const keyOk = (k) => clamp(Math.round(k), 0, KEY_MAX);

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const bounds = (notes) => {
  let s = Infinity, e = -Infinity, lo = Infinity, hi = -Infinity;
  for (const n of notes) { s = Math.min(s, n.s); e = Math.max(e, n.s + n.l); lo = Math.min(lo, n.k); hi = Math.max(hi, n.k); }
  return notes.length ? { s, e, lo, hi } : null;
};

const byTime = (a, b) => a.s - b.s || a.k - b.k;
const copy = (n, newId, patch = {}) => ({ ...n, id: newId(), ...patch });

// ------------------------------------------------------------------------------ basic edits
export function transpose(notes, semis, { scale = null, root = 0 } = {}) {
  for (const n of notes) {
    if (scale && scale !== 'chromatic') n.k = keyOk(scaleStep(n.k, semis, root, scale));
    else n.k = keyOk(n.k + semis);
  }
  return notes;
}

export function shift(notes, ticks, { min = 0 } = {}) {
  const b = bounds(notes);
  if (!b) return notes;
  const d = Math.max(ticks, min - b.s);
  for (const n of notes) n.s += d;
  return notes;
}

export function scaleLengths(notes, factor, { anchor = null } = {}) {
  const b = bounds(notes);
  if (!b) return notes;
  const a = anchor ?? b.s;
  for (const n of notes) { n.s = Math.round(a + (n.s - a) * factor); n.l = Math.max(1, Math.round(n.l * factor)); }
  return notes;
}

export function duplicate(notes, offset, newId) {
  return notes.concat(notes.map((n) => copy(n, newId, { s: n.s + offset })));
}

export function fitToScale(notes, root, scaleId) {
  for (const n of notes) n.k = keyOk(snapToScale(n.k, root, scaleId));
  return notes;
}

// ------------------------------------------------------------------------------ quantize
// grid in ticks, strength 0..1 (how far notes move toward the grid), optionally the note ends too.
export function quantize(notes, { grid = STEP, strength = 1, ends = false, swing = 0 } = {}) {
  for (const n of notes) {
    const idx = Math.round(n.s / grid);
    // swing delays every second grid position by up to 1/3 of the grid
    const target = idx * grid + (idx % 2 ? swing * grid * 0.5 : 0);
    const end = n.s + n.l;
    n.s = Math.max(0, Math.round(n.s + (target - n.s) * strength));
    if (ends) {
      const e2 = Math.round(end / grid) * grid;
      const ne = Math.round(end + (e2 - end) * strength);
      n.l = Math.max(1, ne - n.s);
    }
  }
  return notes;
}

// ------------------------------------------------------------------------------ chop / glue
// Split every note into `parts` equal pieces; `gate` is the share of each piece that sounds.
export function chop(notes, { parts = 2, gate = 1 } = {}, newId) {
  const out = [];
  const p = Math.max(1, Math.floor(parts));
  for (const n of notes) {
    if (p === 1) { out.push(n); continue; }
    const piece = n.l / p;
    for (let i = 0; i < p; i++) {
      const s = Math.round(n.s + piece * i), e = Math.round(n.s + piece * (i + 1));
      const len = Math.max(1, Math.round((e - s) * clamp(gate, 0.05, 1)));
      if (i === 0) { n.s = s; n.l = len; out.push(n); } else out.push(copy(n, newId, { s, l: len, slide: 0 }));
    }
  }
  return out.sort(byTime);
}

// Merge touching/overlapping notes of the same key into single longer notes.
export function glue(notes, { maxGap = 0 } = {}) {
  const lanes = new Map();
  for (const n of notes) { if (!lanes.has(n.k)) lanes.set(n.k, []); lanes.get(n.k).push(n); }
  const out = [];
  for (const list of lanes.values()) {
    list.sort(byTime);
    let cur = null;
    for (const n of list) {
      if (cur && n.s <= cur.s + cur.l + maxGap) cur.l = Math.max(cur.l, n.s + n.l - cur.s);
      else { if (cur) out.push(cur); cur = n; }
    }
    if (cur) out.push(cur);
  }
  return out.sort(byTime);
}

// ------------------------------------------------------------------------------ flip / limit / randomize
export function flip(notes, axis = 'h') {
  const b = bounds(notes);
  if (!b) return notes;
  if (axis === 'h') for (const n of notes) n.s = b.s + (b.e - (n.s + n.l));
  else for (const n of notes) n.k = keyOk(b.lo + b.hi - n.k);
  return notes;
}

export function limit(notes, o = {}) {
  const { s = -Infinity, e = Infinity, kmin = 0, kmax = KEY_MAX, minLen = 1, maxLen = Infinity, vmin = 1, vmax = 127 } = o;
  const out = [];
  for (const n of notes) {
    n.k = clamp(n.k, kmin, kmax);
    n.v = clamp(n.v, vmin, vmax);
    n.l = clamp(n.l, minLen, maxLen);
    if (n.s < s) { n.l -= s - n.s; n.s = s; }
    if (n.s + n.l > e) n.l = e - n.s;
    if (n.l >= 1) out.push(n);
  }
  return out;
}

// amounts are 0..1; timing/length in ticks via `maxShift` / `lengthVar` (fractions of the note length)
export function randomize(notes, o = {}) {
  const { seed = 1, velocity = 0, pitch = 0, timing = 0, length = 0, pan = 0, release = 0, fine = 0, scale = null, root = 0, grid = STEP } = o;
  const rnd = mulberry32(seed);
  const bip = () => rnd() * 2 - 1;
  for (const n of notes) {
    if (velocity) n.v = clamp(Math.round(n.v + bip() * velocity * 63), 1, 127);
    if (pitch) {
      let k = n.k + Math.round(bip() * pitch * 12);
      if (scale && scale !== 'chromatic') k = snapToScale(k, root, scale);
      n.k = keyOk(k);
    }
    if (timing) n.s = Math.max(0, Math.round(n.s + bip() * timing * grid));
    if (length) n.l = Math.max(1, Math.round(n.l * (1 + bip() * length)));
    if (pan) { const v = clamp(Math.round((n.pan || 0) + bip() * pan * 64), -64, 64); if (v) n.pan = v; else delete n.pan; }
    if (release) { const v = clamp(Math.round((n.rel ?? 64) + bip() * release * 64), 0, 127); if (v === 64) delete n.rel; else n.rel = v; }
    if (fine) { const v = clamp(Math.round((n.fine || 0) + bip() * fine * 100), -120, 120); if (v) n.fine = v; else delete n.fine; }
  }
  return notes;
}

// ------------------------------------------------------------------------------ strum / arpeggiator
function chords(notes, tol = 2) {
  const sorted = notes.slice().sort(byTime);
  const groups = [];
  for (const n of sorted) {
    const g = groups[groups.length - 1];
    if (g && Math.abs(n.s - g.s) <= tol) g.notes.push(n); else groups.push({ s: n.s, notes: [n] });
  }
  return groups;
}

// Spread the notes of each chord over time. dir: 'up' (low to high), 'down', 'random'.
export function strum(notes, { ticks = 6, dir = 'up', tension = 0, seed = 1 } = {}) {
  const rnd = mulberry32(seed);
  for (const g of chords(notes)) {
    const ns = g.notes.slice();
    if (ns.length < 2) continue;
    if (dir === 'down') ns.sort((a, b) => b.k - a.k); else if (dir === 'random') ns.sort(() => rnd() - 0.5); else ns.sort((a, b) => a.k - b.k);
    const end = Math.max(...ns.map((n) => n.s + n.l));
    ns.forEach((n, i) => {
      // tension > 0 bunches the late notes together, < 0 spreads them out
      const f = ns.length > 1 ? i / (ns.length - 1) : 0;
      const w = tension >= 0 ? Math.pow(f, 1 + tension) : 1 - Math.pow(1 - f, 1 - tension);
      const off = Math.round(w * ticks * (ns.length - 1));
      n.s = g.s + off;
      n.l = Math.max(1, end - n.s);
    });
  }
  return notes;
}

export const ARP_MODES = ['up', 'down', 'up-down', 'down-up', 'converge', 'diverge', 'random', 'played'];

function arpOrder(keys, mode, rnd) {
  const asc = keys.slice().sort((a, b) => a.k - b.k);
  switch (mode) {
    case 'down': return asc.reverse();
    case 'up-down': return asc.concat(asc.slice(1, -1).reverse());
    case 'down-up': { const d = asc.slice().reverse(); return d.concat(d.slice(1, -1).reverse()); }
    case 'converge': { const o = []; let a = 0, b = asc.length - 1; while (a <= b) { o.push(asc[a++]); if (a <= b) o.push(asc[b--]); } return o; }
    case 'diverge': { const o = []; let a = 0, b = asc.length - 1; while (a <= b) { o.push(asc[a++]); if (a <= b) o.push(asc[b--]); } return o.reverse(); }
    case 'random': return asc.slice().sort(() => rnd() - 0.5);
    case 'played': return keys.slice();
    default: return asc;
  }
}

// Replace each chord by a run of single notes. rate = ticks between notes, gate = share of the rate
// the note sounds, octaves = how many octaves the pattern climbs before wrapping.
export function arpeggiate(notes, { mode = 'up', rate = STEP, gate = 0.9, octaves = 1, seed = 1, velVar = 0 } = {}, newId) {
  const rnd = mulberry32(seed);
  const out = [];
  for (const g of chords(notes)) {
    if (g.notes.length < 2) { out.push(...g.notes); continue; }
    const end = Math.max(...g.notes.map((n) => n.s + n.l));
    let seq = arpOrder(g.notes, mode, rnd);
    if (octaves > 1) {
      const base = seq.slice();
      seq = [];
      for (let o = 0; o < octaves; o++) for (const n of base) seq.push({ ...n, k: n.k + 12 * o });
      if (mode === 'up-down' || mode === 'down-up') seq = seq.concat(seq.slice(1, -1).reverse());
    }
    const proto = g.notes[0];
    let i = 0;
    for (let t = g.s; t < end - 0.5; t += rate, i++) {
      const src = seq[i % seq.length];
      const len = Math.max(1, Math.min(Math.round(rate * clamp(gate, 0.05, 1)), end - t));
      const v = clamp(Math.round(src.v + (velVar ? (rnd() * 2 - 1) * velVar * 40 : 0)), 1, 127);
      const note = { ...src, id: i === 0 ? proto.id : newId() };
      note.s = Math.round(t); note.l = len; note.k = keyOk(src.k); note.v = v;
      out.push(note);
    }
  }
  return out.sort(byTime);
}

// ------------------------------------------------------------------------------ articulator
// Walk the selected notes in time order and apply a repeating pattern of steps:
// { gate: length multiplier, vel: velocity multiplier, slide: 0/1, skip: 0/1 (mute the note) }.
export const ARTICULATIONS = {
  Staccato: [{ gate: 0.35, vel: 1 }],
  Legato: [{ gate: 1.02, vel: 1, slide: 0 }],
  Tenuto: [{ gate: 0.95, vel: 1 }],
  Accents: [{ gate: 0.8, vel: 1.15 }, { gate: 0.8, vel: 0.8 }, { gate: 0.8, vel: 0.9 }, { gate: 0.8, vel: 0.8 }],
  'Off-beat gate': [{ gate: 0.5, vel: 1 }, { gate: 0.5, vel: 0.55, skip: 1 }],
  'Slide chain': [{ gate: 1, vel: 1 }, { gate: 1, vel: 0.9, slide: 1 }],
  Trance: [{ gate: 0.25, vel: 1.1 }, { gate: 0.25, vel: 0.7 }, { gate: 0.5, vel: 0.9 }, { gate: 0.25, vel: 0.7 }],
};

export function articulate(notes, steps) {
  if (!steps || !steps.length) return notes;
  const ordered = notes.slice().sort(byTime);
  ordered.forEach((n, i) => {
    const st = steps[i % steps.length];
    const lenTo = Math.round(n.l * (st.gate ?? 1));
    n.l = Math.max(1, lenTo);
    n.v = clamp(Math.round(n.v * (st.vel ?? 1)), 1, 127);
    if (st.slide !== undefined) n.slide = st.slide ? 1 : 0;
    if (st.skip) n.mute = 1;
  });
  return notes;
}

// Make each note last until the next note starts (no gap, no overlap with the following onset).
export function legato(notes, { maxGap = Infinity } = {}) {
  const o = notes.slice().sort(byTime);
  for (let i = 0; i < o.length - 1; i++) {
    const next = o.slice(i + 1).find((m) => m.s > o[i].s);
    if (next && next.s - (o[i].s + o[i].l) <= maxGap) o[i].l = next.s - o[i].s;
  }
  return notes;
}

// ------------------------------------------------------------------------------ generators
// Claw machine: "grab" pitches/velocities from the selection (or a scale) and drop them onto a rhythm.
// Returns brand new notes covering [start, start + steps * grid).
export function clawMachine(pool, { seed = 1, steps = 16, grid = STEP, density = 0.55, start = 0, gate = 0.8, root = 0, scale = 'minor', baseKey = 60, accent = true } = {}, newId) {
  const rnd = mulberry32(seed);
  const keys = pool.length ? [...new Set(pool.map((n) => n.k))] : (SCALE_BY_ID.get(scale) || SCALE_BY_ID.get('minor')).iv.map((i) => baseKey + root + i);
  const vels = pool.length ? pool.map((n) => n.v) : [100];
  const out = [];
  let prev = -1;
  for (let i = 0; i < steps; i++) {
    // downbeats are more likely to be hit: it makes the output sound like a pattern, not noise
    const w = i % 4 === 0 ? 1.0 : i % 2 === 0 ? 0.8 : 0.6;
    if (rnd() > density * w + (i === 0 ? 0.4 : 0)) continue;
    let k = keys[Math.floor(rnd() * keys.length)];
    if (k === prev && rnd() < 0.5) k = keys[Math.floor(rnd() * keys.length)];
    prev = k;
    let len = grid, j = 1;
    // a run of rests after the note lets it ring for 1..3 steps
    while (j < 3 && i + j < steps && rnd() < 0.3) j++;
    len = grid * j;
    const v = Math.round(clamp(vels[Math.floor(rnd() * vels.length)] * (accent && i % 4 === 0 ? 1.1 : 0.92), 1, 127));
    out.push({ id: newId(), s: start + i * grid, l: Math.max(1, Math.round(len * gate)), k: keyOk(k), v });
  }
  return out;
}

// Riff machine: a melody built from a short motif that is repeated with variations (A A B A'),
// walking by scale steps, kept inside [lo, hi].
export function riffMachine({ seed = 1, root = 0, scale = 'minor', bars = 2, beatsPerBar = 4, start = 0, grid = STEP, density = 0.7, lo = 55, hi = 79, leap = 0.2, rests = 0.2, vel = 100 } = {}, newId) {
  const rnd = mulberry32(seed);
  const ticksPerBar = beatsPerBar * PPQ;
  const motifSteps = Math.max(2, Math.round((ticksPerBar / 2) / grid));         // half a bar
  const home = snapToScale(Math.round((lo + hi) / 2), root, scale);
  // 1. build the motif: [{step, l (steps), key}]. A motif with fewer than 3 notes is drawn again.
  const buildMotif = () => {
    const m = [];
    let step = 0, pos = home;
    while (step < motifSteps) {
      const l = Math.min([1, 1, 1, 2, 2, 3][Math.floor(rnd() * 6)], motifSteps - step);
      if (rnd() < density) {
        const move = rnd() < leap ? (rnd() < 0.5 ? -1 : 1) * (2 + Math.floor(rnd() * 3)) : [-2, -1, -1, 0, 1, 1, 2][Math.floor(rnd() * 7)];
        pos = clamp(scaleStep(pos, move, root, scale), lo, hi);
        if (!inScale(pos, root, scale)) pos = snapToScale(pos, root, scale);
        m.push({ step, l, key: pos });
      }
      step += l;
      if (rnd() < rests) step += 1;
    }
    return m;
  };
  let motif = buildMotif();
  for (let tries = 0; motif.length < 3 && tries < 12; tries++) motif = buildMotif();
  if (motif.length < 3) {                     // very low density: fall back to a plain walk over the scale
    motif = [];
    let pos = home;
    for (let i = 0; i < motifSteps; i += 2) { motif.push({ step: i, l: 2, key: pos }); pos = clamp(scaleStep(pos, i % 4 ? -1 : 2, root, scale), lo, hi); }
  }
  // 2. lay out the motif with variations
  const out = [];
  const total = Math.round((bars * ticksPerBar) / (motifSteps * grid)) || 1;
  for (let rep = 0; rep < total; rep++) {
    const variant = rep % 4 === 2 ? 'B' : rep % 4 === 3 ? 'A2' : 'A';
    const shiftDeg = variant === 'B' ? (rnd() < 0.5 ? 2 : -2) : 0;
    motif.forEach((m, i) => {
      // variations move by scale degrees but must stay inside [lo, hi]: reflect when a step would leave the range
      const move = (key, deg) => { const up = scaleStep(key, deg, root, scale); return up > hi || up < lo ? scaleStep(key, -deg, root, scale) : up; };
      let k = shiftDeg ? move(m.key, shiftDeg) : m.key;
      if (variant === 'A2' && i === motif.length - 1) k = move(k, rnd() < 0.5 ? 1 : -1);   // turnaround tweak
      const s = start + (rep * motifSteps + m.step) * grid;
      if (s >= start + bars * ticksPerBar) return;
      const v = clamp(Math.round(vel * (m.step % 4 === 0 ? 1 : 0.85) + (rnd() * 2 - 1) * 6), 1, 127);
      out.push({ id: newId(), s, l: Math.max(1, Math.round(m.l * grid * 0.92)), k: keyOk(clamp(k, lo, hi)), v });
    });
  }
  return out.sort(byTime);
}

// Place the chord `keys` (absolute keys) at tick `s` with length `l`.
export function stampChord(keys, s, l, v, newId, extra = {}) {
  return keys.map((k) => ({ id: newId(), s, l, k: keyOk(k), v, ...extra }));
}

// Slide-note helper: a note flagged `slide` glides the sounding voice to its key instead of retriggering.
export function toggleSlide(notes, on) {
  for (const n of notes) n.slide = on ? 1 : 0;
  return notes;
}

