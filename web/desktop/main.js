'use strict';
// FL LUA desktop shell: the same app in its own window, no browser and no local server.
// The app files are served to the window from a private scheme (fllua://app/…), which keeps one stable
// origin, so projects, samples and plugin packs stored by the app survive updates and restarts.
const { app, BrowserWindow, protocol, session, Menu, shell, ipcMain, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { installUpdater } = require('./updater');
const { installCollab } = require('./collab');

const SMOKE = process.argv.includes('--smoke');
const DEV = process.argv.includes('--dev');
const ROOT = fs.existsSync(path.join(__dirname, 'app')) ? path.join(__dirname, 'app') : path.join(__dirname, '..', 'dist');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.wav': 'audio/wav', '.txt': 'text/plain; charset=utf-8',
};

protocol.registerSchemesAsPrivileged([{ scheme: 'fllua', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }]);
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');      // the audio engine starts with the first click anyway; never block it
if (SMOKE) app.setPath('userData', path.join(os.tmpdir(), `fllua-smoke-${process.pid}`));          // a test run must not touch the real data
if (SMOKE && !process.env.FLLUA_UPDATE_MODE) process.env.FLLUA_UPDATE_MODE = 'page';                  // the smoke test asks a local fake release server
if (process.platform === 'win32') app.setAppUserModelId('app.fllua.desktop');

const lock = SMOKE ? true : app.requestSingleInstanceLock();
if (!lock) app.quit();

let win = null;
// ---- documents: the page may only read and write files the person picked (dialogs, recent list, "Open with")
const allowedFiles = new Set();
const allow = (p) => { const n = path.resolve(p); allowedFiles.add(n); return n; };
const DOC_EXT = /\.(fllua|mid|midi|zip|json)$/i;
const fileArg = (argv) => argv.slice(1).find((a) => !a.startsWith('-') && DOC_EXT.test(a) && fs.existsSync(a)) || null;
let pendingOpen = fileArg(process.argv);
if (pendingOpen) pendingOpen = allow(pendingOpen);
let docState = { dirty: false, name: 'Untitled', path: null }, closing = false;
const recentPath = () => path.join(app.getPath('userData'), 'recent.json');
const readRecent = () => { try { return JSON.parse(fs.readFileSync(recentPath(), 'utf8')).filter((p) => typeof p === 'string'); } catch (_) { return []; } };
const writeRecent = (list) => { try { fs.writeFileSync(recentPath(), JSON.stringify(list.slice(0, 10))); } catch (_) { /* read-only profile */ } };
function openFromSystem(p) {
  const n = allow(p);
  if (win && !win.isDestroyed() && win.webContents && !win.webContents.isLoading()) win.webContents.send('open-path', n);
  else pendingOpen = n;
}
// macOS hands files over with an event, before or after the window exists
app.on('open-file', (e, p) => { e.preventDefault(); openFromSystem(p); });

const statePath = () => path.join(app.getPath('userData'), 'window.json');
const loadState = () => { try { return JSON.parse(fs.readFileSync(statePath(), 'utf8')); } catch (_) { return {}; } };
const saveState = () => {
  if (!win || win.isDestroyed()) return;
  try { fs.writeFileSync(statePath(), JSON.stringify({ ...(win.isMaximized() || win.isFullScreen() ? loadState() : win.getBounds()), max: win.isMaximized() })); } catch (_) { /* read-only profile */ }
};

