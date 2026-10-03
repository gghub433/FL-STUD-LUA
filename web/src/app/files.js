// Project files on disk. Save (Ctrl+S) writes back to the file the project came from; Save as… picks a new one.
//   desktop app: native dialogs and file access through the preload bridge (window.flluaDesktop)
//   Chromium browsers: the File System Access API (the file handle is kept, so Ctrl+S writes in place)
//   other browsers: Save downloads the file
// A .fllua file is the project JSON, or (when the project uses recorded / imported samples) a ZIP with the
// samples inside, so a saved project always opens complete on another machine. Opening detects which one it is.
// MIDI files (.mid) are imported into the current project instead.
import { userSampleIds, projectToZip, projectFromZip } from './project-io.js';
import { normalize } from '../core/project.js';
import { readMidi } from '../core/midi-file.js';
import { importMidi } from '../core/midi-import.js';
import { idbGet, idbPut } from '../host/idb.js';
import { downloadBlob } from '../host/export/wav.js';
import { confirmBox } from '../ui/dialog.js';

const PROJECT_TYPES = [{ description: 'FL LUA project', accept: { 'application/x-fllua': ['.fllua'] } }];
const OPEN_TYPES = [{ description: 'FL LUA project, MIDI file or project ZIP', accept: { 'application/x-fllua': ['.fllua', '.zip', '.json', '.stepwise'], 'audio/midi': ['.mid', '.midi'] } }];
const RECENT_KEY = 'recent-files', MAX_RECENT = 10;
const isZip = (b) => b.length > 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 3 && b[3] === 4;
const baseName = (n) => n.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '');

