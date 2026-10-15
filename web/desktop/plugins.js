'use strict';
// VST3, CLAP and VST2 plugins in the desktop app (see native/): this process starts the plugin host (fllua-plughost),
// passes the page's commands to it and its events back, and keeps the list of installed plugins:
//   plugins:start      starts the host (once) -> { shm, K } ; the page's bridge then opens the shared memory
//   plugins:cmd        a command for the host (load, unload, editor, getState, setState, params, …)
//   plugins:list       the installed plugins found so far (cached in userData/plugins.json)
//   plugins:scan       looks through the plugin folders; each new file is checked by a separate short-lived host
//                      process, so a plugin that crashes while being scanned is only marked as failed
//   plugins:folders    the folders that are scanned; plugins:addFolder / plugins:removeFolder
const { app, ipcMain, dialog } = require('electron');
const { spawn, execFile } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const plat = `${process.platform}-${process.arch}`;
const nativeDir = () => {
  const candidates = [path.join(process.resourcesPath || '', 'native'), path.join(__dirname, 'native', 'out', plat)];
  if (process.env.FLLUA_NATIVE_DIR) candidates.unshift(process.env.FLLUA_NATIVE_DIR);
  return candidates.find((d) => fs.existsSync(path.join(d, process.platform === 'win32' ? 'fllua-plughost.exe' : 'fllua-plughost'))) || null;
};
const hostExe = (dir) => path.join(dir, process.platform === 'win32' ? 'fllua-plughost.exe' : 'fllua-plughost');

// where VST3, CLAP and VST2 plugins are installed by convention on each system
function defaultFolders() {
  const home = os.homedir();
  const env = (k) => (process.env[k] || '').split(path.delimiter).filter(Boolean);
  if (process.platform === 'win32') {
    const common = process.env.CommonProgramFiles || 'C:\\Program Files\\Common Files';
    const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    const pf = process.env.ProgramFiles || 'C:\\Program Files';
    return [path.join(common, 'VST3'), path.join(local, 'Programs', 'Common', 'VST3'), path.join(common, 'CLAP'), path.join(local, 'Programs', 'Common', 'CLAP'), ...env('CLAP_PATH'),
      path.join(pf, 'VSTPlugins'), path.join(pf, 'Steinberg', 'VSTPlugins'), path.join(common, 'VST2'), path.join(common, 'Steinberg', 'VST2'), ...env('VST_PATH')];
  }
  if (process.platform === 'darwin') {
    return ['/Library/Audio/Plug-Ins/VST3', path.join(home, 'Library/Audio/Plug-Ins/VST3'), '/Library/Audio/Plug-Ins/CLAP', path.join(home, 'Library/Audio/Plug-Ins/CLAP'), ...env('CLAP_PATH'),
      '/Library/Audio/Plug-Ins/VST', path.join(home, 'Library/Audio/Plug-Ins/VST'), ...env('VST_PATH')];
  }
  return [path.join(home, '.vst3'), '/usr/lib/vst3', '/usr/local/lib/vst3', path.join(home, '.clap'), '/usr/lib/clap', '/usr/local/lib/clap', ...env('VST3_PATH'), ...env('CLAP_PATH'),
    path.join(home, '.vst'), '/usr/lib/vst', '/usr/local/lib/vst', path.join(home, '.lxvst'), '/usr/lib/lxvst', '/usr/local/lib/lxvst', ...env('VST_PATH'), ...env('LXVST_PATH')];
}

// Windows: the VST2 folder installers write into the registry (HKLM\SOFTWARE\VST, VSTPluginsPath)
let regVstPath = null;
function registryVstFolder() {
  if (process.platform !== 'win32') return Promise.resolve(null);
  if (!regVstPath) {
    regVstPath = new Promise((resolve) => {
      execFile('reg', ['query', 'HKLM\\SOFTWARE\\VST', '/v', 'VSTPluginsPath'], { windowsHide: true, timeout: 5000 }, (err, stdout) => {
        const m = !err && /VSTPluginsPath\s+REG_(?:EXPAND_)?SZ\s+(.+)/i.exec(String(stdout));
        resolve(m ? m[1].trim().replace(/%([^%]+)%/g, (_, k) => process.env[k] || '') : null);
      });
    });
  }
  return regVstPath;
}

