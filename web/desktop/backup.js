'use strict';
// Backups to a folder (OPTIONS > Cloud backup…): the app writes a copy of the project there every few minutes.
// Choose the folder of Yandex Disk, Google Drive, OneDrive or Dropbox and their app takes the copies to the cloud.
// The page can only write file names into the one folder that was chosen here, nothing else.
const fs = require('node:fs');
const path = require('node:path');
const { app, ipcMain, dialog, shell } = require('electron');

const KEEP = 30;                                   // copies kept per project
const cfgPath = () => path.join(app.getPath('userData'), 'backup.json');
const readCfg = () => { try { return JSON.parse(fs.readFileSync(cfgPath(), 'utf8')) || {}; } catch (_) { return {}; } };
const writeCfg = (c) => { try { fs.writeFileSync(cfgPath(), JSON.stringify(c)); } catch (_) { /* read-only profile */ } };
const safe = (s) => String(s || 'Untitled').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').replace(/^\.+/, '').trim().slice(0, 80) || 'Untitled';

function installBackup({ getWin }) {
  if (process.env.FLLUA_BACKUP_DIR) {                                                         // tests
    fs.mkdirSync(process.env.FLLUA_BACKUP_DIR, { recursive: true });
    writeCfg({ folder: process.env.FLLUA_BACKUP_DIR });
  }
  const dirOf = (c) => path.join(c.folder, 'FL LUA backups');

  ipcMain.handle('backup:folder', () => readCfg().folder || null);
  ipcMain.handle('backup:choose', async () => {
    const r = await dialog.showOpenDialog(getWin(), { title: 'Folder for backups (for example Yandex Disk, Google Drive, OneDrive)', properties: ['openDirectory', 'createDirectory'] });
    if (r.canceled || !r.filePaths[0]) return null;
    writeCfg({ folder: r.filePaths[0] });
    return r.filePaths[0];
  });
  ipcMain.handle('backup:off', () => { writeCfg({}); return true; });
  ipcMain.handle('backup:show', () => { const c = readCfg(); if (c.folder) shell.openPath(fs.existsSync(dirOf(c)) ? dirOf(c) : c.folder); return true; });
  ipcMain.handle('backup:write', async (_e, title, data) => {
    const c = readCfg();
    if (!c.folder || !fs.existsSync(c.folder)) throw new Error('The backup folder is not available');
    const dir = dirOf(c);
    await fs.promises.mkdir(dir, { recursive: true });
    const d = new Date(), pad = (n) => String(n).padStart(2, '0');
    const base = safe(title);
    const stem = `${base} ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
    let name = `${stem}.fllua`;
    for (let n = 2; fs.existsSync(path.join(dir, name)); n++) name = `${stem}_${n}.fllua`;   // two copies in one second
    const file = path.join(dir, name), tmp = `${file}.saving`;
    await fs.promises.writeFile(tmp, Buffer.from(data));
    await fs.promises.rename(tmp, file);
    // the oldest copies of this project go when there are more than KEEP
    const mine = (await fs.promises.readdir(dir)).filter((f) => f.startsWith(`${base} `) && f.endsWith('.fllua')).sort();
    for (const f of mine.slice(0, Math.max(0, mine.length - KEEP))) await fs.promises.unlink(path.join(dir, f)).catch(() => {});
    return { file, name };
  });
}

module.exports = { installBackup };
