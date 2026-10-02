'use strict';
// FL LUA desktop shell: the same app in its own window, no browser and no local server.
// The app files are served to the window from a private scheme (fllua://app/…), which keeps one stable
// origin, so projects, samples and plugin packs stored by the app survive updates and restarts.
const { app, BrowserWindow, protocol, session, Menu, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

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
if (process.platform === 'win32') app.setAppUserModelId('app.fllua.desktop');

const lock = SMOKE ? true : app.requestSingleInstanceLock();
if (!lock) app.quit();

let win = null;
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
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false, spellcheck: false },
  });
  if (st.max && !SMOKE) win.maximize();
  win.once('ready-to-show', () => win.show());
  win.on('close', saveState);
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
        o.store = (await fetch('/packs/catalog.json').then((r) => r.json())).packs.length;
      }
      return o;
    })()`);
    Object.assign(out, r);
    out.ok = r.title === 'FL LUA' && r.channels > 0 && r.menus >= 8 && r.origin === 'fllua://app' && (!r.audio || r.state !== 'running' || r.peak > 0.02);
    if (process.env.FLLUA_SHOT) { const img = await w.webContents.capturePage(); fs.writeFileSync(process.env.FLLUA_SHOT, img.toPNG()); }
  } catch (err) { out.error = String(err && err.message || err); }
  const line = `SMOKE_RESULT ${JSON.stringify(out)}`;
  console.log(line);
  if (process.env.FLLUA_SMOKE_OUT) { try { fs.writeFileSync(process.env.FLLUA_SMOKE_OUT, JSON.stringify(out)); } catch (_) { /* the exit code still tells */ } }     // Windows GUI programs have no console to print to
  app.exit(out.ok ? 0 : 1);
}

app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
app.on('window-all-closed', () => app.quit());

app.whenReady().then(() => {
  if (!lock) return;
  protocol.handle('fllua', serve);
  Menu.setApplicationMenu(null);                                  // the app has its own menu bar
  const allowed = new Set(['media', 'midi', 'midiSysex', 'clipboard-read', 'clipboard-sanitized-write', 'fullscreen', 'audioCapture']);
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => cb(allowed.has(permission)));
  session.defaultSession.setPermissionCheckHandler((wc, permission) => allowed.has(permission));
  const w = createWindow();
  if (SMOKE) w.webContents.once('did-finish-load', () => smoke(w));
});