export function installFiles(app) {
  const desk = window.flluaDesktop || null;
  const fsa = !desk && typeof window.showSaveFilePicker === 'function';
  const doc = app.doc = { name: null, path: null, handle: null };
  const store = app.store;

  // ---- title bar: "● name - FL LUA" while there are unsaved changes
  const title = () => {
    const name = doc.name || (store.dirty ? 'Untitled' : null);
    document.title = name ? `${store.dirty ? '● ' : ''}${name} - FL LUA` : 'FL LUA';
    if (desk) desk.setDocument({ dirty: !!store.dirty, name: doc.name || 'Untitled', path: doc.path });
  };
  store.bus.on('change', () => { if (store.dirty) title(); });
  store.bus.on('saved', title);
  store.bus.on('replaced', () => { doc.name = null; doc.path = null; doc.handle = null; title(); });

  const encode = (project) => (userSampleIds(project).some((id) => app.bank.get(id))
    ? projectToZip(project, app.bank)
    : new TextEncoder().encode(JSON.stringify(project)));

  async function load(bytes, name) {
    if (/\.midi?$/i.test(name)) return importMidiBytes(bytes, name);
    let project, restored = 0;
    if (isZip(bytes)) ({ project, restored } = await projectFromZip(bytes, app.bank));
    else project = normalize(JSON.parse(new TextDecoder().decode(bytes)));
    await store.replaceProject(project, { fileName: baseName(name) });
    app.toast(`Opened ${baseName(name)}${restored ? ` (${restored} sample${restored === 1 ? '' : 's'} restored)` : ''}`);
    return true;
  }

  async function importMidiBytes(bytes, name) {
    const midi = readMidi(bytes);
    const empty = !store.project.channels.length && !store.arrangement.clips.length;
    let made;
    store.edit(`Import MIDI ${baseName(name)}`, (p) => { made = importMidi(p, midi, { name: baseName(name), setTempo: empty }); }, [['channels'], ['patterns'], ['playlist'], ['mixer'], ['tempo'], ['timeSig'], ['currentPattern']]);
    await app.bank.ensureProject(store.project);
    store.bus.emit('project', store.project);
    app.toast(`Imported ${baseName(name)}: ${made.channels.length} channel${made.channels.length === 1 ? '' : 's'}${empty ? `, ${midi.tempo} BPM` : ''}`);
    return false;                                       // the project is still the same document
  }

  const confirmDiscard = async () => !store.dirty || !store.project.channels.length || confirmBox('Open project', 'Discard unsaved changes in the current project?', 'Discard');

  async function remember(entry) {
    try { await remember_(entry); } finally { files.recent().then((l) => { app.recentFiles = l; }).catch(() => {}); }
  }
  async function remember_(entry) {
    if (desk) { await desk.addRecent(entry.path); return; }
    if (!fsa || !entry.handle) return;
    try {
      const list = (await idbGet('kv', RECENT_KEY)) || [];
      const out = [entry];
      for (const e of list) if (!(await e.handle.isSameEntry(entry.handle)) && out.length < MAX_RECENT) out.push(e);
      await idbPut('kv', RECENT_KEY, out.map((e) => ({ name: e.name, handle: e.handle, time: e.time || Date.now() })));
    } catch (_) { /* storage unavailable */ }
  }

  async function write(bytes) {
    if (desk && doc.path) { await desk.write(doc.path, bytes); return true; }
    if (doc.handle) {
      if (doc.handle.queryPermission && (await doc.handle.queryPermission({ mode: 'readwrite' })) !== 'granted'
        && (await doc.handle.requestPermission({ mode: 'readwrite' })) !== 'granted') throw new Error('Permission to write the file was not given');
      const w = await doc.handle.createWritable();
      await w.write(bytes); await w.close();
      return true;
    }
    return false;
  }

  function markSaved(name) {
    store.fileName = name;
    store.dirty = false;
    store.bus.emit('saved', name);
  }

  const files = app.files = {
    get desktop() { return !!desk; },
    get canWriteInPlace() { return !!desk || fsa; },

    async open() {
      if (!(await confirmDiscard())) return false;
      if (desk) {
        const r = await desk.openDialog({ title: 'Open project', filters: [{ name: 'FL LUA project, MIDI', extensions: ['fllua', 'mid', 'midi', 'zip', 'json'] }] });
        return r ? files.openPath(r.path, true) : false;
      }
      if (fsa) {
        let handle;
        try { [handle] = await window.showOpenFilePicker({ types: OPEN_TYPES, excludeAcceptAllOption: false }); } catch (_) { return false; }  // cancelled
        return files.openHandle(handle, true);
      }
      return app.openFile();                                         // <input type=file>
    },

    async openPath(path, confirmed = false) {
      if (!confirmed && !/\.midi?$/i.test(path) && !(await confirmDiscard())) return false;
      const bytes = await desk.read(path);
      const isProject = await load(bytes, path);
      if (isProject) {
        if (/\.fllua$/i.test(path)) { doc.path = path; doc.name = baseName(path); }
        else doc.name = baseName(path);
        title();
        await remember({ path, name: doc.name });
      }
      return true;
    },

    async openHandle(handle, confirmed = false) {
      if (!confirmed && !/\.midi?$/i.test(handle.name) && !(await confirmDiscard())) return false;
      if (handle.queryPermission && (await handle.queryPermission({ mode: 'read' })) !== 'granted' && (await handle.requestPermission({ mode: 'read' })) !== 'granted') return false;
      const file = await handle.getFile();
      const isProject = await load(new Uint8Array(await file.arrayBuffer()), file.name);
      if (isProject) {
        doc.name = baseName(file.name);
        doc.handle = /\.fllua$/i.test(file.name) ? handle : null;
        title();
        if (doc.handle) await remember({ name: file.name, handle });
      }
      return true;
    },

    // opens a File (drag and drop, <input>): .mid is imported, anything else loaded as a project without a file to save back to
    async openFileObject(file) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (!/\.midi?$/i.test(file.name) && !(await confirmDiscard())) return false;
      const isProject = await load(bytes, file.name);
      if (isProject) { doc.name = baseName(file.name); title(); }
      return true;
    },

    async save() {
      if (!doc.path && !doc.handle) return files.saveAs();
      const bytes = encode(store.project);
      if (!(await write(bytes))) return files.saveAs();
      markSaved(doc.name);
      app.toast(`Saved ${doc.name}.fllua`);
      return true;
    },

    async saveAs() {
      const suggested = `${(doc.name || store.project.meta.title || 'Untitled').replace(/[^\w\- ]+/g, '_')}.fllua`;
      const bytes = encode(store.project);
      if (desk) {
        const r = await desk.saveDialog({ title: 'Save project as', defaultPath: suggested, filters: [{ name: 'FL LUA project', extensions: ['fllua'] }] });
        if (!r) return false;
        await desk.write(r.path, bytes);
        doc.path = r.path; doc.handle = null; doc.name = baseName(r.path);
        await remember({ path: r.path, name: doc.name });
      } else if (fsa) {
        let handle;
        try { handle = await window.showSaveFilePicker({ suggestedName: suggested, types: PROJECT_TYPES }); } catch (_) { return false; }
        doc.handle = handle; doc.path = null; doc.name = baseName(handle.name);
        await write(bytes);
        await remember({ name: handle.name, handle });
      } else {
        downloadBlob(bytes, suggested, 'application/octet-stream');
        doc.name = baseName(suggested);
        try { await store.saveProjectLocal(store.project.meta.title || doc.name); } catch (_) { /* storage unavailable */ }
      }
      if (store.project.meta.title === 'Untitled' || !store.project.meta.title) store.project.meta.title = doc.name;
      markSaved(doc.name);
      app.toast(`Saved ${doc.name}.fllua`);
      return true;
    },

    // [{ name, open() }] newest first
    async recent() {
      if (desk) return (await desk.recent()).map((path) => ({ name: baseName(path), detail: path, open: () => files.openPath(path) }));
      if (!fsa) return [];
      const list = (await idbGet('kv', RECENT_KEY).catch(() => null)) || [];
      return list.map((e) => ({ name: baseName(e.name), detail: e.name, open: () => files.openHandle(e.handle) }));
    },
    async clearRecent() { if (desk) await desk.clearRecent(); else await idbPut('kv', RECENT_KEY, []); },

    importMidiBytes,
    async importMidi() {
      if (desk) {
        const r = await desk.openDialog({ title: 'Import MIDI file', filters: [{ name: 'MIDI file', extensions: ['mid', 'midi'] }] });
        if (r) await importMidiBytes(await desk.read(r.path), r.path);
        return;
      }
      const inp = document.createElement('input');
      inp.type = 'file'; inp.accept = '.mid,.midi,audio/midi'; inp.style.display = 'none';
      inp.addEventListener('change', async () => {
        const f = inp.files[0];
        if (f) { try { await importMidiBytes(new Uint8Array(await f.arrayBuffer()), f.name); } catch (err) { app.toast(`Could not import ${f.name}: ${err.message}`); } }
        inp.remove();
      });
      document.body.append(inp); inp.click();
    },
  };

  // ---- desktop: files opened from the system (double-click, "Open with", second launch), and the close prompt
  if (desk) {
    desk.onOpenPath((path) => files.openPath(path).catch((err) => app.toast(`Could not open ${baseName(path)}: ${err.message}`)));
    desk.onSaveBeforeClose(async () => { if (await files.save().catch(() => false)) desk.closeNow(); });
    desk.pendingOpen().then((path) => { if (path) files.openPath(path, true).catch((err) => app.toast(`Could not open ${baseName(path)}: ${err.message}`)); });
  } else {
    // the browser cannot ask "save?" with its own buttons, but it can keep the tab from closing with unsaved work in a file
    window.addEventListener('beforeunload', (e) => { if (store.dirty && (doc.handle || doc.name)) { e.preventDefault(); e.returnValue = ''; } });
  }
  title();
  files.recent().then((l) => { app.recentFiles = l; }).catch(() => {});
  return files;
}
