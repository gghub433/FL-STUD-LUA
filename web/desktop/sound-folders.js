'use strict';
// My sounds (Browser): folders with the person's samples, chosen in a folder dialog or dropped on the Browser.
// The page lists them one folder at a time and reads the audio files inside them through this process; it cannot
// name any other path: it only knows a folder id and a relative path, and both are checked here.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { app, ipcMain, dialog, shell } = require('electron');

const AUDIO = /\.(wav|mp3|ogg|flac|aif|aiff|m4a)$/i;           // the same list as src/core/sound-files.js
const MAX_ENTRIES = 20000;                                       // per folder listing: more is not a sample folder
const MAX_FILE = 1024 * 1024 * 1024;                             // 1 GB
const cfgPath = () => path.join(app.getPath('userData'), 'sound-folders.json');
const readCfg = () => {
  try { const c = JSON.parse(fs.readFileSync(cfgPath(), 'utf8')); return Array.isArray(c.folders) ? c.folders.filter((f) => f && typeof f.id === 'string' && typeof f.path === 'string') : []; }
  catch (_) { return []; }
};
const writeCfg = (folders) => { try { fs.writeFileSync(cfgPath(), JSON.stringify({ folders })); } catch (_) { /* read-only profile */ } };
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch (_) { return false; } };
const shown = (f) => ({ id: f.id, name: path.basename(f.path) || f.path, path: f.path, missing: !isDir(f.path) });

function addFolder(p) {
  const n = path.resolve(String(p));
  if (!isDir(n)) return null;
  const list = readCfg();
  const old = list.find((f) => path.resolve(f.path) === n);
  if (old) return old;
  const f = { id: crypto.randomBytes(6).toString('hex'), path: n };
  list.push(f);
  writeCfg(list);
  return f;
}

// folder id + "Drums/Kicks/808.wav" -> an absolute path that stays inside that folder
function resolveIn(id, rel) {
  const f = readCfg().find((x) => x.id === id);
  if (!f) throw new Error('This folder is not in My sounds');
  const root = path.resolve(f.path);
  if (!isDir(root)) throw new Error(`The folder is not available: ${root}`);
  const parts = String(rel || '').split('/').filter(Boolean);
  if (parts.some((s) => s === '.' || s === '..' || /[\\\0]/.test(s) || (process.platform === 'win32' && s.includes(':')))) throw new Error('Not a path inside the folder');
  const p = path.resolve(root, ...parts);
  if (p !== root && !p.startsWith(root.endsWith(path.sep) ? root : root + path.sep)) throw new Error('Not a path inside the folder');
  return { root, p };
}

async function listDir(id, rel) {
  const { p } = resolveIn(id, rel);
  const out = [];
  const dir = await fs.promises.opendir(p);
  try {
    for await (const e of dir) {
      if (e.name[0] === '.') continue;
      let isDirectory = e.isDirectory(), isFile = e.isFile();
      if (e.isSymbolicLink()) { const st = await fs.promises.stat(path.join(p, e.name)).catch(() => null); isDirectory = !!st && st.isDirectory(); isFile = !!st && st.isFile(); }
      if (isDirectory) out.push({ name: e.name, dir: true });
      else if (isFile && AUDIO.test(e.name)) out.push({ name: e.name, dir: false });
      if (out.length >= MAX_ENTRIES) break;
    }
  } finally { await dir.close().catch(() => {}); }
  return out;
}

function installSoundFolders({ getWin }) {
  ipcMain.handle('sounds:folders', () => readCfg().map(shown));
  ipcMain.handle('sounds:add', async () => {
    const r = await dialog.showOpenDialog(getWin(), { title: 'Add a folder with sounds to My sounds', properties: ['openDirectory', 'multiSelections'] });
    if (r.canceled) return [];
    return r.filePaths.map(addFolder).filter(Boolean).map(shown);
  });
  // a folder dropped on the Browser: the preload takes its path from the dropped file (webUtils), never from the page
  ipcMain.handle('sounds:addPath', (_e, p) => { const f = typeof p === 'string' && p ? addFolder(p) : null; return f ? shown(f) : null; });
  ipcMain.handle('sounds:remove', (_e, id) => { writeCfg(readCfg().filter((f) => f.id !== id)); return true; });
  ipcMain.handle('sounds:list', (_e, id, rel) => listDir(String(id), rel));
  ipcMain.handle('sounds:read', async (_e, id, rel) => {
    const { p } = resolveIn(String(id), rel);
    if (!AUDIO.test(p)) throw new Error('Not an audio file');
    const st = await fs.promises.stat(p);
    if (!st.isFile() || st.size > MAX_FILE) throw new Error('Not an audio file');
    return new Uint8Array(await fs.promises.readFile(p));
  });
  ipcMain.handle('sounds:show', (_e, id, rel) => {
    const { root, p } = resolveIn(String(id), rel);
    if (p === root) shell.openPath(root); else shell.showItemInFolder(p);
    return true;
  });
}

module.exports = { installSoundFolders, resolveIn, listDir, addFolder };
