// Piano roll scripts in the app: the user's scripts (kept in this browser next to the user presets), the Worker that
// runs a user script, and the session behind the script dialog: results are written live without undo entries,
// Cancel puts the original notes back, OK writes the result again as exactly one undo step.
import { FACTORY_SCRIPTS } from '../core/roll-scripts-factory.js';
import { execute, finish, normalizeParams, scriptInput, scriptInfo } from '../core/roll-scripts.js';
import { nextId, patternLength } from '../core/project.js';

export const RUN_TIMEOUT = 3000;          // ms a user script may take for one run (or to load)

// ------------------------------------------------------------------------------ the user's scripts
const KEY = 'stepwise.rollscripts';

// { [name]: { name, source, time } }
export function userScripts() {
  try { const o = JSON.parse(localStorage.getItem(KEY) || '{}'); return o && typeof o === 'object' && !Array.isArray(o) ? o : {}; } catch (_) { return {}; }
}
// throws when the browser does not let the page store anything
function writeAll(all) { localStorage.setItem(KEY, JSON.stringify(all)); }

export function saveUserScript(name, source, previous = null) {
  const all = userScripts();
  if (previous && previous !== name) delete all[previous];
  all[name] = { name, source, time: Date.now() };
  writeAll(all);
}
export function deleteUserScript(name) { const all = userScripts(); delete all[name]; writeAll(all); }
export const userScriptList = () => Object.values(userScripts()).filter((s) => s && typeof s.name === 'string' && typeof s.source === 'string').sort((a, b) => a.name.localeCompare(b.name));

// a free name: "Name", "Name (2)", "Name (3)" …
export function freeName(name) {
  const all = userScripts();
  if (!all[name]) return name;
  for (let i = 2; ; i++) if (!all[`${name} (${i})`]) return `${name} (${i})`;
}

// ------------------------------------------------------------------------------ running
// One Worker per user script. Every call answers with a promise; a call that takes longer than RUN_TIMEOUT ends the
// worker (an endless loop cannot hang the page) and the next call starts a new one.
export class ScriptWorker {
  constructor(source) { this.source = source; this.worker = null; this.seq = 0; this.calls = new Map(); this.info = null; }

  _start() {
    this.worker = new Worker(new URL('../worker/roll-script-worker.js', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e) => {
      const m = e.data, c = this.calls.get(m.id);
      if (!c) return;
      this.calls.delete(m.id); clearTimeout(c.timer);
      c.resolve(m);
    };
    this.worker.onerror = (e) => { e.preventDefault(); this._kill(`Script error: ${e.message || 'the script worker stopped'}`); };
  }

  _kill(error) {
    if (this.worker) this.worker.terminate();
    this.worker = null; this.loaded = false;
    for (const c of this.calls.values()) { clearTimeout(c.timer); c.resolve({ t: 'failed', ok: false, error }); }
    this.calls.clear();
  }

  _call(msg) {
    if (!this.worker) this._start();
    const id = ++this.seq;
    return new Promise((resolve) => {
      const timer = setTimeout(() => this._kill(`The script did not finish in ${RUN_TIMEOUT / 1000} seconds (an endless loop?)`), RUN_TIMEOUT);
      this.calls.set(id, { resolve, timer });
      this.worker.postMessage({ ...msg, id });
    });
  }

  // -> { name, description, params }; throws with the reason the script cannot be used
  async load() {
    const r = await this._call({ t: 'load', source: this.source });
    if (r.t !== 'loaded') throw new Error(r.error);
    this.loaded = true;
    this.info = { ...r.info, params: normalizeParams(r.info.params) };   // checked again on this side
    return this.info;
  }

  // -> { ok, notes } (notes as the script returned them, see finish) or { ok: false, error }
  async run(input, values) {
    if (!this.loaded) { try { await this.load(); } catch (e) { return { ok: false, error: e.message }; } }
    const r = await this._call({ t: 'run', input, values });
    return r.t === 'result' ? { ok: !!r.ok, notes: r.notes, error: r.error } : { ok: false, error: r.error };
  }

  dispose() { this._kill('The script was closed'); }
}

// The same small interface for both kinds: load() -> info, run(input, values) -> raw result, dispose().
export function factoryRunner(def) {
  return { key: `factory:${def.id}`, name: def.name, load: async () => scriptInfo(def), run: async (input, values) => execute(def, input, values), dispose() {} };
}
export function userRunner(name, source) {
  const w = new ScriptWorker(source);
  return { key: `user:${name}`, name, load: () => w.load(), run: (input, values) => w.run(input, values), dispose: () => w.dispose() };
}
export const factoryScripts = () => FACTORY_SCRIPTS;

// ------------------------------------------------------------------------------ the dialog session
const clone = (x) => JSON.parse(JSON.stringify(x));
const byTime = (a, b) => a.s - b.s || a.k - b.k;

// Runs a script on notes `ids` of channel `chId` in the current pattern. preview() writes results without undo
// entries, cancel() puts the original notes back, commit() writes the final result as one undo step.
export class ScriptSession {
  constructor(store, chId, ids, runner, { scale, selection }) {
    this.store = store; this.chId = chId; this.runner = runner;
    const pat = store.pattern;
    this.patId = pat.id;
    this.orig = pat.notes[chId] ? clone(pat.notes[chId]) : null;
    const set = new Set(ids);
    const target = (this.orig || []).filter((n) => set.has(n.id));
    this.ids = target.map((n) => n.id);
    this.input = scriptInput({ notes: target, timeSig: store.project.timeSig, scale, patternLength: patternLength(store.project, pat), selection });
    this.cache = null;               // { key, result } of the last run
    this.changed = false;            // the project shows a preview
  }

  async result(values) {
    const key = JSON.stringify(values);
    if (this.cache && this.cache.key === key) return this.cache.result;
    const raw = await this.runner.run(this.input, values);
    const result = raw.ok ? finish(raw.notes, this.ids) : { ok: false, error: raw.error || 'Script error' };
    this.cache = { key, result };
    return result;
  }

  // the channel's notes = the untouched ones + the script's; new notes get ids here
  _write(notes, label, undo) {
    const keep = new Set(this.ids);
    return this.store.edit(label, (p) => {
      const pat = p.patterns[this.patId];
      if (!pat) return [];
      const made = notes.map((n) => ({ ...n, id: n.id ?? nextId(p) }));
      pat.notes[this.chId] = (this.orig || []).filter((n) => !keep.has(n.id)).map((n) => ({ ...n })).concat(made).sort(byTime);
      return made.map((n) => n.id);
    }, [['patterns', this.patId]], undo ? {} : { noUndo: true });
  }

  _restore() {
    if (!this.changed) return;
    this.changed = false;
    this.store.edit('Script preview', (p) => {
      const pat = p.patterns[this.patId];
      if (!pat) return;
      if (this.orig) pat.notes[this.chId] = clone(this.orig); else delete pat.notes[this.chId];
    }, [['patterns', this.patId]], { noUndo: true });
  }

  // -> { ok, error? }; an error leaves the original notes in place
  async preview(values) {
    const r = await this.result(values);
    if (!r.ok) { this._restore(); return r; }
    this._write(r.notes, 'Script preview', false);
    this.changed = true;
    return r;
  }

  cancel() { this._restore(); this.runner.dispose(); }

  // -> { ok, ids } with the ids of the script's notes, or { ok: false, error } (nothing changed)
  async commit(values) {
    const r = await this.result(values);
    this._restore();
    this.runner.dispose();
    if (!r.ok) return r;
    const ids = this._write(r.notes, `Script: ${this.runner.name}`, true);
    return { ok: true, ids };
  }
}
