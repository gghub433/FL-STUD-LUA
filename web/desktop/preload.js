'use strict';
// The bridge between the app page and the desktop shell: native file dialogs, reading and writing the files the
// person picked (and only those), recent files, and the "save changes?" question when the window closes.
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
});
