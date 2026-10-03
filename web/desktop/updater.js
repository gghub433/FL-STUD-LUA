'use strict';
// Updates without code signing. Two ways, depending on how FL LUA was installed:
//   auto - the Windows installer and the Linux AppImage: the new version is downloaded in the background (checked
//          against the sha512 in latest.yml of the release) and replaces this one when the app restarts
//   page - the portable Windows .exe, the .deb package and macOS (an unsigned Mac app cannot replace itself):
//          the app says a new version is out and opens its download
// The page asks; nothing is downloaded or installed without the person saying so.
const { app, net, shell, ipcMain } = require('electron');

const REPO = 'gghub433/FL-STUD-LUA';
const PAGE = `https://github.com/${REPO}/releases/latest`;
const api = () => process.env.FLLUA_UPDATE_API || `https://api.github.com/repos/${REPO}/releases/latest`;

function updateMode() {
  if (process.env.FLLUA_UPDATE_MODE) return process.env.FLLUA_UPDATE_MODE;
  if (!app.isPackaged) return 'off';
  if (process.platform === 'win32') return process.env.PORTABLE_EXECUTABLE_FILE ? 'page' : 'auto';
  if (process.platform === 'linux') return process.env.APPIMAGE ? 'auto' : 'page';
  return 'page';
}

// 1.10.0 > 1.9.3; a leading v and anything after '-' or '+' are ignored
function compareVersions(a, b) {
  const p = (v) => String(v || '').replace(/^v/i, '').split(/[-+]/)[0].split('.').map((x) => parseInt(x, 10) || 0);
  const x = p(a), y = p(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d > 0 ? 1 : -1; }
  return 0;
}

// the file of a release that fits this computer, for the page mode
function assetFor(assets) {
  const names = (assets || []).map((a) => [a.name, a.browser_download_url]);
  const want = process.platform === 'win32' ? /windows-x64\.exe$/ : process.platform === 'darwin' ? new RegExp(`macos-${process.arch}\\.zip$`) : /linux-x64\.deb$/;
  const hit = names.find(([n]) => want.test(n));
  return hit ? hit[1] : null;
}

function installUpdater({ getWin, beforeInstall }) {
  const mode = updateMode();
  let updater = null, latest = null, downloaded = false;
  const send = (ch, v) => { const w = getWin(); if (w && !w.isDestroyed()) w.webContents.send(ch, v); };
  const loadUpdater = () => {
    if (updater) return updater;
    // the class is chosen here, not by electron-updater: the AppImage and the .deb come from one build and must not mix up
    const eu = require('electron-updater');
    updater = process.platform === 'win32' ? new eu.NsisUpdater() : new eu.AppImageUpdater();
    if (process.env.FLLUA_UPDATE_FEED) updater.setFeedURL({ provider: 'generic', url: process.env.FLLUA_UPDATE_FEED });   // tests: a local release folder
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = true;
    updater.allowPrerelease = false;
    updater.logger = null;
    updater.on('download-progress', (p) => send('update:progress', { percent: p.percent, transferred: p.transferred, total: p.total, bytesPerSecond: p.bytesPerSecond }));
    updater.on('update-downloaded', () => { downloaded = true; send('update:downloaded', latest && latest.version); });
    updater.on('error', (e) => send('update:error', String(e && e.message || e)));
    return updater;
  };

  async function check() {
    const current = app.getVersion();
    const base = { mode, current, available: false };
    if (mode === 'off') return base;
    try {
      if (mode === 'auto') {
        const r = await loadUpdater().checkForUpdates();
        const info = r && r.updateInfo;
        if (!info) return base;
        latest = { version: info.version, notes: typeof info.releaseNotes === 'string' ? info.releaseNotes : '', url: PAGE };
      } else {
        const res = await net.fetch(api(), { headers: { accept: 'application/vnd.github+json', 'user-agent': `FL-LUA/${current}` } });
        if (!res.ok) throw new Error(`the release server answered ${res.status}`);
        const j = await res.json();
        latest = { version: String(j.tag_name || '').replace(/^v/i, ''), notes: String(j.body || ''), url: assetFor(j.assets) || j.html_url || PAGE, page: j.html_url || PAGE };
      }
      return { ...base, latest: latest.version, notes: latest.notes.slice(0, 4000), url: latest.url, page: latest.page || PAGE, available: compareVersions(latest.version, current) > 0, downloaded };
    } catch (err) {
      return { ...base, error: String(err && err.message || err) };
    }
  }

  ipcMain.handle('app:info', () => ({ version: app.getVersion(), platform: process.platform, arch: process.arch, updates: mode }));
  ipcMain.handle('update:check', () => check());
  ipcMain.handle('update:download', async () => {
    if (mode !== 'auto') throw new Error('This copy of FL LUA is updated by downloading the new version');
    if (downloaded) return true;
    await loadUpdater().downloadUpdate();
    return true;
  });
  ipcMain.on('update:install', () => {
    if (mode !== 'auto' || !downloaded) return;
    beforeInstall();
    setImmediate(() => updater.quitAndInstall(true, true));            // silent install, start the new version afterwards
  });
  ipcMain.on('update:open', (_e, which) => {
    const url = which === 'page' ? (latest && latest.page) || PAGE : (latest && latest.url) || PAGE;
    if (/^https:\/\//.test(url)) shell.openExternal(url);
  });
  return { mode, check };
}

module.exports = { installUpdater, compareVersions, updateMode, assetFor };
