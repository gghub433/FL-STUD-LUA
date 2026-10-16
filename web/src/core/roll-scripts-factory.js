// Factory piano roll scripts (Tools > Scripts). They are written against the same ctx API as a user script
// (core/roll-scripts.js), so they double as examples; where a piano roll tool already does the work (arpeggiator,
// flip) they call it through ctx.tools instead of repeating it. Generators fill ctx.range: the selection rounded out
// to whole bars, or the whole pattern when nothing is selected.
import { NOTE_NAMES } from './constants.js';
import { SCALES } from './scales.js';
import { normalizeParams } from './roll-scripts.js';

const FROM_ROLL = ['roll', 'From the piano roll'];
const ROOTS = [FROM_ROLL, ...NOTE_NAMES.map((n, i) => [i, n])];
const SCALE_CHOICES = [FROM_ROLL, ...SCALES.filter((s) => s.id !== 'chromatic').map((s) => [s.id, s.name])];
const DIATONIC = [FROM_ROLL, ...SCALES.filter((s) => s.iv.length === 7).map((s) => [s.id, s.name])];
const GRID = [[12, '1/32'], [16, '1/16 triplet'], [24, '1/16'], [32, '1/8 triplet'], [48, '1/8'], [96, '1/4']];
const SEED = { id: 'seed', name: 'Seed', type: 'slider', min: 1, max: 999, value: 1 };
const REPLACE = { id: 'replace', name: 'Replace the notes', type: 'check', value: true };

// root and scale from the parameters, or the piano roll's; `fallback` when that is chromatic (or not a 7-note scale
// where chords need one)
function keyOf(ctx, fallback, sevenOnly = false) {
  const p = ctx.params;
  const root = p.root === undefined || p.root === 'roll' ? ctx.scale.root : p.root;
  let id = p.scale === undefined || p.scale === 'roll' ? ctx.scale.id : p.scale;
  const def = ctx.scales.find((s) => s.id === id);
  if (!def || id === 'chromatic' || (sevenOnly && def.intervals.length !== 7)) id = fallback;
  return { root, id };
}

// moves a key by octaves into 0..120
const fold = (k) => { while (k > 120) k -= 12; while (k < 0) k += 12; return k; };

// n-th inversion of a chord: the lowest note goes up an octave n times (negative: the highest goes down)
function invert(keys, n) {
  const c = keys.slice().sort((a, b) => a - b);
  for (let i = 0; i < n; i++) c.push(c.shift() + 12);
  for (let i = 0; i > n; i--) c.unshift(c.pop() - 12);
  return c;
}

// chord voicings: the stacked chord as it comes, every second note up an octave, the second-highest note down an
// octave, or the inversion closest to the previous chord (smooth voice leading)
function voice(keys, how, prev) {
  let ks = keys.slice();
  if (how === 'spread') ks = ks.map((k, i) => (i % 2 ? k + 12 : k));
  else if (how === 'drop2' && ks.length >= 3) ks[ks.length - 2] -= 12;
  else if (how === 'smooth' && prev) {
    let bestD = Infinity;
    for (let n = -ks.length; n <= ks.length; n++) {
      const c = invert(keys, n);
      const d = c.reduce((sum, k, i) => sum + Math.abs(k - prev[Math.min(i, prev.length - 1)]), 0);
      if (d < bestD) { bestD = d; ks = c; }
    }
  }
  return ks.map(fold).sort((a, b) => a - b);
}

