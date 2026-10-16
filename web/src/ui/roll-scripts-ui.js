// Piano roll Tools > Scripts: the factory and user scripts, the parameter dialog with a live preview, and the script
// editor (new / edit / import / export / delete). How a script runs: core/roll-scripts.js and app/roll-scripts.js.
import { h } from './h.js';
import { formDialog } from './forms.js';
import { modal, confirmBox, alertBox } from './dialog.js';
import { keyName } from '../core/constants.js';
import { paramValues } from '../core/roll-scripts.js';
import { downloadBlob } from '../host/export/wav.js';
import {
  ScriptSession, ScriptWorker, factoryRunner, userRunner, factoryScripts, userScripts, userScriptList, saveUserScript, deleteUserScript, freeName,
} from '../app/roll-scripts.js';

const lastValues = new Map();            // runner key -> the values of the last OK (for this session of the app)

// the example a new script starts from
const TEMPLATE = `// A piano roll script. ctx.notes are the selected notes, or all notes of the channel
// in this pattern when nothing is selected. Return the notes the channel should have.
export default {
  name: 'Octave doubler',
  params: [
    { id: 'octaves', name: 'Octaves', type: 'slider', min: -2, max: 2, value: 1 },
    { id: 'velocity', name: 'Velocity', type: 'slider', min: 0, max: 100, value: 70, unit: '%' },
    { id: 'keep', name: 'Keep the originals', type: 'check', value: true },
  ],
  run(ctx) {
    const { octaves, velocity, keep } = ctx.params;
    const copies = ctx.notes.map((n) => ctx.note({
      ...n,
      key: ctx.clamp(n.key + 12 * octaves, 0, 120),
      velocity: Math.round(n.velocity * velocity / 100),
    }));
    return keep ? ctx.notes.concat(copies) : copies;
  },
};
`;

// [code, what it is] for the reference under the editor
const API = [
  ['export default { name, params, run(ctx) }', 'A script exports its definition. run(ctx) returns the new notes, or changes ctx.notes in place.'],
  ['ctx.notes', 'The selected notes, or all notes of the channel in this pattern when nothing is selected. They are copies: the piano roll changes only when the script has finished.'],
  ['{ id, time, length, key, velocity, pan, release, fine, modX, modY, color, slide, muted }', 'The fields of a note: time and length in ticks, key 0–120 (60 = C5), velocity 1–127, pan −64…64, release 0–127, fine −120…120 cents, mod X / Y 0–255, color 0–15.'],
  ['ctx.note({ time, key, … })', 'A new note; the fields you leave out get their defaults. A note without an id (or with the id of a note already in the list) is added.'],
  ['params: [{ id, name, type, value, … }]', "The parameters shown in the dialog. type: 'slider' or 'number' (min, max, step, unit), 'key' (a key 0–120), 'choice' (options: ['A', 'B'] or [[value, 'Label'], …]), 'check', 'text'. value is the default."],
  ['ctx.params', 'The values of the parameters, by id.'],
  ['ctx.ppq  ctx.step  ctx.beat  ctx.bar  ctx.timeSig', 'Ticks per quarter note (96), per step (1/16), per beat and per bar; the time signature { num, den }.'],
  ['ctx.range  ctx.selection  ctx.patternLength', 'Where generators write: the selection in whole bars, or the whole pattern. selection is true when notes are selected.'],
  ['ctx.scale', "The scale of the piano roll: { root (0–11), id, name, intervals }; the id is 'chromatic' when no scale is chosen."],
  ['ctx.random()  .int(a, b)  .range(a, b)  .pick(list)  .chance(p)  .gauss()', "Seeded random numbers: the same seed gives the same result. The seed is the 'seed' parameter when the script has one."],
  ['ctx.quantize(time, grid, strength)', 'Moves a time toward the grid (grid in ticks, strength 0–1).'],
  ['ctx.chords(notes)', 'Groups the notes that start together: [{ time, notes }], lowest key first.'],
  ['ctx.inScale(k)  ctx.snapToScale(k)  ctx.scaleStep(k, n)  ctx.scaleKeys(lo, hi)', 'Scale helpers: in the scale of the piano roll, or pass a root (0–11) and a scale id after the other arguments.'],
  ['ctx.chord(rootKey, type, inversion)  ctx.diatonicChord(degree, size, octaveKey)', 'Chord keys: a chord type (maj, min, 7, m7, …) on a root key, or a chord stacked on a scale degree (0 = the root).'],
  ['ctx.tools.quantize / chop / glue / flip / strum / arpeggiate / legato / transpose / fitToScale', 'The note tools of the piano roll, working on script notes.'],
  ['ctx.keyName(60)  ctx.parseKey(\'C5\')  ctx.clamp(x, lo, hi)', 'Note names and a clamp.'],
  ["throw new Error('…')", 'Stops the script and shows the message; the notes stay as they were. Values out of range are clamped; NaN, a key outside 0–120, a negative time or a length of 0 stop the script too.'],
];