function serve(request) {
  const url = new URL(request.url);
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.normalize(path.join(ROOT, rel));
  if (!file.startsWith(ROOT)) return new Response('forbidden', { status: 403 });
  return fs.promises.readFile(file).then(
    (data) => new Response(data, { status: 200, headers: { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' } }),
    () => new Response('not found', { status: 404 }),
  );
}

function createWindow() {
  const st = loadState();
  win = new BrowserWindow({
    width: st.width || 1500, height: st.height || 900, x: st.x, y: st.y, minWidth: 1000, minHeight: 600,
    show: false, backgroundColor: '#272a2d', title: 'FL LUA', autoHideMenuBar: true,
    icon: path.join(ROOT, 'assets', 'icon-512.png'),
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false, spellcheck: false, preload: path.join(__dirname, 'preload.js') },
  });
  if (st.max && !SMOKE) win.maximize();
  win.once('ready-to-show', () => win.show());
  win.on('close', (e) => {
    saveState();
    if (SMOKE || closing || !docState.dirty) return;
    e.preventDefault();
    const r = dialog.showMessageBoxSync(win, { type: 'question', buttons: ['Save', "Don't save", 'Cancel'], defaultId: 0, cancelId: 2, noLink: true,
      message: `Save changes to "${docState.name}"?`, detail: 'Your changes will be lost if you close without saving.' });
    if (r === 0) win.webContents.send('save-before-close');
    else if (r === 1) { closing = true; win.close(); }
  });
  win.webContents.setVisualZoomLevelLimits(1, 1);
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('fllua://')) { e.preventDefault(); if (/^https?:/.test(url)) shell.openExternal(url); } });
  if (DEV) win.webContents.openDevTools({ mode: 'detach' });
  win.loadURL(`fllua://app/index.html${SMOKE ? '?nopicker' : ''}`);
  return win;
}

