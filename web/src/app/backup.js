// Cloud backup (OPTIONS > Cloud backup…): every few minutes, while the project changes, a copy goes to a folder the
// person chose. With the folder of Yandex Disk, Google Drive, OneDrive or Dropbox, their app takes it to the cloud.
//   desktop: the main process writes into the chosen folder only (desktop/backup.js)
//   Chrome / Edge: a folder picked with the File System Access API (the permission is asked again after a restart)
// The newest 30 copies of each project are kept (desktop). A copy opens like any project (FILE > Open).
import { h, clear } from '../ui/h.js';
import { modal, toast } from '../ui/dialog.js';
import { idbGet, idbPut } from '../host/idb.js';

const PREFS = 'fllua.backup';
export const INTERVALS = [[2, 'every 2 minutes'], [5, 'every 5 minutes'], [10, 'every 10 minutes'], [30, 'every 30 minutes']];
const loadPrefs = () => { try { return { minutes: 5, ...(JSON.parse(localStorage.getItem(PREFS) || '{}') || {}) }; } catch (_) { return { minutes: 5 }; } };
const savePrefs = (p) => { try { localStorage.setItem(PREFS, JSON.stringify(p)); } catch (_) { /* private mode */ } };
const stamp = (d = new Date()) => { const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`; };

export function installBackup(app) {
  const store = app.store;
  const desk = window.flluaDesktop && window.flluaDesktop.backup;
  const b = app.backup = { prefs: loadPrefs(), folder: null, handle: null, last: 0, lastName: '', error: '', available: !!desk || typeof window.showDirectoryPicker === 'function' };
  let changedSince = false;
  const emit = () => store.bus.emit('backup', b);

  (async () => {
    if (desk) b.folder = await desk.folder().catch(() => null);
    else { const h0 = await idbGet('kv', 'backup-dir').catch(() => null); if (h0) { b.handle = h0; b.folder = h0.name; } }
    emit();
  })();

  b.choose = async () => {
    if (desk) { const f = await desk.choose(); if (f) b.folder = f; }
    else {
      const handle = await window.showDirectoryPicker({ id: 'fllua-backup', mode: 'readwrite' });
      b.handle = handle; b.folder = handle.name;
      await idbPut('kv', 'backup-dir', handle).catch(() => {});
    }
    b.error = '';
    emit();
    if (b.folder) await b.now();
  };
  b.off = async () => {
    if (desk) await desk.off(); else await idbPut('kv', 'backup-dir', null).catch(() => {});
    b.folder = null; b.handle = null; emit();
  };
  b.setMinutes = (m) => { b.prefs.minutes = m; savePrefs(b.prefs); emit(); };

  // writes one copy now; true when it was written
  b.now = async () => {
    if (!b.folder) return false;
    const title = store.project.meta.title || (app.doc && app.doc.name) || 'Untitled';
    const bytes = app.files.encode(store.project);
    try {
      if (desk) { const r = await desk.write(title, bytes); b.lastName = r.name; }
      else {
        if (b.handle.queryPermission && (await b.handle.queryPermission({ mode: 'readwrite' })) !== 'granted') {
          if ((await b.handle.requestPermission({ mode: 'readwrite' }).catch(() => 'denied')) !== 'granted') throw new Error('Allow FL LUA to write to the backup folder (OPTIONS > Cloud backup…)');
        }
        const dir = await b.handle.getDirectoryHandle('FL LUA backups', { create: true });
        const stem = `${String(title).replace(/[\\/:*?"<>|]+/g, '_').slice(0, 80)} ${stamp()}`;
        let name = `${stem}.fllua`;
        for (let n = 2; await dir.getFileHandle(name).then(() => true, () => false); n++) name = `${stem}_${n}.fllua`;   // two copies in one second
        const w = await (await dir.getFileHandle(name, { create: true })).createWritable();
        await w.write(bytes); await w.close();
        b.lastName = name;
      }
      b.last = Date.now(); b.error = ''; changedSince = false;
      emit();
      return true;
    } catch (err) {
      b.error = String(err && err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
      emit();
      return false;
    }
  };

  // after the autosave, when the project changed and the interval has passed
  store.bus.on('change', () => { changedSince = true; });
  store.bus.on('param', () => { changedSince = true; });
  store.bus.on('autosaved', () => {
    if (!b.folder || !changedSince || Date.now() - b.last < b.prefs.minutes * 60000) return;
    b.now();
  });
  b.open = () => openBackupDialog(app);
  return b;
}

function openBackupDialog(app) {
  const b = app.backup, store = app.store;
  const body = h('div.backup');
  const render = () => {
    clear(body);
    body.append(h('div.collab-p', 'A copy of the project goes to a folder every few minutes while you work. Choose the folder of Yandex Disk, Google Drive, OneDrive or Dropbox on this computer and their app takes the copies to the cloud. A copy opens like any project (FILE > Open).'));
    if (!b.available) { body.append(h('div.collab-p.dim', 'This browser cannot write to a folder. Use the FL LUA desktop app, Chrome or Edge.')); return; }
    const interval = h('select.select', INTERVALS.map(([m, l]) => h('option', { value: String(m) }, l)));
    interval.value = String(b.prefs.minutes);
    interval.addEventListener('change', () => b.setMinutes(+interval.value));
    body.append(
      h('div.collab-row', h('span.dim', 'Folder'), h('b.backup-folder', b.folder || 'not chosen'), h('button.btn' + (b.folder ? '' : '.primary'), { onclick: () => b.choose().catch((e) => { b.error = e.message; render(); }) }, b.folder ? 'Change…' : 'Choose folder…')),
      h('div.collab-row', h('span.dim', 'Copy'), interval),
      b.folder ? h('div.collab-row',
        h('button.btn', { onclick: async () => { if (await b.now()) toast(`Backed up: ${b.lastName}`); } }, 'Back up now'),
        window.flluaDesktop ? h('button.btn', { onclick: () => window.flluaDesktop.backup.show() }, 'Show folder') : null,
        h('button.btn', { onclick: () => b.off() }, 'Turn off')) : null,
      h('div.collab-p.dim', b.last ? `Last copy: ${b.lastName}` : 'No copy yet in this session.'),
      b.error ? h('div.collab-msg.err', b.error) : null);
  };
  const off = store.bus.on('backup', render);
  render();
  modal({ title: 'Cloud backup', body, width: 520, buttons: [{ label: 'Close' }], onClose: () => off() });
}