// ------------------------------------------------------------------------------ menu
export function scriptsMenu(roll) {
  const run = (make) => () => runScript(roll, make());
  const items = factoryScripts().map((d) => ({ label: `${d.name}…`, fn: run(() => factoryRunner(d)) }));
  const mine = userScriptList();
  items.push({ sep: true });
  if (mine.length) {
    items.push({ title: 'My scripts' });
    for (const s of mine) items.push({ label: s.name, fn: run(() => userRunner(s.name, s.source)) });
    items.push({ sep: true });
  }
  items.push({ label: 'New script…', fn: () => editScript(roll) });
  if (mine.length) {
    const each = (fn) => mine.map((s) => ({ label: s.name, fn: () => fn(s) }));
    items.push(
      { label: 'Edit script', submenu: each((s) => editScript(roll, s.name)) },
      { label: 'Export script (.js)', submenu: each((s) => exportScript(roll.app, s)) },
      { label: 'Delete script', submenu: each((s) => removeScript(roll.app, s.name)) },
    );
  }
  items.push({ label: 'Import script (.js)…', fn: () => importScript(roll) });
  return items;
}

// ------------------------------------------------------------------------------ running
// script parameter -> a field of formDialog
function field(p, value) {
  const f = { id: p.id, label: p.name, value, hint: p.hint };
  if (p.type === 'slider') Object.assign(f, { type: 'range', min: p.min, max: p.max, step: p.step, unit: p.unit });
  else if (p.type === 'key') Object.assign(f, { type: 'range', min: p.min, max: p.max, step: 1, format: keyName });
  else if (p.type === 'number') Object.assign(f, { type: 'number', min: p.min, max: p.max, step: p.step, unit: p.unit });
  else if (p.type === 'choice') Object.assign(f, { type: 'select', options: p.options });
  else f.type = p.type;                   // check, text
  return f;
}

// Runs a script on the selection (or on all notes of the channel). With parameters a dialog opens: every change is
// applied at once, Cancel restores the notes, OK keeps the result as one undo step. A script error shows its message
// and leaves the notes as they were.
export async function runScript(roll, runner) {
  if (!roll.isSound) { runner.dispose(); roll.app.toast('Select a channel with an instrument first'); return; }
  let info;
  try { info = await runner.load(); } catch (e) { runner.dispose(); alertBox(runner.name, e.message); return; }
  const hadSel = roll.sel.size > 0, oldSel = [...roll.sel];
  const ids = hadSel ? oldSel : roll.notes.map((n) => n.id);
  const session = new ScriptSession(roll.store, roll.chId, ids, runner, { scale: { root: roll.scale.root, id: roll.scale.id }, selection: hadSel });
  const end = (r) => {
    if (!r.ok) { roll.setSel(oldSel); alertBox(runner.name, r.error); return; }
    roll.setSel(hadSel ? r.ids : []);
    if (hadSel) roll.reveal();
  };
  if (!info.params.length) { end(await session.commit({})); return; }

  const start = paramValues(info.params, lastValues.get(runner.key));
  const fields = info.params.map((p) => field(p, start[p.id]));
  let okBtn = null, errEl = null, want = null, busy = null;
  const show = (r) => {
    errEl.textContent = r.ok ? '' : r.error;
    errEl.style.display = r.ok ? 'none' : '';
    if (okBtn) okBtn.disabled = !r.ok;
  };
  // previews run one after the other; while one runs only the newest request waits
  const pump = async () => { while (want) { const v = want; want = null; show(await session.preview(v)); } busy = null; };
  const request = (v) => { want = v; if (!busy) busy = pump(); };
  const extra = (inputs, vals) => {
    errEl = h('div.rs-error', { style: { display: 'none' } });
    const seed = info.params.find((p) => p.id === 'seed' && (p.type === 'slider' || p.type === 'number'));
    const reroll = () => {
      inputs.seed.value = String(seed.min + Math.floor(Math.random() * (seed.max - seed.min + 1)));
      inputs.seed.dispatchEvent(new Event(seed.type === 'slider' ? 'input' : 'change'));
    };
    const box = h('div.rs-extra',
      info.description ? h('div.rs-desc', info.description) : null,
      errEl,
      seed ? h('div.row', h('div.btn.sm', { hint: 'A new random seed', onclick: reroll }, 'Re-roll seed')) : null);
    queueMicrotask(() => { const m = box.closest('.modal'); okBtn = m && m.querySelector('.modal-foot .btn.primary'); request(vals()); });
    return box;
  };
  const v = await formDialog(runner.name, fields, { ok: 'OK', width: 440, onChange: request, extra, scroll: fields.length > 9 });
  while (busy) await busy;
  if (!v) { session.cancel(); roll.setSel(oldSel); return; }
  lastValues.set(runner.key, v);
  end(await session.commit(v));
}

