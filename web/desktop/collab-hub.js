'use strict';
// Collaboration hub: several FL LUA windows on a local network work on one project. The computer that hosts the
// session runs this hub (the desktop app, or `node tools/serve.mjs` for development); everyone else connects to it
// with its address and the session code. The hub only relays: it puts every change in one order (seq), so all
// copies of the project end up the same (see src/app/collab.js), sends the host's project to a person who joins,
// and passes recorded samples between people on request. Built-ins only, including the WebSocket server (RFC 6455).
const crypto = require('node:crypto');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_MESSAGE = 512 * 1024 * 1024;          // a long stereo recording, as raw float samples
const MAX_PEOPLE = 16;
const COLORS = ['#ffb02e', '#4aa8e0', '#7fdc5c', '#e65a4b', '#c77dff', '#f3d84a', '#4fd1c5', '#ff7eb6', '#9aa5ff', '#ff9f45', '#8bd450', '#5ec8f2', '#f08a5d', '#b8de6f', '#e0a5ff', '#6ee7b7'];
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

// ---------------------------------------------------------------- WebSocket, server side
class WsConn {
  constructor(socket, head) {
    this.socket = socket;
    this.chunks = []; this.have = 0;
    this.frag = null; this.fragOp = 0; this.fragLen = 0;
    this.closed = false;
    this.onmessage = null; this.onclose = null;
    socket.setNoDelay(true);
    socket.on('data', (d) => { this.chunks.push(d); this.have += d.length; this._parse(); });
    socket.on('close', () => this._gone());
    socket.on('error', () => this._gone());
    if (head && head.length) { this.chunks.push(Buffer.from(head)); this.have += head.length; setImmediate(() => this._parse()); }
  }

  _peek(n) {
    if (this.chunks[0].length >= n) return this.chunks[0];
    const b = Buffer.concat(this.chunks); this.chunks = [b]; return b;
  }

  _take(n) {
    const out = Buffer.allocUnsafe(n);
    let o = 0;
    while (o < n) {
      const c = this.chunks[0], k = Math.min(c.length, n - o);
      c.copy(out, o, 0, k); o += k;
      if (k === c.length) this.chunks.shift(); else this.chunks[0] = c.subarray(k);
    }
    this.have -= n;
    return out;
  }

  _parse() {
    while (!this.closed && this.have >= 2) {
      const h = this._peek(Math.min(this.have, 14));
      const fin = (h[0] & 0x80) !== 0, op = h[0] & 0x0f, masked = (h[1] & 0x80) !== 0;
      let len = h[1] & 0x7f, off = 2;
      if (len === 126) { if (this.have < 4) return; len = h.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (this.have < 10) return; len = h.readUInt32BE(2) * 2 ** 32 + h.readUInt32BE(6); off = 10; }
      if (!masked) { this.close(1002); return; }                          // clients always mask
      if (len > MAX_MESSAGE || this.fragLen + len > MAX_MESSAGE) { this.close(1009); return; }
      if (this.have < off + 4 + len) return;
      this._take(off);
      const mask = this._take(4), data = this._take(len);
      for (let i = 0; i < len; i++) data[i] ^= mask[i & 3];
      this._frame(fin, op, data);
    }
  }

  _frame(fin, op, data) {
    if (op === 8) { this.close(1000); return; }
    if (op === 9) { this._write(10, data); return; }                    // ping -> pong
    if (op === 10) return;
    if (op === 0) {                                                     // continuation
      if (!this.frag) { this.close(1002); return; }
      this.frag.push(data); this.fragLen += data.length;
      if (!fin) return;
      const all = Buffer.concat(this.frag); const kind = this.fragOp;
      this.frag = null; this.fragLen = 0;
      this._deliver(kind, all);
      return;
    }
    if (op !== 1 && op !== 2) { this.close(1003); return; }
    if (!fin) { this.frag = [data]; this.fragOp = op; this.fragLen = data.length; return; }
    this._deliver(op, data);
  }

