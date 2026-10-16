'use strict';
// The bridge between the app page and the desktop shell: native file dialogs, reading and writing the files the
// person picked (and only those), recent files, the "save changes?" question when the window closes, updates and shared sessions.
const { contextBridge, ipcRenderer } = require('electron');
const path = require('node:path');

// VST3 / CLAP plugins: the plugin host runs as its own process (plugins.js); the bridge addon copies audio blocks
// between the engine's SharedArrayBuffer and the host's shared memory. The buffer is handed to the page by a window
// message, because objects that share memory cannot pass through the context bridge.
let bridge = null, sab = null;
function loadBridge(dir) {
  if (bridge) return bridge;
  bridge = require(path.join(dir, 'fllua_bridge.node'));
  return bridge;
}
async function connectPlugins() {
  const dir = await ipcRenderer.invoke('plugins:nativeDir');
  if (!dir) throw new Error('This build has no plugin host');
  if (!globalThis.crossOriginIsolated) throw new Error('The window is not cross-origin isolated');
  const b = loadBridge(dir);
  const layout = b.layout();
  const started = await ipcRenderer.invoke('plugins:start');
  const fresh = !sab;
  if (!sab) sab = new SharedArrayBuffer(layout.sabSize);
  const r = b.open(started.shm, new Uint8Array(sab));
  if (!r.ok) throw new Error(r.error || 'The plugin bridge did not open');
  window.postMessage({ type: 'fllua-plugins-sab', sab, layout, fresh }, '*');
  return { ok: true, layout };
}

contextBridge.exposeInMainWorld('flluaDesktop', {
  platform: process.platform,
  openDialog: (opts) => ipcRenderer.invoke('file:open-dialog', opts),        // -> { path } | null
  saveDialog: (opts) => ipcRenderer.invoke('file:save-dialog', opts),        // -> { path } | null
  read: (path) => ipcRenderer.invoke('file:read', path),                    // -> Uint8Array
  write: (path, data) => ipcRenderer.invoke('file:write', path, data),
  recent: () => ipcRenderer.invoke('recent:list'),                           // -> [path]
  addRecent: (path) => ipcRenderer.invoke('recent:add', path),
  clearRecent: () => ipcRenderer.invoke('recent:clear'),
  pendingOpen: () => ipcRenderer.invoke('open:pending'),                     // file the app was started with
  setDocument: (info) => ipcRenderer.send('doc:state', info),                // { dirty, name, path }
  closeNow: () => ipcRenderer.send('window:close-now'),
  onOpenPath: (cb) => { ipcRenderer.on('open-path', (_e, path) => cb(path)); },
  onSaveBeforeClose: (cb) => { ipcRenderer.on('save-before-close', () => cb()); },
  setZoom: (factor) => ipcRenderer.send('window:zoom', factor),
  // see-through window (Customize look): the kinds this system offers
  materials: process.platform === 'win32' ? ['acrylic', 'mica'] : process.platform === 'darwin' ? ['vibrancy'] : [],
  setMaterial: (kind) => ipcRenderer.send('window:material', kind),
  info: () => ipcRenderer.invoke('app:info'),                                // -> { version, platform, arch, updates }
  update: {                                                                  // new versions (see updater.js)
    check: () => ipcRenderer.invoke('update:check'),                         // -> { mode, current, latest, available, notes, url, error }
    download: () => ipcRenderer.invoke('update:download'),
    install: () => ipcRenderer.send('update:install'),
    open: (which) => ipcRenderer.send('update:open', which),                 // 'file' | 'page'
    onProgress: (cb) => { ipcRenderer.on('update:progress', (_e, p) => cb(p)); },
    onDownloaded: (cb) => { ipcRenderer.on('update:downloaded', (_e, v) => cb(v)); },
    onError: (cb) => { ipcRenderer.on('update:error', (_e, m) => cb(m)); },
  },
  plugins: {                                                                 // VST3 / CLAP plugins (plugins.js, native/)
    connect: () => connectPlugins(),                                         // starts the host; the buffer arrives as a 'fllua-plugins-sab' message
    cmd: (c) => ipcRenderer.invoke('plugins:cmd', c),                        // load, unload, editor, getState, setState, params, paramText, setRate
    list: () => ipcRenderer.invoke('plugins:list'),                          // -> { available, plugins, failed, folders, scannedAt }
    scan: (o) => ipcRenderer.invoke('plugins:scan', o),
    addFolder: () => ipcRenderer.invoke('plugins:addFolder'),
    removeFolder: (f) => ipcRenderer.invoke('plugins:removeFolder', f),
    stats: () => (bridge ? bridge.stats() : null),
    onEvent: (cb) => { ipcRenderer.on('plugins:event', (_e, m) => cb(m)); },
  },
  backup: {                                                                  // copies of the project in a (cloud) folder (backup.js)
    folder: () => ipcRenderer.invoke('backup:folder'),
    choose: () => ipcRenderer.invoke('backup:choose'),
    off: () => ipcRenderer.invoke('backup:off'),
    show: () => ipcRenderer.invoke('backup:show'),
    write: (title, data) => ipcRenderer.invoke('backup:write', title, data),
  },
  collab: {                                                                  // working together on the local network (collab.js)
    host: (o) => ipcRenderer.invoke('collab:host', o),                       // -> { code, port, addresses }
    join: (o) => ipcRenderer.invoke('collab:join', o),                       // { address, code, name } -> { host }
    send: (data) => ipcRenderer.send('collab:send', data),                   // string or ArrayBuffer
    leave: () => ipcRenderer.invoke('collab:leave'),
    addresses: () => ipcRenderer.invoke('collab:addresses'),
    onMessage: (cb) => { ipcRenderer.on('collab:message', (_e, d) => cb(d)); },
    onClosed: (cb) => { ipcRenderer.on('collab:closed', (_e, why) => cb(why)); },
  },
});