// ------------------------------------------------------------------------------ editor
function apiReference() {
  return h('details.rs-help',
    h('summary', 'Script API reference'),
    h('div.rs-api', API.map(([code, text]) => [h('code', { 'data-no-i18n': '' }, code), h('div', text)])));
}

export function editScript(roll, name = null) {
  const app = roll.app;
  const cur = name ? userScripts()[name] : null;
  const nameInp = h('input.field', { type: 'text', value: cur ? cur.name : freeName('My script'), style: { flex: 1 } });
  nameInp.addEventListener('keydown', (e) => e.stopPropagation());
  const code = h('textarea.field.rs-code', { spellcheck: false, rows: 22 });
  code.value = cur ? cur.source : TEMPLATE;
  code.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Tab' && !e.ctrlKey && !e.altKey) { e.preventDefault(); code.setRangeText('  ', code.selectionStart, code.selectionEnd, 'end'); }
  });
  const err = h('div.rs-error', { style: { display: 'none' } });
  let saving = false;
  const save = async (andRun) => {
    if (saving) return;
    const n = nameInp.value.trim(), source = code.value;
    const fail = (msg) => { err.textContent = msg; err.style.display = ''; };
    if (!n) { fail('Give the script a name'); return; }
    if (n !== name && userScripts()[n]) { fail('There is already a script with this name'); return; }
    // the script is loaded once in a worker before it is kept, so a broken one is caught here
    saving = true;
    const w = new ScriptWorker(source);
    try { await w.load(); } catch (e) { fail(e.message); return; } finally { w.dispose(); saving = false; }
    try { saveUserScript(n, source, name); } catch (_) { fail('Could not save (storage disabled)'); return; }
    m.close();
    app.toast(`Saved script “${n}”`);
    if (andRun) runScript(roll, userRunner(n, source));
  };
  const m = modal({
    title: name ? 'Edit script' : 'New script', width: 760,
    body: [h('div.row', h('span', { style: { width: '60px' } }, 'Name'), nameInp), code, err, apiReference()],
    buttons: [
      { label: 'Cancel' },
      { label: 'Save', fn: () => { save(false); return false; } },
      { label: 'Save and run', primary: true, fn: () => { save(true); return false; } },
    ],
  });
  m.el.classList.add('rs-editor');
  code.focus();
  code.setSelectionRange(0, 0);
  code.scrollTop = 0;
}

// ------------------------------------------------------------------------------ files
const fileName = (n) => n.replace(/[\\/:*?"<>|]+/g, '_').trim() || 'script';

function exportScript(app, s) { (app.exportSink || downloadBlob)(new TextEncoder().encode(s.source), `${fileName(s.name)}.js`, 'text/javascript'); }

function importScript(roll) {
  const app = roll.app;
  const inp = h('input', { type: 'file', accept: '.js,.mjs,text/javascript', style: { display: 'none' } });
  inp.addEventListener('change', async () => {
    const f = inp.files[0];
    inp.remove();
    if (!f) return;
    const source = await f.text();
    const w = new ScriptWorker(source);
    let info;
    try { info = await w.load(); } catch (e) { alertBox('Import script', e.message); return; } finally { w.dispose(); }
    const name = freeName(info.name || f.name.replace(/\.m?js$/i, '') || 'Script');
    try { saveUserScript(name, source); } catch (_) { app.toast('Could not save (storage disabled)'); return; }
    app.toast(`Imported script “${name}”`);
  });
  document.body.append(inp);
  inp.click();
  setTimeout(() => inp.remove(), 60000);
}

async function removeScript(app, name) {
  if (!(await confirmBox('Delete script', `Delete the script “${name}”?`, 'Delete'))) return;
  try { deleteUserScript(name); } catch (_) { app.toast('Could not save (storage disabled)'); return; }
  app.toast(`Deleted script “${name}”`);
}
