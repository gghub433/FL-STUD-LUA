// Piano roll tool menu and the dialogs behind each tool (algorithms live in core/note-tools.js).
import { h } from './h.js';
import { formDialog } from './forms.js';
import { PPQ, STEP, keyName } from '../core/constants.js';
import * as T from '../core/note-tools.js';
import { SCALES } from '../core/scales.js';

const GRIDS = [
  [384, '1 bar'], [192, '1/2 bar'], [96, '1 beat'], [48, '1/2 beat'], [32, '1/3 beat'], [24, '1/4 beat (step)'], [16, '1/6 beat'], [12, '1/8 beat'], [8, '1/12 beat'], [4, '1/24 beat'],
];
const nearestGrid = (t) => GRIDS.reduce((a, b) => (Math.abs(b[0] - t) < Math.abs(a[0] - t) ? b : a))[0];
const seedDefault = () => Math.floor(Math.random() * 9000) + 1;

const reroll = (inputs) => h('div.row', { style: { marginTop: '6px' } }, h('div.btn.sm', { onclick: () => { inputs.seed.value = String(seedDefault()); inputs.seed.dispatchEvent(new Event('change')); } }, 'Re-roll seed'));

// notes the tool acts on: the selection, or every note of the channel when nothing is selected
function target(roll) {
  const ids = roll.sel.size ? [...roll.sel] : roll.notes.map((n) => n.id);
  return ids;
}

function run(roll, label, fn, { keepSel = true } = {}) {
  if (!roll.isSound) return;
  const ids = target(roll);
  if (!ids.length) { roll.app.toast('No notes to work on. Select some notes or add a few first'); return; }
  const out = roll.app.cmd.replaceNotes(roll.store, roll.chId, ids, fn, label);
  if (keepSel) { roll.setSel(out); roll.reveal(); }
}

function generate(roll, label, gen, replace) {
  if (!roll.isSound) return;
  const ids = replace ? target(roll) : [];
  const out = roll.app.cmd.replaceNotes(roll.store, roll.chId, ids, (sel, newId) => gen(sel, newId), label);
  roll.setSel(out); roll.reveal();
}