function installPlugins({ getWin }) {
  const cachePath = () => path.join(app.getPath('userData'), 'plugins.json');
  let cache = null;
  const loadCache = () => {
    if (cache) return cache;
    try { cache = JSON.parse(fs.readFileSync(cachePath(), 'utf8')); } catch (_) { cache = {}; }
    cache.files = cache.files && typeof cache.files === 'object' ? cache.files : {};       // path -> { mtime, size, plugins, error }
    cache.folders = Array.isArray(cache.folders) ? cache.folders : [];                  // folders the person added
    cache.hidden = Array.isArray(cache.hidden) ? cache.hidden : [];                     // default folders the person removed
    return cache;
  };
  const saveCache = () => { try { fs.writeFileSync(cachePath(), JSON.stringify(cache)); } catch (_) { /* read-only profile */ } };
  let regFolder = null;
  const folders = () => {
    const c = loadCache();
    if (process.env.FLLUA_PLUGIN_PATH) return process.env.FLLUA_PLUGIN_PATH.split(path.delimiter);        // tests: only these
    const list = [...defaultFolders(), ...(regFolder ? [regFolder] : [])].filter((f) => !c.hidden.includes(f));
    return [...new Set([...list, ...c.folders])];
  };
  const toPage = (ch, v) => { const w = getWin(); if (w && !w.isDestroyed()) w.webContents.send(ch, v); };

  // ---------------------------------------------------------------- the host process
  let host = null;      // { proc, shm, waiting: Map, ready: Promise, nextId }
  function start() {
    if (host) return host.ready;
    const dir = nativeDir();
    if (!dir) return Promise.reject(new Error('The plugin host is not part of this build'));
    const shm = `fllua-${process.pid}-${Math.random().toString(36).slice(2, 7)}`;
    const proc = spawn(hostExe(dir), ['--serve', shm], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const h = { proc, shm, waiting: new Map(), nextId: 1, buf: '' };
    host = h;
    h.ready = new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('The plugin host did not start')), 15000);
      h.resolveReady = (m) => { clearTimeout(t); resolve({ shm, frameSize: m.frameSize, layout: m.layout }); };
      h.rejectReady = (e) => { clearTimeout(t); reject(e); };
    });
    h.ready.catch(() => {});
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (d) => {
      h.buf += d;
      let i;
      while ((i = h.buf.indexOf('\n')) >= 0) {
        const line = h.buf.slice(0, i); h.buf = h.buf.slice(i + 1);
        let m;
        try { m = JSON.parse(line); } catch (_) { continue; }
        if (m.ev === 'ready') h.resolveReady(m);
        else if (m.ev === 'fatal') h.rejectReady(new Error(m.error));
        else if (m.ev) toPage('plugins:event', m);
        else if (h.waiting.has(m.id)) { h.waiting.get(m.id)(m); h.waiting.delete(m.id); }
      }
    });
    proc.stderr.on('data', (d) => { if (process.env.FLLUA_PLUGIN_DEBUG) process.stderr.write(d); });
    proc.on('exit', (code, signal) => {
      if (host === h) host = null;
      for (const res of h.waiting.values()) res({ ok: false, error: 'The plugin host stopped' });
      h.waiting.clear();
      if (h.rejectReady) h.rejectReady(new Error('The plugin host stopped'));
      if (!h.quitting) toPage('plugins:event', { ev: 'crashed', code, signal: signal || null });
    });
    proc.on('error', (e) => { if (h.rejectReady) h.rejectReady(e); });
    return h.ready;
  }
  function cmd(c) {
    const h = host;
    if (!h) return Promise.resolve({ ok: false, error: 'The plugin host is not running' });
    return h.ready.then(() => new Promise((resolve) => {
      const id = h.nextId++;
      h.waiting.set(id, resolve);
      if (c.cmd === 'editor' && c.show && !c.owner) c.owner = ownerHandle();
      try { h.proc.stdin.write(JSON.stringify({ ...c, id }) + '\n'); } catch (e) { h.waiting.delete(id); resolve({ ok: false, error: String(e.message || e) }); }
    }), (e) => ({ ok: false, error: String(e.message || e) }));
  }
  function stop() {
    const h = host;
    if (!h) return;
    h.quitting = true;
    try { h.proc.stdin.write(JSON.stringify({ cmd: 'quit' }) + '\n'); h.proc.stdin.end(); } catch (_) { /* gone */ }
    setTimeout(() => { try { h.proc.kill(); } catch (_) { /* gone */ } }, 1500);
    host = null;
  }
  // the FL LUA window, so plugin windows stay above it (Windows: HWND; X11: window id)
  function ownerHandle() {
    const w = getWin();
    if (!w || w.isDestroyed() || process.platform === 'darwin') return 0;
    if (process.platform === 'linux' && (process.env.XDG_SESSION_TYPE === 'wayland' || !process.env.DISPLAY)) return 0;
    try {
      const b = w.getNativeWindowHandle();
      return b.length >= 8 ? Number(b.readBigUInt64LE(0)) : b.readUInt32LE(0);
    } catch (_) { return 0; }
  }

  // ---------------------------------------------------------------- scanning
  // VST3 and CLAP files or bundles; VST2: a .dll (Windows), .so (Linux) or a .vst bundle / folder
  const isPluginName = (n) => /\.(vst3|clap|vst)$/i.test(n) || (process.platform === 'win32' ? /\.dll$/i : process.platform === 'linux' ? /\.so$/i : /^$/).test(n);
  function candidates(dir, depth = 0, out = []) {
    if (depth > 6 || out.length > 5000) return out;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return out; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (isPluginName(e.name)) out.push(p);                     // a file, or a bundle folder: not looked into
      else if (e.isDirectory() || e.isSymbolicLink()) { try { if (fs.statSync(p).isDirectory()) candidates(p, depth + 1, out); } catch (_) { /* broken link */ } }
    }
    return out;
  }
  const stamp = (p) => { try { const s = fs.statSync(p); return { mtime: Math.round(s.mtimeMs), size: s.size }; } catch (_) { return null; } };
  function scanOne(file) {
    const dir = nativeDir();
    return new Promise((resolve) => {
      execFile(hostExe(dir), ['--scan', file], { timeout: 30000, windowsHide: true, maxBuffer: 4 << 20 }, (err, stdout) => {
        try { const r = JSON.parse(String(stdout).trim().split('\n').pop()); resolve(r.ok ? { plugins: r.plugins } : r.notPlugin ? { notPlugin: true } : { error: r.error || 'No plugins in this file' }); }
        catch (_) { resolve({ error: err ? (err.killed ? 'The plugin took too long to load' : 'The plugin crashed while being checked') : 'No answer' }); }
      });
    });
  }
  let scanning = null;
  async function scan({ force = false } = {}) {
    if (scanning) return scanning;
    scanning = (async () => {
      const c = loadCache();
      if (!nativeDir()) return list();
      regFolder = await registryVstFolder();
      const files = [];
      for (const f of folders()) candidates(f, 0, files);
      const todo = files.filter((f) => { const s = stamp(f), k = c.files[f]; return force || !k || !s || k.mtime !== s.mtime || k.size !== s.size; });
      for (const f of Object.keys(c.files)) if (!files.includes(f)) delete c.files[f];         // uninstalled
      let done = 0;
      toPage('plugins:event', { ev: 'scan', done, total: todo.length });
      const workers = Array.from({ length: Math.min(4, todo.length) }, async () => {
        while (todo.length) {
          const f = todo.shift();
          toPage('plugins:event', { ev: 'scan', done, total: done + todo.length + 1, file: path.basename(f) });
          const r = await scanOne(f);
          c.files[f] = { ...(stamp(f) || {}), ...(r.plugins ? { plugins: r.plugins } : r.notPlugin ? { notPlugin: true } : { error: r.error }) };      // a library next to the plugins is remembered, not listed
          done++;
        }
      });
      await Promise.all(workers);
      c.scannedAt = Date.now();
      saveCache();
      toPage('plugins:event', { ev: 'scan', done, total: done, finished: true });
      return list();
    })();
    try { return await scanning; } finally { scanning = null; }
  }
  function list() {
    const c = loadCache();
    const plugins = [], failed = [];
    for (const [file, info] of Object.entries(c.files)) {
      if (info.plugins) plugins.push(...info.plugins);
      else if (info.error) failed.push({ path: file, error: info.error });
    }
    plugins.sort((a, b) => a.name.localeCompare(b.name));
    return { available: !!nativeDir(), plugins, failed, folders: folders(), scannedAt: c.scannedAt || 0 };
  }

  ipcMain.handle('plugins:start', async () => { const r = await start(); return { ...r, platform: plat }; });
  ipcMain.handle('plugins:cmd', (_e, c) => cmd(c || {}));
  ipcMain.handle('plugins:list', () => list());
  ipcMain.handle('plugins:scan', (_e, o) => scan(o || {}));
  ipcMain.handle('plugins:addFolder', async () => {
    const r = await dialog.showOpenDialog(getWin(), { title: 'Folder with VST3, CLAP or VST2 plugins', properties: ['openDirectory'] });
    if (r.canceled || !r.filePaths[0]) return list();
    const c = loadCache();
    if (!c.folders.includes(r.filePaths[0])) c.folders.push(r.filePaths[0]);
    c.hidden = c.hidden.filter((f) => f !== r.filePaths[0]);
    saveCache();
    return scan();
  });
  ipcMain.handle('plugins:removeFolder', (_e, f) => {
    const c = loadCache();
    if (c.folders.includes(f)) c.folders = c.folders.filter((x) => x !== f);
    else if (!c.hidden.includes(f)) c.hidden.push(f);
    for (const file of Object.keys(c.files)) if (file.startsWith(f + path.sep)) delete c.files[file];
    saveCache();
    return list();
  });
  ipcMain.handle('plugins:nativeDir', () => nativeDir());
  app.on('will-quit', stop);
  return { start, cmd, stop, scan, list };
}

module.exports = { installPlugins, defaultFolders };
