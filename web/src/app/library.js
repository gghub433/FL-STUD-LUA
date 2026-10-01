// The user's library: things saved in this browser that the Browser panel lists. Each kind is one record
// in the IndexedDB "kv" store (`lib:<kind>` -> { [name]: { name, time, data } }), with an in-memory fallback
// when storage is unavailable. Projects and backups keep their own stores (see store.js).
import { idbGet, idbPut, idbAll, idbDelete } from '../host/idb.js';

export const KINDS = ['channel', 'mixer', 'score', 'template', 'rendered', 'recorded'];
const mem = new Map();

async function readAll(kind) {
  const rec = await idbGet('kv', `lib:${kind}`);
  const base = rec && typeof rec === 'object' ? rec : mem.get(kind) || {};
  return base;
}
async function writeAll(kind, obj) {
  mem.set(kind, obj);
  await idbPut('kv', `lib:${kind}`, obj);
}

export class Library {
  constructor(bus) { this.bus = bus; }

  async list(kind) {
    const all = await readAll(kind);
    return Object.values(all).sort((a, b) => (b.time || 0) - (a.time || 0));
  }

  async get(kind, name) { return (await readAll(kind))[name] || null; }

  async save(kind, name, data) {
    const all = await readAll(kind);
    all[name] = { name, time: Date.now(), data: JSON.parse(JSON.stringify(data)) };
    await writeAll(kind, all);
    this.bus.emit('library', kind);
    return all[name];
  }

  async remove(kind, name) {
    const all = await readAll(kind);
    delete all[name];
    await writeAll(kind, all);
    this.bus.emit('library', kind);
  }

  async rename(kind, name, to) {
    const all = await readAll(kind);
    if (!all[name] || all[to]) return false;
    all[to] = { ...all[name], name: to };
    delete all[name];
    await writeAll(kind, all);
    this.bus.emit('library', kind);
    return true;
  }

  // saved projects ("Save in browser") and automatic backups
  async projects() { return (await idbAll('projects')).map(([key, v]) => ({ key, name: v.title || key, time: v.time || 0, json: v.json })).sort((a, b) => b.time - a.time); }
  async deleteProject(key) { await idbDelete('projects', key); this.bus.emit('library', 'project'); }
  async backups() { return (await idbAll('backups')).map(([key, v]) => ({ key, name: v.title || 'Untitled', time: v.time || 0, json: v.json })).sort((a, b) => b.time - a.time); }
  async autosave() { const v = await idbGet('kv', 'autosave'); return v && v.json ? { key: 'autosave', name: v.title || 'Untitled', time: v.time || 0, json: v.json } : null; }
}

// ---- helpers that turn live project data into library entries and back --------------------------
export const channelSnapshot = (ch) => { const c = JSON.parse(JSON.stringify(ch)); delete c.id; delete c.mixer; return c; };
export const mixerSnapshot = (track) => JSON.parse(JSON.stringify({ vol: track.vol, pan: track.pan, sep: track.sep, delay: track.delay, eqLowG: track.eqLowG, eqLowF: track.eqLowF, eqMidG: track.eqMidG, eqMidF: track.eqMidF, eqMidQ: track.eqMidQ, eqHighG: track.eqHighG, eqHighF: track.eqHighF, fx: track.fx }));
export const scoreSnapshot = (notes) => { const s0 = notes.length ? Math.min(...notes.map((n) => n.s)) : 0; return notes.map((n) => { const { id, ...rest } = n; return { ...rest, s: n.s - s0 }; }); };
