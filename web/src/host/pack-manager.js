// Installed plugin packs: stored in this browser (IndexedDB), evaluated in the page and in the AudioWorklet at start-up,
// handed to the export worker as source text. See core/packs.js for the pack format.
import * as core from '../core/packs.js';
import { idbGet, idbPut } from './idb.js';

export const MAX_PACK_BYTES = 2 * 1024 * 1024;
const KEY = 'packs';
const mem = {};                                      // used when IndexedDB is not available

export async function sha256(text) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export class PackManager {
  constructor(app) {
    this.app = app;
    this.records = new Map();                        // id -> record { id, name, version, …, source }
    this.failed = new Map();                         // id -> error text of packs that did not load at start-up
    this.pendingRemoval = new Set();
    core.installPackHook(globalThis);                // a pack calls globalThis.__flluaRegisterPack when it is imported
    // a restarted audio engine needs the packs again, before its first project arrives
    if (app.host && app.host.moduleHooks) app.host.moduleHooks.push((ctx) => this._addModules(ctx));
  }

  async _read() { const r = await idbGet('kv', KEY); return r && typeof r === 'object' ? r : { ...mem }; }
  async _write(all) { Object.assign(mem, all); for (const k of Object.keys(mem)) if (!(k in all)) delete mem[k]; await idbPut('kv', KEY, all); }

  // evaluates the source in this page and in the worklet; resolves to the pack info (or throws, leaving nothing registered)
  async _activate(source) {
    const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
    let info = null;
    try {
      core.resetLastPack();
      await import(url);
      info = core.lastPack;
      if (!info) throw new Error('The file is not a plugin pack (it did not register anything)');
      const host = this.app.host;
      if (host && host.ready && host.ctx && host.ctx.audioWorklet) await host.ctx.audioWorklet.addModule(url);
      return info;
    } catch (err) {
      if (info) core.unregisterPack(info.id);
      throw err;
    } finally { URL.revokeObjectURL(url); }
  }

  async _addModules(ctx) {
    for (const { source } of this.sources()) {
      const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
      try { await ctx.audioWorklet.addModule(url); } finally { URL.revokeObjectURL(url); }
    }
  }

  // start-up: bring every installed pack online before any project is loaded
  async loadAll() {
    const all = await this._read();
    for (const rec of Object.values(all)) {
      this.records.set(rec.id, rec);
      try { await this._activate(rec.source); } catch (err) { this.failed.set(rec.id, String(err.message || err)); console.warn(`[packs] ${rec.id}:`, err); }
    }
    if (this.failed.size) this.app.toast && this.app.toast(`Plugin pack failed to load: ${[...this.failed.keys()].join(', ')}`);
    this.app.store && this.app.store.bus.emit('plugins');
  }

  list() { return [...this.records.values()].map(({ source, ...rest }) => rest); }
  get(id) { return this.records.get(id) || null; }
  has(id) { return this.records.has(id) && !this.pendingRemoval.has(id); }
  sources() { return [...this.records.values()].filter((r) => !this.pendingRemoval.has(r.id) && !this.failed.has(r.id)).map((r) => ({ id: r.id, source: r.source })); }

  // source: the text of a pack file. from: where it came from (shown in the store). Returns the stored record.
  async install(source, { from = 'file', sha = null } = {}) {
    if (typeof source !== 'string' || !source.trim()) throw new Error('The file is empty');
    if (source.length > MAX_PACK_BYTES) throw new Error('The pack is larger than 2 MB');
    const digest = await sha256(source);
    if (sha && sha !== digest) throw new Error('The downloaded file does not match the checksum of the catalog: it was not installed');
    const info = await this._activate(source);
    const rec = { ...info, sha256: digest, source, from, time: Date.now() };
    this.records.set(rec.id, rec);
    this.failed.delete(rec.id);
    this.pendingRemoval.delete(rec.id);
    const all = await this._read();
    all[rec.id] = rec;
    await this._write(all);
    this.app.store.bus.emit('plugins'); this.app.store.bus.emit('presets');
    return rec;
  }

  // The worklet cannot forget a module, so removal completes at the next reload; the pack is gone from storage right away.
  async remove(id) {
    if (!this.records.has(id)) return false;
    const all = await this._read();
    delete all[id];
    await this._write(all);
    this.pendingRemoval.add(id);
    this.app.store.bus.emit('plugins');
    return true;
  }

  // how many channels / effects of the open project come from this pack
  usage(id) {
    const p = this.app.store.project;
    const mine = (t) => core.packOfType(t) === id;
    let n = p.channels.filter((c) => mine(c.type)).length;
    for (const t of p.mixer.tracks) for (const f of t.fx) if (f && mine(f.type)) n++;
    return n;
  }
}
