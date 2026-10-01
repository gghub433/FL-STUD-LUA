// Application state: the authoritative project, undo/redo history, selection, and the bridge to
// the engine. UI code mutates the project only through store.edit()/setParam() so that every
// change is (a) undoable, (b) mirrored to the audio thread and (c) announced on the bus.
import { Bus } from './bus.js';
import { createProject, normalize, clone, currentArrangement } from '../core/project.js';
import { parseAddr, paramDef, getParam, setParam as setProjectParam, paramLabel } from '../core/addr.js';
import { clampParam } from '../core/schema.js';
import { idbPut, idbGet, idbAll, idbDelete } from '../host/idb.js';

const MAX_HISTORY = 300;
const COALESCE_MS = 700;
const AUTOSAVE_MS = 4000;
const BACKUP_EVERY_MS = 120000;
const MAX_BACKUPS = 12;

export function getPath(obj, path) {
  let o = obj;
  for (const k of path) { if (o == null) return undefined; o = o[k]; }
  return o;
}

export class Store {
  constructor(host, bank) {
    this.host = host;
    this.bank = bank;
    this.bus = new Bus();
    this.project = createProject();
    this.history = [];       // [{ label, time, json }] snapshots taken BEFORE each edit
    this.future = [];        // redo stack of { label, json }
    this.lastKey = null;
    this.lastTime = 0;
    this.selected = null;    // selected channel id
    this.dirty = false;
    this.fileName = null;
    this.saveTimer = null;
    this.lastBackup = 0;
    this.changeCounter = 0;
  }

  // ---------------------------------------------------------------- lookups
  channel(id) { return this.project.channels.find((c) => c.id === id) || null; }
  get pattern() { return this.project.patterns[this.project.currentPattern]; }
  get arrangement() { return currentArrangement(this.project); }

  // ---------------------------------------------------------------- loading
  async replaceProject(p, { keepHistory = false, fileName = null } = {}) {
    this.project = p;
    this.fileName = fileName;
    if (!keepHistory) { this.history = []; this.future = []; }
    this.lastKey = null;
    this.selected = p.channels.length ? p.channels[0].id : null;
    await this.bank.ensureProject(p);
    this.host.send({ t: 'stop' });
    this.host.send({ t: 'init', project: p });
    this.dirty = false;
    this.bus.emit('replaced', p);
    this.bus.emit('project', p);
    this.bus.emit('selection', this.selected);
  }

  async loadJSON(text) {
    const p = normalize(JSON.parse(text));
    await this.replaceProject(p);
    return p;
  }

  // ---------------------------------------------------------------- undo
  _snap() { return JSON.stringify(this.project); }

  _push(label, key) {
    const now = performance.now();
    // keys starting with 'gesture:' belong to one pointer drag and never time out
    if (key && key === this.lastKey && (key.startsWith('gesture:') || now - this.lastTime < COALESCE_MS)) { this.lastTime = now; return; }
    this.lastKey = key || null;
    this.lastTime = now;
    this.history.push({ label, time: Date.now(), json: this._snap() });
    if (this.history.length > MAX_HISTORY) this.history.shift();
    this.future = [];
    this.bus.emit('history');
  }

  async _restore(json) {
    const p = JSON.parse(json);
    this.project = p;
    await this.bank.ensureProject(p);
    this.host.send({ t: 'init', project: p });
    if (this.selected != null && !this.channel(this.selected)) this.selected = p.channels[0] ? p.channels[0].id : null;
    this.markDirty();
    this.bus.emit('project', p);
    this.bus.emit('selection', this.selected);
  }

  async undo() {
    const h = this.history.pop();
    if (!h) return false;
    this.future.push({ label: h.label, json: this._snap() });
    this.lastKey = null;
    await this._restore(h.json);
    this.bus.emit('history');
    this.bus.emit('toast', `Undo: ${h.label}`);
    return true;
  }