export const FACTORY_SCRIPTS = [
  {
    id: 'humanize',
    name: 'Humanize',
    description: 'Small random changes of timing, velocity and length, so the part sounds played rather than programmed.',
    params: [
      { id: 'timing', name: 'Timing', type: 'slider', min: 0, max: 24, value: 4, unit: ' ticks' },
      { id: 'velocity', name: 'Velocity', type: 'slider', min: 0, max: 50, value: 12 },
      { id: 'length', name: 'Length', type: 'slider', min: 0, max: 50, value: 10, unit: '%' },
      { id: 'chords', name: 'Keep chords together', type: 'check', value: true },
      SEED,
    ],
    run(ctx) {
      const { timing, velocity, length, chords } = ctx.params;
      // a normal distribution keeps most changes small; it is cut off at the chosen amount
      const dev = (amount) => ctx.clamp(ctx.random.gauss() * amount / 2, -amount, amount);
      const groups = chords ? ctx.chords(ctx.notes) : ctx.notes.map((n) => ({ time: n.time, notes: [n] }));
      for (const g of groups) {
        const dt = Math.round(dev(timing));
        for (const n of g.notes) {
          n.time = Math.max(0, n.time + dt);
          n.velocity = ctx.clamp(Math.round(n.velocity + dev(velocity)), 1, 127);
          n.length = Math.max(1, Math.round(n.length * (1 + dev(length) / 100)));
        }
      }
    },
  },
  {
    id: 'flam',
    name: 'Flam',
    description: 'Adds short grace notes before every note: one for a flam, more for a drag or a ruff.',
    params: [
      { id: 'count', name: 'Grace notes', type: 'slider', min: 1, max: 4, value: 1 },
      { id: 'spacing', name: 'Spacing', type: 'slider', min: 1, max: 24, value: 6, unit: ' ticks' },
      { id: 'velocity', name: 'Grace velocity', type: 'slider', min: 10, max: 100, value: 60, unit: '%' },
      { id: 'pitch', name: 'Grace pitch (semitones)', type: 'slider', min: -12, max: 12, value: 0 },
      { id: 'place', name: 'Placement', type: 'choice', options: [['before', 'Before the note'], ['on', 'On the note (the note moves later)']], value: 'before' },
    ],
    run(ctx) {
      const { count, spacing, velocity, pitch, place } = ctx.params;
      const out = [];
      for (const n of ctx.notes) {
        const shift = place === 'on' ? spacing * count : 0;
        // grace notes end where the note starts; any that would start before the pattern are left out
        for (let i = count; i >= 1; i--) {
          const time = n.time + shift - spacing * i;
          if (time < 0) continue;
          out.push(ctx.note({ ...n, time, length: spacing, key: ctx.clamp(n.key + pitch, 0, 120), velocity: Math.max(1, Math.round(n.velocity * velocity / 100)), slide: false }));
        }
        if (shift) { n.time += shift; n.length = Math.max(1, n.length - shift); }
        out.push(n);
      }
      return out;
    },
  },
  {
    id: 'chords',
    name: 'Chord progression',
    description: 'Writes chords on the degrees of a scale (1 is the root). Fills the selection in whole bars, or the whole pattern.',
    params: [
      { id: 'root', name: 'Root', type: 'choice', options: ROOTS, value: 'roll' },
      { id: 'scale', name: 'Scale', type: 'choice', options: DIATONIC, value: 'roll' },
      { id: 'progression', name: 'Progression', type: 'choice', value: '1 5 6 4', options: [
        ['1 5 6 4', '1 – 5 – 6 – 4'], ['6 4 1 5', '6 – 4 – 1 – 5'], ['1 6 4 5', '1 – 6 – 4 – 5'], ['1 4 5 1', '1 – 4 – 5 – 1'],
        ['2 5 1 1', '2 – 5 – 1'], ['1 4 6 5', '1 – 4 – 6 – 5'], ['1 7 6 7', '1 – 7 – 6 – 7'], ['custom', 'Custom (below)'],
      ] },
      { id: 'custom', name: 'Custom degrees', type: 'text', value: '1 3 4 4' },
      { id: 'size', name: 'Chord size', type: 'choice', options: [[3, 'Triads'], [4, 'Seventh chords'], [5, 'Ninth chords']], value: 3 },
      { id: 'voicing', name: 'Voicing', type: 'choice', options: [['close', 'Close position'], ['smooth', 'Smooth (nearest inversion)'], ['drop2', 'Open (drop 2)'], ['spread', 'Wide (every second note up)']], value: 'close' },
      { id: 'octave', name: 'Octave', type: 'slider', min: 2, max: 7, value: 5 },
      { id: 'every', name: 'Chord length', type: 'choice', options: [['beat', '1 beat'], ['2beats', '2 beats'], ['bar', '1 bar'], ['2bars', '2 bars']], value: 'bar' },
      { id: 'bass', name: 'Add a bass note', type: 'check', value: false },
      { id: 'velocity', name: 'Velocity', type: 'slider', min: 1, max: 127, value: 90 },
      REPLACE,
    ],
    run(ctx) {
      const p = ctx.params;
      const { root, id } = keyOf(ctx, 'major', true);
      const text = p.progression === 'custom' ? p.custom : p.progression;
      const degrees = text.split(/[\s,–-]+/).filter(Boolean).map(Number);
      if (!degrees.length || degrees.some((d) => !Number.isInteger(d) || d < 1 || d > 7)) throw new Error('Write the degrees as numbers from 1 to 7, for example 1 5 6 4');
      const len = { beat: ctx.beat, '2beats': 2 * ctx.beat, bar: ctx.bar, '2bars': 2 * ctx.bar }[p.every];
      const out = p.replace ? [] : ctx.notes;
      let prev = null;
      for (let t = ctx.range.start, i = 0; t < ctx.range.end; t += len, i++) {
        const stacked = ctx.diatonicChord(degrees[i % degrees.length] - 1, p.size, 12 * p.octave, root, id);
        const keys = voice(stacked, p.voicing, prev);
        prev = keys;
        const length = Math.min(len, ctx.range.end - t);
        if (p.bass) out.push(ctx.note({ time: t, length, key: fold(stacked[0] - 12), velocity: p.velocity }));
        for (const key of keys) out.push(ctx.note({ time: t, length, key, velocity: p.velocity }));
      }
      return out;
    },
  },
  {
    id: 'euclid',
    name: 'Euclidean rhythm',
    description: 'Spreads a number of pulses as evenly as possible over the steps (3 pulses in 8 steps is the tresillo). Fills the selection in whole bars, or the whole pattern.',
    params: [
      { id: 'steps', name: 'Steps', type: 'slider', min: 2, max: 32, value: 16 },
      { id: 'pulses', name: 'Pulses', type: 'slider', min: 1, max: 32, value: 5 },
      { id: 'rotation', name: 'Rotation', type: 'slider', min: 0, max: 31, value: 0 },
      { id: 'grid', name: 'Step size', type: 'choice', options: GRID, value: 24 },
      { id: 'key', name: 'Note', type: 'key', value: 60 },
      { id: 'velocity', name: 'Velocity', type: 'slider', min: 1, max: 127, value: 100 },
      { id: 'gate', name: 'Gate', type: 'slider', min: 10, max: 100, value: 50, unit: '%' },
      REPLACE,
    ],
    run(ctx) {
      const p = ctx.params;
      const steps = p.steps, pulses = Math.min(p.pulses, steps);
      // step j of the cycle is a pulse when j·pulses wraps around the step count (Bresenham's line, as in Bjorklund)
      const hit = (i) => { const j = (((i - p.rotation) % steps) + steps) % steps; return (j * pulses) % steps < pulses; };
      const length = Math.max(1, Math.round(p.grid * p.gate / 100));
      const out = p.replace ? [] : ctx.notes;
      for (let i = 0, t = ctx.range.start; t < ctx.range.end; i++, t += p.grid) {
        if (hit(i % steps)) out.push(ctx.note({ time: t, length: Math.min(length, ctx.range.end - t), key: p.key, velocity: p.velocity }));
      }
      return out;
    },
  },
  {
    id: 'arpeggiate',
    name: 'Arpeggiate chords',
    description: 'Turns every chord into a run of single notes (the arpeggiator of the Tools menu, with a live preview and an accent on the beats).',
    params: [
      { id: 'mode', name: 'Direction', type: 'choice', value: 'up', options: [
        ['up', 'Up'], ['down', 'Down'], ['up-down', 'Up and down'], ['down-up', 'Down and up'], ['converge', 'Converge'], ['diverge', 'Diverge'], ['random', 'Random'], ['played', 'As played'],
      ] },
      { id: 'rate', name: 'Rate', type: 'choice', options: GRID, value: 24 },
      { id: 'gate', name: 'Gate', type: 'slider', min: 5, max: 100, value: 80, unit: '%' },
      { id: 'octaves', name: 'Octaves', type: 'slider', min: 1, max: 4, value: 1 },
      { id: 'accent', name: 'Accent on the beats', type: 'slider', min: 0, max: 40, value: 0 },
      SEED,
    ],
    run(ctx) {
      const p = ctx.params;
      // notes of chords (the arpeggio keeps the id of a chord's first note, the rest are new) get the accent
      const chordIds = new Set(ctx.chords(ctx.notes).filter((g) => g.notes.length > 1).flatMap((g) => g.notes.map((n) => n.id)));
      const out = ctx.tools.arpeggiate(ctx.notes, { mode: p.mode, rate: p.rate, gate: p.gate / 100, octaves: p.octaves, seed: p.seed });
      if (p.accent) for (const n of out) if ((n.id === undefined || chordIds.has(n.id)) && n.time % ctx.beat === 0) n.velocity = Math.min(127, n.velocity + p.accent);
      return out;
    },
  },
  {
    id: 'melody',
    name: 'Random melody',
    description: 'A random melody in a scale; the same seed always gives the same melody. Fills the selection in whole bars, or the whole pattern.',
    params: [
      SEED,
      { id: 'root', name: 'Root', type: 'choice', options: ROOTS, value: 'roll' },
      { id: 'scale', name: 'Scale', type: 'choice', options: SCALE_CHOICES, value: 'roll' },
      { id: 'lo', name: 'Lowest key', type: 'key', value: 60 },
      { id: 'hi', name: 'Highest key', type: 'key', value: 72 },
      { id: 'grid', name: 'Step size', type: 'choice', options: [[12, '1/32'], [24, '1/16'], [48, '1/8'], [96, '1/4']], value: 24 },
      { id: 'density', name: 'Density', type: 'slider', min: 10, max: 100, value: 70, unit: '%' },
      { id: 'leap', name: 'Largest leap (scale degrees)', type: 'slider', min: 1, max: 7, value: 3 },
      { id: 'long', name: 'Long notes', type: 'slider', min: 0, max: 100, value: 25, unit: '%' },
      { id: 'velocity', name: 'Velocity', type: 'slider', min: 1, max: 127, value: 100 },
      { id: 'velVar', name: 'Velocity variation', type: 'slider', min: 0, max: 40, value: 10 },
      REPLACE,
    ],
    run(ctx) {
      const p = ctx.params, r = ctx.random;
      const { root, id } = keyOf(ctx, 'major');
      const keys = ctx.scaleKeys(Math.min(p.lo, p.hi), Math.max(p.lo, p.hi), root, id);
      if (!keys.length) throw new Error('No key of the scale lies between the lowest and the highest key');
      const last = keys.length - 1;
      let idx = Math.floor(last / 2);
      const out = p.replace ? [] : ctx.notes;
      for (let t = ctx.range.start; t < ctx.range.end;) {
        const first = t === ctx.range.start;          // the melody always starts on the first step
        if (!first && !r.chance(p.density / 100)) { t += p.grid; continue; }
        let steps = 1;
        while (steps < 4 && r.chance(p.long / 100)) steps++;
        if (!first) {
          idx += r.int(-p.leap, p.leap);
          if (idx < 0) idx = -idx;                        // bounce off the ends of the range
          if (idx > last) idx = 2 * last - idx;
          idx = ctx.clamp(idx, 0, last);
        }
        const length = Math.max(1, Math.round(Math.min(steps * p.grid, ctx.range.end - t) * 0.9));
        out.push(ctx.note({ time: t, length, key: keys[idx], velocity: ctx.clamp(Math.round(p.velocity + r.range(-1, 1) * p.velVar), 1, 127) }));
        t += steps * p.grid;
      }
      return out;
    },
  },
  {
    id: 'mirror',
    name: 'Invert / Mirror',
    description: 'Mirrors the pitches around a key (high becomes low) and/or plays the notes backwards.',
    params: [
      { id: 'mode', name: 'Mirror', type: 'choice', options: [['pitch', 'Pitch (around a key)'], ['time', 'Time (backwards)'], ['both', 'Pitch and time']], value: 'pitch' },
      { id: 'center', name: 'Center', type: 'choice', options: [['middle', 'Middle of the notes'], ['lowest', 'Lowest note'], ['highest', 'Highest note'], ['key', 'The center key below']], value: 'middle' },
      { id: 'key', name: 'Center key', type: 'key', value: 60 },
      { id: 'inScale', name: 'Keep in the scale', type: 'check', value: false },
    ],
    run(ctx) {
      const p = ctx.params;
      let notes = ctx.notes;
      if (!notes.length) return notes;
      if (p.mode !== 'time') {
        const ks = notes.map((n) => n.key), lo = Math.min(...ks), hi = Math.max(...ks);
        const c = { middle: (lo + hi) / 2, lowest: lo, highest: hi, key: p.key }[p.center];
        for (const n of notes) {
          let k = fold(Math.round(2 * c - n.key));
          if (p.inScale && ctx.scale.id !== 'chromatic') k = fold(ctx.snapToScale(k));
          n.key = k;
        }
      }
      if (p.mode !== 'pitch') notes = ctx.tools.flip(notes, 'h');
      return notes;
    },
  },
  {
    id: 'velocity',
    name: 'Velocity curve',
    description: 'Sets the velocities along a curve over time: a ramp (crescendo or fade), waves or random values.',
    params: [
      { id: 'shape', name: 'Shape', type: 'choice', options: [['up', 'Ramp up'], ['down', 'Ramp down'], ['sine', 'Sine'], ['triangle', 'Triangle'], ['random', 'Random']], value: 'up' },
      { id: 'from', name: 'Lowest velocity', type: 'slider', min: 1, max: 127, value: 40 },
      { id: 'to', name: 'Highest velocity', type: 'slider', min: 1, max: 127, value: 120 },
      { id: 'cycles', name: 'Cycles', type: 'slider', min: 1, max: 16, value: 1 },
      { id: 'amount', name: 'Amount', type: 'slider', min: 0, max: 100, value: 100, unit: '%' },
      SEED,
    ],
    run(ctx) {
      const p = ctx.params, notes = ctx.notes;
      if (!notes.length) return notes;
      const t0 = Math.min(...notes.map((n) => n.time)), span = Math.max(...notes.map((n) => n.time)) - t0;
      for (const n of notes.slice().sort((a, b) => a.time - b.time || a.key - b.key)) {
        const x = span ? (n.time - t0) / span : 0;            // 0 at the first note, 1 at the last
        const c = x * p.cycles;
        const ph = x > 0 ? c - Math.ceil(c) + 1 : 0;          // position inside the current cycle; the last note ends a cycle
        const y = { up: ph, down: 1 - ph, sine: 0.5 - 0.5 * Math.cos(2 * Math.PI * c), triangle: 1 - Math.abs((c % 1) * 2 - 1), random: ctx.random() }[p.shape];
        const target = p.from + (p.to - p.from) * y;
        n.velocity = ctx.clamp(Math.round(n.velocity + (target - n.velocity) * p.amount / 100), 1, 127);
      }
    },
  },
  {
    id: 'harmonize',
    name: 'Harmonize',
    description: 'Adds a second voice a third, fourth, fifth, sixth or an octave away from every note, inside the scale.',
    params: [
      { id: 'interval', name: 'Interval', type: 'choice', options: [[2, 'A third'], [3, 'A fourth'], [4, 'A fifth'], [5, 'A sixth'], [7, 'An octave']], value: 2 },
      { id: 'dir', name: 'Direction', type: 'choice', options: [['up', 'Above'], ['down', 'Below']], value: 'up' },
      { id: 'root', name: 'Root', type: 'choice', options: ROOTS, value: 'roll' },
      { id: 'scale', name: 'Scale', type: 'choice', options: SCALE_CHOICES, value: 'roll' },
      { id: 'velocity', name: 'Harmony velocity', type: 'slider', min: 10, max: 100, value: 80, unit: '%' },
    ],
    run(ctx) {
      const p = ctx.params;
      const { root, id } = keyOf(ctx, 'major');
      const sign = p.dir === 'up' ? 1 : -1;
      const out = ctx.notes.slice();
      for (const n of ctx.notes) {
        // an octave is 12 semitones in any scale; the other intervals count scale degrees
        const key = p.interval === 7 ? n.key + 12 * sign : ctx.scaleStep(n.key, p.interval * sign, root, id);
        if (key < 0 || key > 120) continue;
        out.push(ctx.note({ ...n, key, velocity: Math.max(1, Math.round(n.velocity * p.velocity / 100)) }));
      }
      return out;
    },
  },
  {
    id: 'thin',
    name: 'Thin out',
    description: 'Removes notes at random for a sparser variation of a beat or a part. Notes on the beat can stay.',
    params: [
      { id: 'amount', name: 'Notes removed', type: 'slider', min: 0, max: 100, value: 30, unit: '%' },
      { id: 'beats', name: 'Keep notes on the beat', type: 'check', value: true },
      SEED,
    ],
    run(ctx) {
      const p = ctx.params;
      // one draw per note whatever the settings: a larger amount removes the same notes plus more
      return ctx.notes.filter((n) => { const x = ctx.random(); return (p.beats && n.time % ctx.beat === 0) || x >= p.amount / 100; });
    },
  },
  {
    id: 'bass',
    name: 'Bass from chords',
    description: 'Writes a bass line under the chords: the lowest note of every chord, moved to the chosen octave, in a rhythm.',
    params: [
      { id: 'octave', name: 'Octave', type: 'slider', min: 1, max: 6, value: 3 },
      { id: 'rhythm', name: 'Rhythm', type: 'choice', options: [['hold', 'One note per chord'], ['beats', 'Every beat'], ['eighths', 'Every 1/8'], ['fifth', 'Root and fifth'], ['octaves', 'Octave jumps (1/8)']], value: 'hold' },
      { id: 'velocity', name: 'Velocity', type: 'slider', min: 1, max: 127, value: 100 },
      { id: 'keep', name: 'Keep the chords', type: 'check', value: true },
    ],
    run(ctx) {
      const p = ctx.params;
      const out = p.keep ? ctx.notes.slice() : [];
      const groups = ctx.chords(ctx.notes);
      groups.forEach((g, gi) => {
        const next = groups[gi + 1];
        const end = Math.min(Math.max(...g.notes.map((n) => n.time + n.length)), next ? next.time : Infinity);
        const key = 12 * p.octave + (g.notes[0].key % 12);
        const step = p.rhythm === 'hold' ? end - g.time : p.rhythm === 'beats' || p.rhythm === 'fifth' ? ctx.beat : ctx.beat / 2;
        for (let t = g.time, i = 0; t < end; t += step, i++) {
          const k = key + (i % 2 ? (p.rhythm === 'fifth' ? 7 : p.rhythm === 'octaves' ? 12 : 0) : 0);
          const length = Math.max(1, Math.round(Math.min(step, end - t) * (p.rhythm === 'hold' ? 1 : 0.9)));
          out.push(ctx.note({ time: t, length, key: fold(k), velocity: p.velocity }));
        }
      });
      return out;
    },
  },
];

// parameters are checked like a user script's (and their defaults filled in) when the module loads
for (const s of FACTORY_SCRIPTS) s.params = normalizeParams(s.params);
export const FACTORY_BY_ID = new Map(FACTORY_SCRIPTS.map((s) => [s.id, s]));