  _deliver(op, data) {
    if (!this.onmessage) return;
    try { this.onmessage(op === 1 ? data.toString('utf8') : data); } catch (_) { /* a bad message never takes the hub down */ }
  }

  _write(op, payload) {
    if (this.closed) return;
    const n = payload.length;
    const head = n < 126 ? Buffer.from([0x80 | op, n]) : n < 65536 ? Buffer.from([0x80 | op, 126, n >> 8, n & 255]) : Buffer.alloc(10);
    if (n >= 65536) { head[0] = 0x80 | op; head[1] = 127; head.writeUInt32BE(Math.floor(n / 2 ** 32), 2); head.writeUInt32BE(n >>> 0, 6); }
    this.socket.write(head);
    if (n) this.socket.write(payload);
  }

  send(data) {
    if (typeof data === 'string') this._write(1, Buffer.from(data, 'utf8'));
    else this._write(2, Buffer.isBuffer(data) ? data : Buffer.from(data.buffer ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data)));
  }

  ping() { this._write(9, Buffer.alloc(0)); }

  close(code = 1000) {
    if (this.closed) return;
    try { this._write(8, Buffer.from([code >> 8, code & 255])); } catch (_) { /* gone */ }
    this.closed = true;
    try { this.socket.end(); } catch (_) { /* gone */ }
    setTimeout(() => { try { this.socket.destroy(); } catch (_) { /* gone */ } }, 1000).unref();
    this._gone();
  }

  _gone() {
    if (this._ended) return;
    this._ended = true; this.closed = true;
    if (this.onclose) this.onclose();
  }
}

// completes the HTTP upgrade; returns the connection or null (the socket is answered and closed)
function acceptWebSocket(req, socket, head) {
  const key = req.headers['sec-websocket-key'];
  if (!key || String(req.headers.upgrade || '').toLowerCase() !== 'websocket') { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); return null; }
  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  return new WsConn(socket, head);
}