  async redo() {
    const f = this.future.pop();
    if (!f) return false;
    this.history.push({ label: f.label, time: Date.now(), json: this._snap() });
    this.lastKey = null;
    await this._restore(f.json);
    this.bus.emit('history');
    this.bus.emit('toast', `Redo: ${f.label}`);
    return true;
  }

  // Jump to the state before history entry `index` (everything after it moves to the redo stack).
  async undoTo(index) {
    while (this.history.length > index + 1) {
      const h = this.history.pop();
      this.future.push({ label: h.label, json: this._snap() });
      this.project = JSON.parse(h.json);
    }
    const h = this.history.pop();
    if (!h) return;
    this.future.push({ label: h.label, json: this._snap() });
    this.lastKey = null;
    await this._restore(h.json);
    this.bus.emit('history');
  }

  // ---------------------------------------------------------------- edits
  // fn mutates the project; `paths` lists the sections that changed (sent to the audio thread).
  edit(label, fn, paths, opts = {}) {
    if (!opts.noUndo) this._push(label, opts.coalesce);
    const r = fn(this.project);
    this.touch(paths, label);
    return r;
  }

  touch(paths, label) {
    for (const path of paths) {
      const value = getPath(this.project, path);
      this.host.send({ t: 'set', path, value });
    }
    this.markDirty();
    this.bus.emit('change', { paths, label });
  }

  // direct state change with no undo entry (selection of the current pattern, etc.)
  setState(path, value) {
    let o = this.project;
    for (let i = 0; i < path.length - 1; i++) o = o[path[i]];
    o[path[path.length - 1]] = value;
    this.host.send({ t: 'set', path, value });
    this.markDirty();
    this.bus.emit('change', { paths: [path], label: 'state' });
  }

  setParam(addr, value, opts = {}) {
    const def = paramDef(this.project, addr);
    if (!def) return undefined;
    const v = clampParam(def, value);
    if (getParam(this.project, addr) === v && !opts.force) return v;
    if (!opts.noUndo) this._push(`Change ${paramLabel(this.project, addr)}`, opts.coalesce || `param:${addr}`);
    setProjectParam(this.project, addr, v);
    this.host.send({ t: 'param', addr, value: v });
    this.markDirty();
    this.bus.emit('param', addr, v);
    return v;
  }

  // value changed by the engine (automation playback): update the model without undo/echo
  engineParam(addr, v) {
    setProjectParam(this.project, addr, v);
    this.bus.emit('param', addr, v);
  }

  getParam(addr) { return getParam(this.project, addr); }

  select(chId) {
    if (this.selected === chId) return;
    this.selected = chId;
    this.bus.emit('selection', chId);
  }

  // ---------------------------------------------------------------- persistence
  markDirty() {
    this.dirty = true;
    this.changeCounter++;
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.autosave(), AUTOSAVE_MS);
  }

  async autosave() {
    if (!this.dirty) return;
    const json = this._snap();
    await idbPut('kv', 'autosave', { json, time: Date.now(), title: this.project.meta.title });
    const now = Date.now();
    if (now - this.lastBackup > BACKUP_EVERY_MS) {
      this.lastBackup = now;
      await idbPut('backups', `bk-${now}`, { json, time: now, title: this.project.meta.title });
      const all = (await idbAll('backups')).map(([k]) => k).sort();
      for (const k of all.slice(0, Math.max(0, all.length - MAX_BACKUPS))) await idbDelete('backups', k);
    }
    this.bus.emit('autosaved', now);
  }

  async loadAutosave() {
    const rec = await idbGet('kv', 'autosave');
    if (!rec || !rec.json) return null;
    try { return normalize(JSON.parse(rec.json)); } catch (_) { return null; }
  }

  async saveProjectLocal(name) {
    const title = name || this.project.meta.title || 'Untitled';
    this.project.meta.title = title;
    await idbPut('projects', title, { json: this._snap(), time: Date.now(), title });
    this.fileName = title;
    this.dirty = false;
    this.bus.emit('saved', title);
    return title;
  }

  serialize() { return JSON.stringify(this.project); }
}

export { clone };