// --smoke: starts the app, waits until it is ready, plays the demo and checks that audio comes out, then exits
async function smoke(w) {
  const out = { ok: false };
  // a fake release server for the update check: it offers version 99.0.0 with a file for every platform
  const http = require('node:http');
  const assets = ['FL-LUA-windows-x64.exe', 'FL-LUA-windows-x64-setup.exe', 'FL-LUA-linux-x64.AppImage', 'FL-LUA-linux-x64.deb', 'FL-LUA-macos-arm64.zip', 'FL-LUA-macos-x64.zip'];
  const server = http.createServer((_q, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ tag_name: 'v99.0.0', body: 'Smoke test release', html_url: 'https://example.invalid/release', assets: assets.map((name) => ({ name, browser_download_url: `https://example.invalid/${name}` })) })); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  process.env.FLLUA_UPDATE_API = `http://127.0.0.1:${server.address().port}/latest`;
  const smokeFile = allow(path.join(app.getPath('userData'), 'smoke.fllua'));
  try {
    await w.webContents.executeJavaScript(`new Promise((resolve, reject) => { const t = setInterval(() => { if (window.__ready) { clearInterval(t); resolve(); } }, 100); setTimeout(() => reject(new Error('the app did not become ready')), 45000); })`);
    const r = await w.webContents.executeJavaScript(`(async () => {
      const o = { title: document.title, origin: location.origin, channels: app.store.project.channels.length, menus: document.querySelectorAll('#menubar .menu-top').length,
        audio: !!(app.host && app.host.ready), state: app.host && app.host.ctx ? app.host.ctx.state : null, packs: !!app.packs, mic: !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia), midi: typeof navigator.requestMIDIAccess === 'function' };
      if (o.audio) {
        app.transport.play();
        let m = 0; const t0 = performance.now();
        while (performance.now() - t0 < 2500) { for (let t = 0; t <= 8; t++) { const [l, r] = app.host.peak(t); m = Math.max(m, l, r); } await new Promise((r) => setTimeout(r, 20)); }
        app.transport.stop();
        o.peak = m;
        const w = await import('/src/host/export/wav.js'); o.wavOk = typeof w.encodeWav === 'function';
        // files through the preload bridge: save the project to disk, change it, open the file again
        o.bridge = !!window.flluaDesktop;
        if (o.bridge) {
          app.doc.path = ${JSON.stringify(smokeFile)}; app.doc.name = 'smoke';
          const tempo = app.store.project.tempo;
          o.saved = await app.files.save();
          app.store.project.tempo = 61;
          await app.files.openPath(${JSON.stringify(smokeFile)}, true);
          o.fileRoundTrip = app.store.project.tempo === tempo && document.title === 'smoke - FL LUA';
        }
        o.store = (await fetch('/packs/catalog.json').then((r) => r.json())).packs.length;
        // a WAM plugin (the example synth): it loads from the app's own files and sounds through the engine
        const wch = await app.wam.addInstrument('wam/example-synth/index.js');
        let ws = null;
        for (let i = 0; i < 150; i++) { ws = app.wam.statusOf('ch:' + wch.id); if (ws && ws.state !== 'loading') break; await new Promise((r) => setTimeout(r, 100)); }
        o.wam = ws ? ws.state + (ws.error ? ': ' + ws.error : '') : 'none';
        if (ws && ws.state === 'ready') {
          app.host.send({ t: 'noteOn', ch: wch.id, key: 57, vel: 1 });
          let wm = 0; const w0 = performance.now();
          while (performance.now() - w0 < 700) { const [l, r] = app.host.peak(0); wm = Math.max(wm, l, r); await new Promise((r) => setTimeout(r, 20)); }
          app.host.send({ t: 'noteOff', ch: wch.id, key: 57 });
          o.wamPeak = wm;
        }
        // a shared session: this window hosts it (the hub runs in the main process)
        try { await app.collab.start('Smoke'); o.collab = { state: app.collab.state, code: app.collab.code, port: app.collab.port, channels: app.store.project.channels.length }; } catch (e) { o.collab = { error: String(e.message || e) }; }
        const u = await window.flluaDesktop.update.check();
        o.update = { mode: u.mode, current: u.current, latest: u.latest, available: u.available, file: (u.url || '').split('/').pop(), error: u.error };
      }
      return o;
    })()`);
    Object.assign(out, r);
    // someone joins over the network: welcome, then the host's project
    if (r.collab && r.collab.port) {
      out.collabGuest = await new Promise((resolve) => {
        const got = {};
        const ws = new WebSocket(`ws://127.0.0.1:${r.collab.port}/collab?code=${r.collab.code}&name=Smoke%20guest`);
        const t = setTimeout(() => { try { ws.close(); } catch (_) { /* */ } resolve(got); }, 8000);
        ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.t === 'welcome') got.welcome = true; if (m.t === 'snapshot') { got.channels = m.project.channels.length; clearTimeout(t); ws.close(); resolve(got); } };
        ws.onerror = () => { got.error = 'could not connect'; };
      });
      await w.webContents.executeJavaScript('app.collab.leave()').catch(() => {});
      // and the other way round: this app joins a session hosted elsewhere (a hub with a stand-in host here)
      const { createHub } = require('./collab-hub');
      const hub = createHub(), srv = http.createServer();
      srv.on('upgrade', (req, sock, head) => hub.handleUpgrade(req, sock, head));
      await new Promise((r2) => srv.listen(0, '127.0.0.1', r2));
      const { code } = hub.start();
      const fake = JSON.parse(await w.webContents.executeJavaScript('JSON.stringify(app.store.project)'));
      fake.tempo = 99; fake.meta.title = 'Remote song';
      let hostLink = null;
      hostLink = hub.attachLocal({ name: 'Remote host' }, (d) => { if (typeof d !== 'string') return; const m = JSON.parse(d); if (m.t === 'need-snapshot') hostLink.send(JSON.stringify({ t: 'snapshot', to: m.for, seq: 0, project: fake })); });
      out.collabJoin = await w.webContents.executeJavaScript(`app.collab.join('127.0.0.1:${srv.address().port}', '${code}', 'Smoke').then(() => ({ state: app.collab.state, tempo: app.store.project.tempo, title: app.store.project.meta.title }), (e) => ({ error: String(e.message || e) }))`);
      await w.webContents.executeJavaScript('app.collab.leave()').catch(() => {});
      hub.end(); srv.close();
    }
    out.ok = r.title === 'FL LUA' && r.channels > 0 && r.menus >= 8 && r.origin === 'fllua://app' && (!r.audio || r.state !== 'running' || r.peak > 0.02) && r.bridge && (!r.audio || r.fileRoundTrip)
      && (!r.update || (r.update.available && r.update.latest === '99.0.0' && /^FL-LUA-/.test(r.update.file)))
      && (!r.audio || r.state !== 'running' || (r.wam === 'ready' && r.wamPeak > 0.01))
      && (!r.collab || (r.collab.state === 'on' && out.collabGuest && out.collabGuest.welcome && out.collabGuest.channels === r.collab.channels
        && out.collabJoin && out.collabJoin.state === 'on' && out.collabJoin.tempo === 99));
    if (process.env.FLLUA_SHOT) { const img = await w.webContents.capturePage(); fs.writeFileSync(process.env.FLLUA_SHOT, img.toPNG()); }
  } catch (err) { out.error = String(err && err.message || err); }
  server.close();
  const line = `SMOKE_RESULT ${JSON.stringify(out)}`;
  console.log(line);
  if (process.env.FLLUA_SMOKE_OUT) { try { fs.writeFileSync(process.env.FLLUA_SMOKE_OUT, JSON.stringify(out)); } catch (_) { /* the exit code still tells */ } }     // Windows GUI programs have no console to print to
  app.exit(out.ok ? 0 : 1);
}

