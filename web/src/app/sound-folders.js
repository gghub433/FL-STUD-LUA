// My sounds (Browser): folders on the person's disk, so downloaded sample packs, one-shots and loops can be previewed
// and used like in the Browser of FL Studio. A sound becomes part of the project only when it is used: it is then
// decoded into the sample bank like any loaded file (kept in IndexedDB, written into the .zip), so the project keeps
// working without the folder.
//   desktop: folders from a folder dialog or dropped on the Browser; the main process lists them and reads the audio
//            files inside them, nothing else (desktop/sound-folders.js)
//   Chrome / Edge: folders picked with the File System Access API; the handles are kept in IndexedDB and the
//            permission to read them is asked again after a restart (like the cloud backup folder)
//   other browsers: picked files, and files or folders dropped on the Browser, for this session
import { idbGet, idbPut } from '../host/idb.js';
import { decodeAudioBytes } from '../host/sample-bank.js';
import { cleanListing, soundName, isAudioDrop, SoundIndex, AUDIO_ACCEPT } from '../core/sound-files.js';

const KEY = 'sound-folders';           // IndexedDB "kv": [{ id, name, handle }]
const PREVIEWS = 6;                    // decoded sounds kept for preview and quick use
const RAW_MAX = 50000;                 // entries read from one folder at most
const newId = (p) => `${p}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const clean = (err) => new Error(String((err && err.message) || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
const keyOf = (id, rel) => `${id}\n${rel}`;

// File System Access handles and the older entries API (folders dropped where the first one is missing)
async function dirAt(handle, rel) { let d = handle; for (const part of rel.split('/').filter(Boolean)) d = await d.getDirectoryHandle(part); return d; }
async function fileAt(handle, rel) { const parts = rel.split('/'); const name = parts.pop(); return (await dirAt(handle, parts.join('/'))).getFileHandle(name); }
const readEntries = (dir) => new Promise((resolve, reject) => {
  const reader = dir.createReader(), out = [];
  const next = () => reader.readEntries((list) => { if (!list.length || out.length >= RAW_MAX) resolve(out); else { out.push(...list); next(); } }, reject);
  next();
});
const entryAt = (root, rel, dir) => new Promise((resolve, reject) => (dir ? root.getDirectory : root.getFile).call(root, rel, {}, resolve, reject));
const entryFile = (e) => new Promise((resolve, reject) => e.file(resolve, reject));

export class SoundFolders {
  constructor(app) {
    this.app = app;
    this.bus = app.store.bus;
    this.desk = (window.flluaDesktop && window.flluaDesktop.sounds) || null;
    this.roots = [];          // { id, name, kind: 'desk' | 'handle' | 'entry' | 'files', session?, path?, missing?, handle?, entry?, files? }
    this.lists = new Map();   // folder key -> Promise<[{ name, dir }]>
    this.decoded = new Map(); // file key -> Promise<{ name, rate, channels, length }>, the last few
    this.used = new Map();    // file key -> { id, name } in the sample bank
    this.index = null;
    this.ready = this.load();
  }

  get canPickFolder() { return !!this.desk || typeof window.showDirectoryPicker === 'function'; }
  root(id) { return this.roots.find((r) => r.id === id) || null; }

  async load() {
    const session = this.roots.filter((r) => r.session);
    let saved = [];
    if (this.desk) saved = (await this.desk.folders().catch(() => [])).map((f) => ({ id: f.id, name: f.name, path: f.path, missing: !!f.missing, kind: 'desk' }));
    else {
      const list = await idbGet('kv', KEY).catch(() => null);
      if (Array.isArray(list)) saved = list.filter((r) => r && r.id && r.handle).map((r) => ({ id: r.id, name: r.name || r.handle.name, handle: r.handle, kind: 'handle' }));
    }
    this.roots = [...saved, ...session];
    this.changed();
  }

  save() { return idbPut('kv', KEY, this.roots.filter((r) => r.kind === 'handle').map(({ id, name, handle }) => ({ id, name, handle }))); }

  // listings, decoded sounds and the index start again (for one folder, or for all)
  changed(rootId = null) {
    for (const m of [this.lists, this.decoded, this.used]) for (const k of [...m.keys()]) if (!rootId || k.startsWith(`${rootId}\n`)) m.delete(k);
    if (this.index) { this.index.cancel(); this.index = null; }
    this.bus.emit('sounds', rootId);
  }

  refresh(rootId = null) { return this.desk && !rootId ? this.load() : this.changed(rootId); }

  // ------------------------------------------------------------------ adding and removing folders
  // -> the added folder (or the picked files), null when cancelled
  async addFolder() {
    if (this.desk) { const added = await this.desk.add(); await this.load(); return added && added.length ? this.root(added[0].id) : null; }
    if (typeof window.showDirectoryPicker !== 'function') return this.pickFiles();
    let handle;
    try { handle = await window.showDirectoryPicker({ id: 'fllua-sounds', mode: 'read' }); }
    catch (err) { if (err && err.name === 'AbortError') return null; throw err; }
    return this.addHandle(handle);
  }

  async addHandle(handle) {
    for (const r of this.roots) if (r.kind === 'handle' && (await r.handle.isSameEntry(handle).catch(() => false))) return r;
    const r = { id: newId('h'), name: handle.name, kind: 'handle', handle };
    this.roots.splice(this.roots.filter((x) => !x.session).length, 0, r);           // before the session-only entries
    await this.save();
    this.changed();
    return r;
  }

  // where folders cannot be opened: files picked in a file dialog, for this session
  pickFiles() {
    return new Promise((resolve) => {
      const inp = document.createElement('input');
      inp.type = 'file'; inp.multiple = true; inp.accept = AUDIO_ACCEPT; inp.style.display = 'none';
      inp.addEventListener('change', () => { const r = this.addFiles([...inp.files]); inp.remove(); resolve(r); });
      inp.addEventListener('cancel', () => { inp.remove(); resolve(null); });
      document.body.append(inp); inp.click();
    });
  }

  addFiles(files) {
    const audio = [...files].filter(isAudioDrop);
    if (!audio.length) return null;
    let r = this.roots.find((x) => x.kind === 'files');
    if (!r) { r = { id: 'picked', name: 'Picked files', kind: 'files', session: true, files: new Map() }; this.roots.push(r); }
    for (const f of audio) {
      let name = f.name;
      for (let n = 2; r.files.has(name) && r.files.get(name) !== f; n++) name = f.name.replace(/(\.[^.]+)?$/, ` (${n})$1`);
      r.files.set(name, f);
    }
    this.changed(r.id);
    return r;
  }

  // Folders and audio files dropped on the Browser. Everything is taken from the DataTransfer before the first await
  // (the browser empties it after the event). -> { folders: [root], files: number }
  addDropped(dt) {
    const fileList = [...(dt.files || [])];
    const got = [...(dt.items || [])].filter((i) => i.kind === 'file').map((i, k) => ({
      file: i.getAsFile() || fileList[k] || null,
      entry: i.webkitGetAsEntry ? i.webkitGetAsEntry() : null,
      handle: !this.desk && i.getAsFileSystemHandle ? i.getAsFileSystemHandle() : null,
    }));
    if (!got.length) for (const f of fileList) got.push({ file: f, entry: null, handle: null });
    return (async () => {
      const folders = [], files = [];
      let deskAdded = false;
      for (const g of got) {
        const isDir = !!(g.entry && g.entry.isDirectory);
        if (this.desk) {
          if (isDir && g.file) { const f = await this.desk.addDropped(g.file).catch(() => null); if (f) { folders.push(f.id); deskAdded = true; } }
          else if (g.file) files.push(g.file);
          continue;
        }
        const h = g.handle ? await g.handle.catch(() => null) : null;
        if (h && h.kind === 'directory') folders.push((await this.addHandle(h)).id);
        else if (isDir) folders.push(this.addEntry(g.entry).id);
        else if (g.file) files.push(g.file);
      }
      if (deskAdded) await this.load();
      const audio = files.filter(isAudioDrop);
      if (audio.length) this.addFiles(audio);
      return { folders: [...new Set(folders)].map((id) => this.root(id)).filter(Boolean), files: audio.length };
    })();
  }

  addEntry(entry) {
    const r = { id: newId('e'), name: entry.name, kind: 'entry', session: true, entry };
    this.roots.push(r);
    this.changed();
    return r;
  }

  async remove(id) {
    const r = this.root(id);
    if (!r) return;
    if (r.kind === 'desk') await this.desk.remove(id);
    this.roots = this.roots.filter((x) => x !== r);
    if (r.kind === 'handle') await this.save();
    this.changed();
  }

  show(id, rel = '') { if (this.desk) this.desk.show(id, rel).catch((err) => this.app.toast(clean(err).message)); }

  // ------------------------------------------------------------------ permission (Chrome / Edge)
  async access(r, ask = false) {
    if (r.kind !== 'handle' || !r.handle.queryPermission) return;
    let st = await r.handle.queryPermission({ mode: 'read' });
    if (st !== 'granted' && ask) st = await r.handle.requestPermission({ mode: 'read' }).catch(() => 'denied');
    if (st !== 'granted') throw Object.assign(new Error(`FL LUA may not read “${r.name}” yet`), { code: 'permission' });
  }

  // asks for the permission again; call it from a click, the browser shows its question only then
  async allow(id) {
    const r = this.root(id);
    if (!r || r.kind !== 'handle' || !r.handle.queryPermission) return !!r;
    if ((await r.handle.queryPermission({ mode: 'read' })) === 'granted') return true;
    try { await this.access(r, true); } catch (_) { return false; }
    this.changed(id);
    return true;
  }

  // ------------------------------------------------------------------ reading
  // -> [{ name, dir }]: subfolders and audio files, sorted; one listing per folder until refreshed
  list(id, rel = '') {
    const key = keyOf(id, rel);
    let p = this.lists.get(key);
    if (!p) {
      p = this.listRaw(this.root(id), rel).then((raw) => cleanListing(raw));
      this.lists.set(key, p);
      p.catch(() => { if (this.lists.get(key) === p) this.lists.delete(key); });   // errors are not remembered
    }
    return p;
  }

  async listRaw(r, rel) {
    if (!r) throw new Error('This folder is not in My sounds any more');
    if (r.kind === 'desk') { try { return await this.desk.list(r.id, rel); } catch (err) { throw clean(err); } }
    if (r.kind === 'files') return rel ? [] : [...r.files.keys()].map((name) => ({ name, dir: false }));
    if (r.kind === 'entry') return (await readEntries(rel ? await entryAt(r.entry, rel, true) : r.entry)).map((e) => ({ name: e.name, dir: e.isDirectory }));
    await this.access(r);
    const out = [];
    for await (const h of (await dirAt(r.handle, rel)).values()) { out.push({ name: h.name, dir: h.kind === 'directory' }); if (out.length >= RAW_MAX) break; }
    return out;
  }

  // -> ArrayBuffer of a file
  async bytes(id, rel) {
    const r = this.root(id);
    if (!r) throw new Error('This folder is not in My sounds any more');
    if (r.kind === 'desk') {
      let u;
      try { u = await this.desk.read(id, rel); } catch (err) { throw clean(err); }
      return u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength);
    }
    if (r.kind === 'files') { const f = r.files.get(rel); if (!f) throw new Error('That file is not available any more'); return f.arrayBuffer(); }
    if (r.kind === 'entry') return (await entryFile(await entryAt(r.entry, rel, false))).arrayBuffer();
    await this.access(r);
    return (await (await fileAt(r.handle, rel)).getFile()).arrayBuffer();
  }

  // -> { name, rate, channels, length }; a few recently decoded sounds are kept, so a click then a double-click decodes once
  decode(id, rel) {
    const key = keyOf(id, rel);
    let p = this.decoded.get(key);
    if (p) { this.decoded.delete(key); this.decoded.set(key, p); return p; }
    p = (async () => {
      const { rate, channels } = await decodeAudioBytes(this.app.host.ctx, await this.bytes(id, rel));
      if (!channels.length || !channels[0].length) throw new Error('The file has no sound');
      return { name: soundName(rel), rate, channels, length: channels[0].length };
    })();
    this.decoded.set(key, p);
    p.catch(() => { if (this.decoded.get(key) === p) this.decoded.delete(key); });
    while (this.decoded.size > PREVIEWS) this.decoded.delete(this.decoded.keys().next().value);
    return p;
  }

  // A sound from My sounds goes into the sample bank like any loaded file: stored in IndexedDB and saved in the .zip,
  // so the project does not need the folder any more. -> { id, name }
  async use(id, rel) {
    const key = keyOf(id, rel), was = this.used.get(key);
    if (was && this.app.bank.has(was.id)) return was;
    const d = await this.decode(id, rel);
    const e = this.app.bank.addPCM(d.name, d.rate, d.channels);
    const s = { id: e.id, name: e.name };
    this.used.set(key, s);
    return s;
  }

  // ------------------------------------------------------------------ search
  // the name index of every added folder, built in the background on the first search (capped, see SoundIndex)
  searchIndex() {
    if (!this.index) {
      const ix = this.index = new SoundIndex();
      let last = 0;
      const progress = () => { const now = performance.now(); if (ix.done || now - last > 250) { last = now; if (this.index === ix) this.bus.emit('sounds-index', ix); } };
      ix.build(this.roots.filter((r) => !r.missing), (r, rel) => this.list(r.id, rel), { onProgress: progress });
    }
    return this.index;
  }
}

export function installSounds(app) {
  app.sounds = new SoundFolders(app);
  return app.sounds;
}