const TOOLSET = {
  quickQuantize(roll) {
    const grid = roll.snapTicks();
    run(roll, 'Quick quantize', (ns) => T.quantize(ns, { grid, strength: 1 }));
  },
  async quantize(roll) {
    const v = await formDialog('Quantize', [
      { id: 'grid', label: 'Grid', type: 'select', value: nearestGrid(roll.snapTicks()), options: GRIDS },
      { id: 'strength', label: 'Strength', type: 'range', min: 0, max: 100, value: 100, unit: '%' },
      { id: 'ends', label: 'Also quantize ends', type: 'check', value: false },
      { id: 'swing', label: 'Swing', type: 'range', min: 0, max: 100, value: 0, unit: '%' },
    ]);
    if (v) run(roll, 'Quantize', (ns) => T.quantize(ns, { grid: v.grid, strength: v.strength / 100, ends: v.ends, swing: v.swing / 100 }));
  },
  async chop(roll) {
    const v = await formDialog('Chop', [
      { id: 'parts', label: 'Parts per note', type: 'number', min: 2, max: 64, value: 4 },
      { id: 'gate', label: 'Gate', type: 'range', min: 5, max: 100, value: 100, unit: '%' },
    ]);
    if (v) run(roll, 'Chop notes', (ns, newId) => T.chop(ns, { parts: v.parts, gate: v.gate / 100 }, newId));
  },
  glue(roll) { run(roll, 'Glue notes', (ns) => T.glue(ns)); },
  flipH(roll) { run(roll, 'Flip horizontally', (ns) => T.flip(ns, 'h')); },
  flipV(roll) { run(roll, 'Flip vertically', (ns) => T.flip(ns, 'v')); },
  async randomize(roll) {
    const v = await formDialog('Randomize', [
      { id: 'seed', label: 'Seed', type: 'number', min: 1, max: 999999, value: seedDefault() },
      { id: 'velocity', label: 'Velocity', type: 'range', min: 0, max: 100, value: 30, unit: '%' },
      { id: 'pitch', label: 'Pitch (octave)', type: 'range', min: 0, max: 100, value: 0, unit: '%' },
      { id: 'timing', label: 'Timing', type: 'range', min: 0, max: 100, value: 0, unit: '%' },
      { id: 'length', label: 'Length', type: 'range', min: 0, max: 100, value: 0, unit: '%' },
      { id: 'pan', label: 'Panning', type: 'range', min: 0, max: 100, value: 0, unit: '%' },
      { id: 'release', label: 'Release', type: 'range', min: 0, max: 100, value: 0, unit: '%' },
      { id: 'fine', label: 'Fine pitch', type: 'range', min: 0, max: 100, value: 0, unit: '%' },
      { id: 'inkey', label: 'Keep pitches in the scale', type: 'check', value: roll.scale.id !== 'chromatic' },
    ], { extra: reroll });
    if (v) {
      run(roll, 'Randomize', (ns) => T.randomize(ns, {
        seed: v.seed, velocity: v.velocity / 100, pitch: v.pitch / 100, timing: v.timing / 100, length: v.length / 100, pan: v.pan / 100, release: v.release / 100, fine: v.fine / 100,
        scale: v.inkey ? roll.scale.id : null, root: roll.scale.root, grid: roll.snapTicks(),
      }));
    }
  },
  async limit(roll) {
    const b = T.bounds(roll.selNotes.length ? roll.selNotes : roll.notes) || { lo: 36, hi: 84 };
    const v = await formDialog('Limit', [
      { id: 'kmin', label: 'Lowest key', type: 'text', value: keyName(b.lo) },
      { id: 'kmax', label: 'Highest key', type: 'text', value: keyName(b.hi) },
      { id: 'vmin', label: 'Min velocity', type: 'number', min: 1, max: 127, value: 1 },
      { id: 'vmax', label: 'Max velocity', type: 'number', min: 1, max: 127, value: 127 },
      { id: 'minLen', label: 'Min length', type: 'number', min: 1, max: 100000, value: 1, unit: 'ticks' },
      { id: 'maxLen', label: 'Max length', type: 'number', min: 1, max: 100000, value: 4 * PPQ, unit: 'ticks' },
    ]);
    if (!v) return;
    const lo = roll.parseKey(v.kmin), hi = roll.parseKey(v.kmax);
    if (lo === null || hi === null) { roll.app.toast('Keys look like C5, F#4 or a number'); return; }
    run(roll, 'Limit notes', (ns) => T.limit(ns, { kmin: Math.min(lo, hi), kmax: Math.max(lo, hi), vmin: v.vmin, vmax: v.vmax, minLen: v.minLen, maxLen: v.maxLen }));
  },
  async strum(roll) {
    const v = await formDialog('Strum', [
      { id: 'ticks', label: 'Delay between notes', type: 'range', min: 1, max: 48, value: 6, unit: ' ticks' },
      { id: 'dir', label: 'Direction', type: 'select', value: 'up', options: [['up', 'Up (low to high)'], ['down', 'Down'], ['random', 'Random']] },
      { id: 'tension', label: 'Tension', type: 'range', min: -100, max: 100, value: 0, unit: '%' },
    ]);
    if (v) run(roll, 'Strum', (ns) => T.strum(ns, { ticks: v.ticks, dir: v.dir, tension: v.tension / 100, seed: 1 }));
  },
  async arpeggiate(roll) {
    const v = await formDialog('Arpeggiator', [
      { id: 'mode', label: 'Pattern', type: 'select', value: 'up', options: T.ARP_MODES.map((m) => [m, m.replace('-', ' ')]) },
      { id: 'rate', label: 'Rate', type: 'select', value: 24, options: GRIDS.slice(2) },
      { id: 'gate', label: 'Gate', type: 'range', min: 5, max: 100, value: 90, unit: '%' },
      { id: 'octaves', label: 'Octaves', type: 'number', min: 1, max: 4, value: 1 },
      { id: 'seed', label: 'Seed (random mode)', type: 'number', min: 1, max: 999999, value: 1 },
      { id: 'velVar', label: 'Velocity variation', type: 'range', min: 0, max: 100, value: 0, unit: '%' },
    ]);
    if (v) run(roll, 'Arpeggiate', (ns, newId) => T.arpeggiate(ns, { mode: v.mode, rate: v.rate, gate: v.gate / 100, octaves: v.octaves, seed: v.seed, velVar: v.velVar / 100 }, newId));
  },
  async articulate(roll) {
    const names = Object.keys(T.ARTICULATIONS);
    const v = await formDialog('Articulator', [
      { id: 'preset', label: 'Articulation', type: 'select', value: names[0], options: names.map((n) => [n, n]) },
      { id: 'gate', label: 'Gate scale', type: 'range', min: 25, max: 200, value: 100, unit: '%' },
      { id: 'vel', label: 'Velocity scale', type: 'range', min: 25, max: 200, value: 100, unit: '%' },
    ]);
    if (!v) return;
    const steps = T.ARTICULATIONS[v.preset].map((s) => ({ ...s, gate: (s.gate ?? 1) * v.gate / 100, vel: (s.vel ?? 1) * v.vel / 100 }));
    run(roll, 'Articulate', (ns) => T.articulate(ns, steps));
  },
  legato(roll) { run(roll, 'Legato', (ns) => T.legato(ns)); },
  transpose(roll, semis, byScale = false) {
    run(roll, 'Transpose', (ns) => T.transpose(ns, semis, byScale && roll.scale.id !== 'chromatic' ? { scale: roll.scale.id, root: roll.scale.root } : {}));
    const n = roll.selNotes[0];
    if (n) roll.audition(n.k, n.v);
  },
  fitToScale(roll) {
    if (roll.scale.id === 'chromatic') { roll.app.toast('Pick a scale in the toolbar first'); return; }
    run(roll, 'Fit to scale', (ns) => T.fitToScale(ns, roll.scale.root, roll.scale.id));
  },
  deleteDuplicates(roll) {
    run(roll, 'Delete duplicates', (ns) => { const seen = new Set(); return ns.filter((n) => { const k = `${n.s}:${n.k}`; if (seen.has(k)) return false; seen.add(k); return true; }); });
  },
  selectSamePitch(roll) {
    const keys = new Set(roll.selNotes.map((n) => n.k));
    roll.setSel(roll.notes.filter((n) => keys.has(n.k)).map((n) => n.id));
  },
  async claw(roll) {
    const v = await formDialog('Claw machine', [
      { id: 'seed', label: 'Seed', type: 'number', min: 1, max: 999999, value: seedDefault() },
      { id: 'steps', label: 'Steps', type: 'number', min: 1, max: 128, value: 16 },
      { id: 'grid', label: 'Step size', type: 'select', value: STEP, options: GRIDS.slice(3) },
      { id: 'density', label: 'Density', type: 'range', min: 5, max: 100, value: 55, unit: '%' },
      { id: 'gate', label: 'Note length', type: 'range', min: 10, max: 100, value: 80, unit: '%' },
      { id: 'replace', label: 'Replace selected notes', type: 'check', value: roll.sel.size > 0 },
    ], { extra: reroll });
    if (!v) return;
    const start = roll.sel.size ? Math.min(...roll.selNotes.map((n) => n.s)) : roll.cursorT;
    generate(roll, 'Claw machine', (sel, newId) => {
      const pool = sel.length ? sel : roll.notes;
      const out = T.clawMachine(pool, { seed: v.seed, steps: v.steps, grid: v.grid, density: v.density / 100, gate: v.gate / 100, start, root: roll.scale.root, scale: roll.scale.id === 'chromatic' ? 'minor' : roll.scale.id }, newId);
      return v.replace ? out : sel.concat(out);
    }, v.replace);
  },
  async riff(roll) {
    const v = await formDialog('Riff machine', [
      { id: 'seed', label: 'Seed', type: 'number', min: 1, max: 999999, value: seedDefault() },
      { id: 'bars', label: 'Bars', type: 'number', min: 1, max: 16, value: 2 },
      { id: 'scaleId', label: 'Scale', type: 'select', value: roll.scale.id === 'chromatic' ? 'minor' : roll.scale.id, options: SCALES.filter((s) => s.id !== 'chromatic').map((s) => [s.id, s.name]) },
      { id: 'root', label: 'Root', type: 'select', value: roll.scale.root, options: ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'].map((n, i) => [i, n]) },
      { id: 'density', label: 'Density', type: 'range', min: 20, max: 100, value: 75, unit: '%' },
      { id: 'leap', label: 'Leaps', type: 'range', min: 0, max: 100, value: 20, unit: '%' },
      { id: 'rests', label: 'Rests', type: 'range', min: 0, max: 100, value: 20, unit: '%' },
      { id: 'lo', label: 'Lowest key', type: 'text', value: 'G4' },
      { id: 'hi', label: 'Highest key', type: 'text', value: 'G5' },
      { id: 'replace', label: 'Replace existing notes', type: 'check', value: false },
    ], { extra: reroll });
    if (!v) return;
    const lo = roll.parseKey(v.lo), hi = roll.parseKey(v.hi);
    if (lo === null || hi === null) { roll.app.toast('Keys look like C5, F#4 or a number'); return; }
    const start = roll.cursorT - (roll.cursorT % roll.barT);
    const ch = roll.chId;
    const ids = v.replace ? roll.notes.map((n) => n.id) : [];
    const out = roll.app.cmd.replaceNotes(roll.store, ch, ids, (sel, newId) => T.riffMachine({ seed: v.seed, root: v.root, scale: v.scaleId, bars: v.bars, beatsPerBar: roll.store.project.timeSig.num, start, density: v.density / 100, leap: v.leap / 100, rests: v.rests / 100, lo: Math.min(lo, hi), hi: Math.max(lo, hi) }, newId), 'Riff machine');
    roll.setSel(out); roll.reveal();
  },
};

export function openTool(roll, name, ...args) { return TOOLSET[name](roll, ...args); }

export function toolsMenu(roll) {
  const t = (name, ...a) => () => TOOLSET[name](roll, ...a);
  return [
    { label: 'Quick quantize', key: 'Ctrl+Q', fn: t('quickQuantize') },
    { label: 'Quantize…', key: 'Alt+Q', fn: t('quantize') },
    { sep: true },
    { label: 'Chop…', fn: t('chop') },
    { label: 'Glue', key: 'Ctrl+G', fn: t('glue') },
    { label: 'Flip', submenu: [{ label: 'Horizontally (reverse)', fn: t('flipH') }, { label: 'Vertically (invert pitch)', fn: t('flipV') }] },
    { label: 'Randomize…', fn: t('randomize') },
    { label: 'Limit…', fn: t('limit') },
    { sep: true },
    { label: 'Strum…', fn: t('strum') },
    { label: 'Arpeggiator…', fn: t('arpeggiate') },
    { label: 'Articulator…', fn: t('articulate') },
    { label: 'Legato', fn: t('legato') },
    { sep: true },
    { label: 'Transpose', submenu: [
      { label: 'Up a semitone', fn: t('transpose', 1) }, { label: 'Down a semitone', fn: t('transpose', -1) },
      { label: 'Up an octave', fn: t('transpose', 12) }, { label: 'Down an octave', fn: t('transpose', -12) },
      { sep: true },
      { label: 'Up a scale degree', fn: t('transpose', 1, true) }, { label: 'Down a scale degree', fn: t('transpose', -1, true) },
    ] },
    { label: 'Fit to scale', fn: t('fitToScale') },
    { sep: true },
    { label: 'Claw machine…', fn: t('claw') },
    { label: 'Riff machine…', fn: t('riff') },
    { sep: true },
    { label: 'Save selection as score…', fn: () => roll.app.saveScore(roll.selNotes.length ? roll.selNotes : roll.notes) },
    { label: 'Select all', key: 'Ctrl+A', fn: () => roll.setSel(roll.notes.map((n) => n.id)) },
    { label: 'Invert selection', key: 'Ctrl+I', fn: () => roll.setSel(roll.notes.filter((n) => !roll.sel.has(n.id)).map((n) => n.id)) },
    { label: 'Select same pitch', fn: t('selectSamePitch') },
    { label: 'Delete duplicates', fn: t('deleteDuplicates') },
  ];
}