app.on('second-instance', (_e, argv) => {
  if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  const f = fileArg(argv);
  if (f) openFromSystem(f);
});

ipcMain.handle('file:open-dialog', async (_e, o = {}) => {
  const r = await dialog.showOpenDialog(win, { title: o.title, filters: o.filters, properties: ['openFile'] });
  return r.canceled || !r.filePaths[0] ? null : { path: allow(r.filePaths[0]) };
});
ipcMain.handle('file:save-dialog', async (_e, o = {}) => {
  const docs = app.getPath('documents');
  const r = await dialog.showSaveDialog(win, { title: o.title, filters: o.filters, defaultPath: path.join(docs, path.basename(String(o.defaultPath || 'Untitled.fllua'))) });
  return r.canceled || !r.filePath ? null : { path: allow(r.filePath) };
});
ipcMain.handle('file:read', async (_e, p) => {
  const n = path.resolve(String(p));
  if (!allowedFiles.has(n)) throw new Error('This file was not chosen in a file dialog');
  return new Uint8Array(await fs.promises.readFile(n));
});
ipcMain.handle('file:write', async (_e, p, data) => {
  const n = path.resolve(String(p));
  if (!allowedFiles.has(n)) throw new Error('This file was not chosen in a file dialog');
  const tmp = `${n}.saving`;
  await fs.promises.writeFile(tmp, Buffer.from(data));
  await fs.promises.rename(tmp, n);                                            // never leaves a half-written project
  return true;
});
ipcMain.handle('recent:list', () => { const l = readRecent().filter((p) => fs.existsSync(p)); l.forEach(allow); return l; });
ipcMain.handle('recent:add', (_e, p) => {
  const n = path.resolve(String(p));
  if (!allowedFiles.has(n)) return false;
  writeRecent([n, ...readRecent().filter((x) => x !== n)]);
  app.addRecentDocument(n);
  return true;
});
ipcMain.handle('recent:clear', () => { writeRecent([]); app.clearRecentDocuments(); return true; });
ipcMain.handle('open:pending', () => { const p = pendingOpen; pendingOpen = null; return p; });
ipcMain.on('doc:state', (_e, s) => { if (s && typeof s === 'object') docState = { dirty: !!s.dirty, name: String(s.name || 'Untitled').slice(0, 120), path: s.path || null }; if (process.platform === 'darwin' && win && !win.isDestroyed()) win.setDocumentEdited(!!docState.dirty); });
ipcMain.on('window:close-now', () => { closing = true; if (win && !win.isDestroyed()) win.close(); });
ipcMain.on('window:zoom', (_e, f) => { const z = Number(f); if (win && !win.isDestroyed() && z >= 0.5 && z <= 2.5) win.webContents.setZoomFactor(z); });
installUpdater({ getWin: () => win, beforeInstall: () => { closing = true; } });
const collab = installCollab({ getWin: () => win });
app.on('before-quit', () => { collab.stop(); });
app.on('window-all-closed', () => app.quit());

app.whenReady().then(() => {
  if (!lock) return;
  protocol.handle('fllua', serve);
  Menu.setApplicationMenu(null);                                  // the app has its own menu bar
  const allowed = new Set(['media', 'midi', 'midiSysex', 'clipboard-read', 'clipboard-sanitized-write', 'fullscreen', 'audioCapture', 'speaker-selection']);
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => cb(allowed.has(permission)));
  session.defaultSession.setPermissionCheckHandler((wc, permission) => allowed.has(permission));
  const w = createWindow();
  if (SMOKE) w.webContents.once('did-finish-load', () => smoke(w));
});
