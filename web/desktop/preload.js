'use strict';
// The bridge between the app page and the desktop shell: native file dialogs, reading and writing the files the
// person picked (and only those), recent files, the "save changes?" question when the window closes, updates and shared sessions.
const { contextBridge, ipcRenderer } = require('electron');

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
