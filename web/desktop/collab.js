'use strict';
// Collaboration in the desktop app (see collab-hub.js and src/app/collab.js). Any FL LUA can host: "Start session"
// opens a small server on this computer's local network; the others join with its address and code. Joining goes
// through this process (Node's WebSocket), because the app's page cannot open insecure connections to other machines.
const http = require('node:http');
const os = require('node:os');
const { ipcMain } = require('electron');
const { createHub } = require('./collab-hub');

const PORT = 47800;

// IPv4 addresses of this computer on the local network
function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  return out;
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    const onErr = (e) => { server.off('listening', onOk); reject(e); };
    const onOk = () => { server.off('error', onErr); resolve(server.address().port); };
    server.once('error', onErr); server.once('listening', onOk);
    server.listen(port, '0.0.0.0');
  });
}

function installCollab({ getWin }) {
  let hosting = null;            // { hub, server, local, port }
  let remote = null;             // WebSocket to another computer's hub
  const toPage = (ch, v) => { const w = getWin(); if (w && !w.isDestroyed()) w.webContents.send(ch, v); };
  const deliver = (d) => toPage('collab:message', typeof d === 'string' ? d : new Uint8Array(d));

  async function stopAll() {
    if (remote) { const r = remote; remote = null; try { r.close(); } catch (_) { /* gone */ } }
    if (hosting) {
      const h = hosting; hosting = null;
      try { h.hub.end('The host ended the session'); } catch (_) { /* ended */ }
      await new Promise((r) => { h.server.close(() => r()); setTimeout(r, 1500); });
    }
  }

  ipcMain.handle('collab:host', async (_e, o = {}) => {
    await stopAll();
    const hub = createHub();
    const server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }); res.end('FL LUA session. Join it from FL LUA: TOOLS > Collaboration > Join.\n'); });
    server.on('upgrade', (req, socket, head) => { if (!hub.handleUpgrade(req, socket, head)) socket.destroy(); });
    let port = 0;
    for (let p = Number(o.port) || PORT, tries = 0; tries < 10; p++, tries++) {
      try { port = await listen(server, p); break; } catch (e) { if (e.code !== 'EADDRINUSE') throw e; }
    }
    if (!port) throw new Error('No free network port for the session (47800–47809)');
    const { code } = hub.start();
    const local = hub.attachLocal({ name: o.name }, deliver);
    hosting = { hub, server, local, port };
    server.on('close', () => { if (hosting && hosting.server === server) hosting = null; });
    return { code, port, addresses: lanAddresses() };
  });

  ipcMain.handle('collab:join', async (_e, o = {}) => {
    await stopAll();
    const addr = String(o.address || '').trim().replace(/^(ws|http)s?:\/\//, '').replace(/\/.*$/, '');
    if (!/^[\w.:[\]-]+$/.test(addr)) throw new Error('Type the host address, for example 192.168.1.20:47800');
    const host = /:\d+$/.test(addr) ? addr : `${addr}:${PORT}`;
    const url = `ws://${host}/collab?code=${encodeURIComponent(o.code || '')}&name=${encodeURIComponent(o.name || '')}`;
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    ws.onmessage = (e) => deliver(e.data);                              // the hub greets at once: listen before the open completes
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => { try { ws.close(); } catch (_) { /* */ } reject(new Error(`No answer from ${host}. Is the session running, and are both computers on the same network?`)); }, 8000);
      ws.onopen = () => { clearTimeout(t); resolve(); };
      ws.onerror = () => { clearTimeout(t); reject(new Error(`Could not connect to ${host}`)); };
    });
    remote = ws;
    ws.onclose = () => { if (remote === ws) { remote = null; toPage('collab:closed', 'The connection to the host was lost'); } };
    return { host };
  });

  ipcMain.on('collab:send', (_e, d) => {
    const data = typeof d === 'string' ? d : Buffer.from(d.buffer ? new Uint8Array(d.buffer, d.byteOffset, d.byteLength) : new Uint8Array(d));
    if (hosting) hosting.local.send(data);
    else if (remote && remote.readyState === 1) remote.send(typeof data === 'string' ? data : new Uint8Array(data));
  });

  ipcMain.handle('collab:leave', async () => { await stopAll(); return true; });
  ipcMain.handle('collab:addresses', () => lanAddresses());
  return { stop: stopAll, get hosting() { return hosting; } };
}

module.exports = { installCollab, lanAddresses, PORT };