const isLoopback = (addr) => /^(127\.|::1$|::ffff:127\.)/.test(String(addr || ''));
const cleanName = (s) => String(s || '').replace(/[^\p{L}\p{N} _.'-]/gu, '').trim().slice(0, 24) || 'Guest';

// ---------------------------------------------------------------- the session
function createHub() {
  let session = null;                 // { code, hostId, clients: Map, seq }
  let nextId = 1;

  const newCode = () => { let s = ''; for (const b of crypto.randomBytes(6)) s += CODE_CHARS[b % CODE_CHARS.length]; return s; };
  const peers = () => [...session.clients.values()].map((c) => ({ id: c.id, name: c.name, color: c.color, host: c.id === session.hostId }));
  const json = (c, o) => { try { c.send(JSON.stringify(o)); } catch (_) { /* gone */ } };
  const toAll = (o, except) => { const s = JSON.stringify(o); for (const c of session.clients.values()) if (c !== except) { try { c.send(s); } catch (_) { /* gone */ } } };

  function start() {
    if (session) throw new Error('A session is already running');
    session = { code: newCode(), hostId: 0, clients: new Map(), seq: 0 };
    return { code: session.code };
  }

  // a person joins; returns an error message or null
  function join(client, { host = false, code = '', name = '' }) {
    if (!session) return 'There is no session on this computer';
    if (host ? session.hostId : String(code).trim().toUpperCase() !== session.code) return host ? 'The session already has a host' : 'Wrong session code';
    if (session.clients.size >= MAX_PEOPLE) return `The session is full (${MAX_PEOPLE} people)`;
    const used = new Set([...session.clients.values()].map((c) => c.slot));
    let slot = 0; while (used.has(slot)) slot++;
    Object.assign(client, { id: nextId++, name: cleanName(name), color: COLORS[slot % COLORS.length], slot });
    session.clients.set(client.id, client);
    if (host) session.hostId = client.id;
    json(client, { t: 'welcome', id: client.id, slot, code: session.code, hostId: session.hostId, peers: peers(), seq: session.seq });
    toAll({ t: 'peers', peers: peers(), joined: { id: client.id, name: client.name } }, client);
    if (!host) { const h = session.clients.get(session.hostId); if (h) json(h, { t: 'need-snapshot', for: client.id }); }
    return null;
  }

  function leave(client) {
    if (!session || !session.clients.has(client.id)) return;
    session.clients.delete(client.id);
    if (client.id === session.hostId) { end('The host ended the session'); return; }
    toAll({ t: 'peers', peers: peers(), left: { id: client.id, name: client.name } });
  }

  function end(reason = 'The session was ended') {
    if (!session) return;
    const all = [...session.clients.values()];
    session = null;
    for (const c of all) { json(c, { t: 'ended', reason }); try { c.close(); } catch (_) { /* gone */ } }
  }

  function message(client, data) {
    if (!session || !session.clients.has(client.id)) return;
    if (typeof data !== 'string') {                                     // binary: a sample for one person
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
      if (buf.length < 4) return;
      const n = buf.readUInt32LE(0);
      if (n > 65536 || buf.length < 4 + n) return;
      let head; try { head = JSON.parse(buf.subarray(4, 4 + n).toString('utf8')); } catch (_) { return; }
      const to = session.clients.get(head && head.to);
      if (to && head.t === 'sample') to.send(buf);
      return;
    }
    let m; try { m = JSON.parse(data); } catch (_) { return; }
    if (!m || typeof m.t !== 'string') return;
    switch (m.t) {
      case 'patch': case 'param': case 'project':                      // changes: one order for everyone, the sender included
        m.from = client.id; m.seq = ++session.seq;
        toAll(m);
        break;
      case 'snapshot': {                                                 // the host's project for a person who joined
        if (client.id !== session.hostId) return;
        const to = session.clients.get(m.to);
        if (to) json(to, m);
        break;
      }
      case 'want-sample':                                               // who has this recording?
        m.from = client.id;
        toAll(m, client);
        break;
      default: break;
    }
  }

  // a WebSocket upgrade on /collab: ?code=…&name=… joins; ?host=1 (only from this computer, when allowed) hosts
  function handleUpgrade(req, socket, head, { allowHost = false } = {}) {
    const url = new URL(req.url, 'http://x');
    if (url.pathname !== '/collab') { socket.destroy(); return false; }
    const ws = acceptWebSocket(req, socket, head);
    if (!ws) return true;
    const wantHost = url.searchParams.get('host') === '1';
    if (wantHost && !(allowHost && isLoopback(req.socket.remoteAddress))) { ws.send(JSON.stringify({ t: 'error', message: 'Only FL LUA on this computer can host here' })); ws.close(1008); return true; }
    if (wantHost && !session) start();
    const client = { send: (d) => ws.send(d), close: () => ws.close() };
    const err = join(client, { host: wantHost, code: url.searchParams.get('code'), name: url.searchParams.get('name') });
    if (err) { ws.send(JSON.stringify({ t: 'error', message: err })); ws.close(1008); return true; }
    ws.onmessage = (d) => message(client, d);
    ws.onclose = () => { clearInterval(client.ping); leave(client); };
    client.ping = setInterval(() => ws.ping(), 20000);
    client.ping.unref();
    return true;
  }

  // the host's own window, in the same process (the desktop app): deliver(data) receives what the hub sends
  function attachLocal({ name }, deliver) {
    const client = { send: (d) => deliver(d), close: () => {} };
    const err = join(client, { host: true, name });
    if (err) throw new Error(err);
    return { send: (d) => message(client, d), close: () => leave(client) };
  }

  return {
    start, end, handleUpgrade, attachLocal,
    get active() { return !!session; },
    get info() { return session ? { code: session.code, people: session.clients.size } : null; },
  };
}

module.exports = { createHub, acceptWebSocket, isLoopback };
