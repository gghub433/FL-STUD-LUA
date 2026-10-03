// Working together on one project over the local network (TOOLS > Collaboration…).
//   Any FL LUA desktop app can host: it opens a small server on this computer (desktop/collab-hub.js) and shows its
//   address and a session code; the others join with both. Whoever stops hosting ends the session, everyone keeps the
//   project, and anyone can host the next one.
// How the copies stay the same:
//   * every edit is sent as the changes it made to the part of the project it touched (core/json-merge.js: lists of
//     things with ids — channels, notes, clips, markers — change item by item), knob moves as parameter values.
//     The hub numbers all changes in one order and sends them to everyone, the sender included.
//   * each copy keeps the project as the hub ordered it so far ("confirmed"). Someone else's change is applied to it
//     and to the working project; my changes the hub has not confirmed yet come later in its order, so they are
//     applied again on top. When nothing of mine is waiting, the working project is checked against the confirmed one.
//   * the host's project goes to a person who joins, with the changes made meanwhile; recordings and imported audio
//     are fetched from whoever has them, when needed.
//   * undo takes back only my own edits (store.setSelectiveUndo); the current pattern, the selected mixer track and
//     the arrangement shown stay personal; new ids come from a range of my own, so two people never make the same.
import { h, clear } from '../ui/h.js';
import { modal, toast, confirmBox } from '../ui/dialog.js';
import { getPath, setPath } from './store.js';
import { normalize, setIdAllocator } from '../core/project.js';
import { setParam as setProjectParam } from '../core/addr.js';
import { diffOps, applyOps } from '../core/json-merge.js';
import { idbGet } from '../host/idb.js';

const PORT = 47800;
const PREFS = 'fllua.collab';
const SEND_MS = 40;                         // knob drags and note drags are sent at most every 40 ms per target
const VIEW = [['currentPattern'], ['mixer', 'selected'], ['playlist', 'current'], ['seq']];     // personal, never shared

const loadPrefs = () => { try { return { name: '', address: '', ...(JSON.parse(localStorage.getItem(PREFS) || '{}') || {}) }; } catch (_) { return { name: '', address: '' }; } };
const savePrefs = (p) => { try { localStorage.setItem(PREFS, JSON.stringify(p)); } catch (_) { /* private mode */ } };
const pathKey = (p) => p.join('\u0001');
const overlaps = (a, b) => { const n = Math.min(a.length, b.length); for (let i = 0; i < n; i++) if (a[i] !== b[i]) return false; return true; };
const isView = (p) => VIEW.some((v) => v.length === p.length && v.every((x, i) => x === p[i]));
const skipView = (base) => (sub) => isView([...base, ...sub]);
const validOps = (ops) => Array.isArray(ops) && ops.length < 20000 && ops.every((o) => o && typeof o === 'object' && Array.isArray(o.p || []));
const validPath = (p) => Array.isArray(p) && p.length > 0 && p.length <= 8 && p.every((k) => (typeof k === 'string' && k.length < 80 && !['__proto__', 'constructor', 'prototype'].includes(k)) || (Number.isInteger(k) && k >= 0));
const copy = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

// ---- samples travel as binary: [header length][header JSON][float samples, channel after channel]
function packSample(head, channels) {
  const hb = new TextEncoder().encode(JSON.stringify(head));
  const len = channels[0].length;
  const buf = new ArrayBuffer(4 + hb.length + channels.length * len * 4 + 4);
  new DataView(buf).setUint32(0, hb.length, true);
  new Uint8Array(buf, 4, hb.length).set(hb);
  const off = (4 + hb.length + 3) & ~3;                                  // floats start 4-byte aligned
  channels.forEach((c, i) => new Float32Array(buf, off + i * len * 4, len).set(c));
  return buf;
}
function unpackSample(data) {
  const buf = data instanceof ArrayBuffer ? data : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  const n = new DataView(buf).getUint32(0, true);
  const head = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, n)));
  const off = (4 + n + 3) & ~3, len = head.length | 0;
  const channels = [];
  for (let i = 0; i < Math.min(2, head.n | 0); i++) channels.push(new Float32Array(buf.slice(off + i * len * 4, off + (i + 1) * len * 4)));
  return { head, channels };
}

// ---- how this copy of FL LUA talks to the hub
function desktopLink(bridge) {
  let onMsg = null, onEnd = null;
  bridge.onMessage((d) => onMsg && onMsg(d));
  bridge.onClosed((why) => onEnd && onEnd(why));
  // errors thrown in the main process arrive as "Error invoking remote method 'x': Error: …"
  const clean = (p) => p.catch((e) => { throw new Error(String(e && e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')); });
  return {
    canHost: true,
    host: (o) => clean(bridge.host(o)),
    join: (o) => clean(bridge.join(o)),
    send: (d) => bridge.send(d),
    close: () => bridge.leave(),
    set onmessage(f) { onMsg = f; }, set onend(f) { onEnd = f; },
  };
}
// in a browser: the page itself connects (hosting works when the page comes from `node tools/serve.mjs` on this computer)
function browserLink() {
  let ws = null, onMsg = null, onEnd = null;
  const open = (url) => new Promise((resolve, reject) => {
    const s = new WebSocket(url);
    s.binaryType = 'arraybuffer';
    const t = setTimeout(() => { try { s.close(); } catch (_) { /* */ } reject(new Error('No answer. Is the session running, and are both computers on the same network?')); }, 8000);
    s.onopen = () => { clearTimeout(t); ws = s; resolve(); };
    s.onerror = () => { clearTimeout(t); reject(new Error('Could not connect')); };
    s.onmessage = (e) => onMsg && onMsg(e.data);
    s.onclose = () => { if (ws === s) { ws = null; if (onEnd) onEnd('The connection to the host was lost'); } };
  });
  return {
    canHost: /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname) && location.protocol === 'http:',
    async host(o) { await open(`ws://${location.host}/collab?host=1&name=${encodeURIComponent(o.name || '')}`); return { port: +location.port || 80, addresses: [] }; },
    async join(o) {
      const addr = String(o.address || '').trim().replace(/^(ws|http)s?:\/\//, '').replace(/\/.*$/, '');
      const host = /:\d+$/.test(addr) ? addr : `${addr}:${PORT}`;
      await open(`ws://${host}/collab?code=${encodeURIComponent(o.code || '')}&name=${encodeURIComponent(o.name || '')}`);
      return { host };
    },
    send: (d) => { if (ws && ws.readyState === 1) ws.send(d); },
    close: () => { const s = ws; ws = null; if (s) s.close(); return Promise.resolve(); },
    set onmessage(f) { onMsg = f; }, set onend(f) { onEnd = f; },
  };
}

export function installCollab(app) {
  const store = app.store, bank = app.bank;
  const desk = window.flluaDesktop;
  const link = desk && desk.collab ? desktopLink(desk.collab) : browserLink();
  const c = app.collab = {
    state: 'off',           // off | connecting | on
    host: false, id: 0, code: '', port: 0, addresses: [], hostAddress: '', peers: [],
    prefs: loadPrefs(), canHost: link.canHost,
    stats: { sent: 0, confirmed: 0, applied: 0, rebased: 0 },
  };
  const emit = () => store.bus.emit('collab', c);

  let lastSeq = 0, lid = 0, slot = 0, nextLocal = 0;
  let shadow = null;                 // the project as the hub ordered it so far
  let pending = [];                  // my changes the hub has not confirmed: { lid, path, ops } | { lid, addr, v }
  let waiting = false, early = [];   // a joiner waits for the host's project; changes that arrive first wait too
  let applying = false;              // applying someone else's change: never sent back
  let ourProject = null;             // a project being loaded from the session (its 'replaced' event is not sent)
  const outbox = new Map();          // throttled: key -> { t, path | addr } (the change is read when sent)
  let flushTimer = 0, checkTimer = 0;
  const wants = new Map();           // sample id -> { promise, resolve }

  const send = (o) => link.send(typeof o === 'string' ? o : JSON.stringify(o));
  // start() and join() resolve when the session is ready (welcome / the host's project) or fail with the hub's reason
  let ready = null;
  const waitReady = () => new Promise((resolve, reject) => {
    const t = setTimeout(() => { ready = null; reject(new Error('The session did not answer in time')); }, 20000);
    ready = { resolve: () => { clearTimeout(t); ready = null; resolve(); }, reject: (e) => { clearTimeout(t); ready = null; reject(e); } };
  });

  // applies ops at path to a project (the working one or the confirmed copy); returns the new value there
  const applyAt = (proj, path, ops) => { const root = getPath(proj, path), r = applyOps(root === undefined ? undefined : root, copy(ops)); if (r !== root) setPath(proj, path, r); return r; };
  const notify = (path) => store.applyRemote(path, getPath(store.project, path));       // engine + windows

  // ---------------------------------------------------------------- outgoing
  function queue(key, msg) { outbox.set(key, msg); if (!flushTimer) flushTimer = setTimeout(flush, SEND_MS); }
  function flush() {
    clearTimeout(flushTimer); flushTimer = 0;
    if (c.state !== 'on') { outbox.clear(); return; }
    for (const msg of outbox.values()) {
      if (msg.t === 'patch') {
        const ops = diffOps(getPath(shadow, msg.path), getPath(store.project, msg.path), skipView(msg.path));
        if (!ops.length) continue;
        const m = { t: 'patch', lid: ++lid, path: msg.path, ops };
        pending.push({ lid: m.lid, path: m.path, ops: copy(ops) });
        send(m);
      } else {
        const v = store.getParam(msg.addr);
        if (v === undefined) continue;
        const m = { t: 'param', lid: ++lid, addr: msg.addr, v };
        pending.push({ lid: m.lid, addr: m.addr, v });
        send(m);
      }
      c.stats.sent++;
    }
    outbox.clear();
  }
  store.bus.on('change', ({ paths, remote }) => {
    if (c.state !== 'on' || remote || applying) return;
    for (const p of paths) if (!isView(p)) queue(`p:${pathKey(p)}`, { t: 'patch', path: p });
  });
  store.bus.on('user-param', (addr) => { if (c.state === 'on' && !applying) queue(`a:${addr}`, { t: 'param', addr }); });
  store.bus.on('replaced', (p) => {                                    // a project opened here goes to everyone
    if (c.state !== 'on' || p === ourProject) return;
    outbox.clear(); pending = [];
    shadow = copy(p);
    send({ t: 'project', lid: ++lid, project: p });
  });

  // ---------------------------------------------------------------- incoming
  link.onmessage = (data) => {
    if (typeof data !== 'string') { onSample(data); return; }
    let m; try { m = JSON.parse(data); } catch (_) { return; }
    switch (m.t) {
      case 'welcome': return welcome(m);
      case 'peers': return peersChanged(m);
      case 'need-snapshot': flush(); send({ t: 'snapshot', to: m.for, seq: lastSeq, project: shadow }); return;
      case 'snapshot': return snapshot(m);
      case 'patch': case 'param': case 'project': if (waiting) early.push(m); else relayed(m); return;
      case 'want-sample': giveSample(m); return;
      case 'ended': finish(m.reason || 'The session ended'); return;
      case 'error': if (ready) ready.reject(new Error(m.message)); else toast(`Session: ${m.message}`, 5000); return;
      default: break;
    }
  };
  link.onend = (why) => { if (c.state !== 'off') finish(why || 'The session ended'); };

  function welcome(m) {
    c.id = m.id; c.code = m.code; c.peers = m.peers || []; c.host = m.hostId === m.id;
    slot = m.slot | 0; lastSeq = m.seq | 0;
    if (c.host) begin(); else { waiting = true; early = []; }
    emit();
  }

  function begin() {
    c.state = 'on';
    pending = [];
    shadow = copy(store.project);
    store.setSelectiveUndo(true);
    nextLocal = Math.floor(store.project.seq / 64) + 2;
    setIdAllocator((p) => { const id = nextLocal++ * 64 + slot; if (p.seq <= id) p.seq = id + 1; return id; });
    bank.remoteFetch = fetchSample;
    emit();
    if (ready) ready.resolve();
  }

  async function snapshot(m) {
    if (!waiting) return;
    let p;
    try { p = normalize(m.project); ourProject = p; await store.replaceProject(p); }
    catch (err) { ourProject = null; finish(`The session’s project could not be opened: ${err.message || err}`); link.close(); return; }
    ourProject = null;
    lastSeq = m.seq | 0;
    waiting = false;
    begin();
    for (const x of early.splice(0)) if (x.seq > lastSeq) relayed(x);
    checkSamples();
    toast(`Joined the session (${c.peers.length} ${c.peers.length === 1 ? 'person' : 'people'})`);
  }

  function relayed(m) {
    if (m.seq <= lastSeq) return;
    lastSeq = m.seq;
    const mine = m.from === c.id;
    if (m.t === 'project') { if (!mine) remoteProject(m.project); return; }
    if (m.t === 'patch' && !(validPath(m.path) && validOps(m.ops))) return;
    if (m.t === 'param' && !(typeof m.addr === 'string' && Number.isFinite(m.v))) return;
    // the confirmed copy follows the hub's order, mine included
    if (m.t === 'patch') applyAt(shadow, m.path, m.ops); else setProjectParam(shadow, m.addr, m.v);
    if (mine) {
      pending = pending.filter((x) => x.lid !== m.lid);
      c.stats.confirmed++;
      if (!pending.length) scheduleCheck();
      return;
    }
    c.stats.applied++;
    flush();                                                            // my unsent changes become pending first
    applying = true;
    try {
      if (m.t === 'patch') { applyAt(store.project, m.path, m.ops); notify(m.path); }
      else store.setParam(m.addr, m.v, { noUndo: true, remote: true, force: true });
      // mine that the hub has not numbered yet come after this one: put them back on top
      for (const x of pending) {
        if (x.path && m.t === 'patch' && overlaps(x.path, m.path)) { applyAt(store.project, x.path, x.ops); notify(x.path); c.stats.rebased++; }
        else if (x.addr && (m.t === 'patch' || x.addr === m.addr)) { store.setParam(x.addr, x.v, { noUndo: true, remote: true, force: true }); c.stats.rebased++; }
      }
    } finally { applying = false; }
    if (!pending.length) scheduleCheck();
    checkSamples();
  }

  // when nothing of mine is waiting, the working project must equal the confirmed one: repair what differs
  function scheduleCheck() { clearTimeout(checkTimer); checkTimer = setTimeout(check, 250); }
  function check() {
    if (c.state !== 'on' || pending.length || outbox.size) return;
    const ops = diffOps(store.project, shadow, (p) => isView(p));
    if (!ops.length) return;
    c.stats.repaired = (c.stats.repaired || 0) + 1;
    applying = true;
    try {
      applyOps(store.project, copy(ops));
      const tops = new Set(ops.map((o) => (o.p && o.p.length ? o.p[0] : null)));
      for (const k of tops) if (k !== null) notify([k]);
    } finally { applying = false; }
  }

  async function remoteProject(raw) {
    let p;
    try { p = normalize(raw); } catch (err) { toast(`A project opened in the session could not be read: ${err.message || err}`, 5000); return; }
    ourProject = p;
    pending = []; outbox.clear();
    shadow = copy(p);
    await store.replaceProject(p);
    ourProject = null;
    store.setSelectiveUndo(true);
    nextLocal = Math.max(nextLocal, Math.floor(p.seq / 64) + 2);
    toast('Another project was opened in the session');
  }

  let sampleTimer = 0;
  function checkSamples() { clearTimeout(sampleTimer); sampleTimer = setTimeout(() => { bank.ensureProject(store.project); }, 150); }

  // ---------------------------------------------------------------- recordings and imported audio
  function fetchSample(id) {
    if (c.state !== 'on') return Promise.resolve(null);
    if (wants.has(id)) return wants.get(id).promise;
    let resolve;
    const promise = new Promise((r) => { resolve = r; });
    const timer = setTimeout(() => { wants.delete(id); resolve(null); }, 30000);
    wants.set(id, { promise, resolve: (v) => { clearTimeout(timer); wants.delete(id); resolve(v); } });
    send({ t: 'want-sample', id });
    return promise;
  }
  async function giveSample(m) {
    if (typeof m.id !== 'string' || !m.id.startsWith('user:')) return;
    let e = bank.get(m.id);
    if (!e) { const rec = await idbGet('samples', m.id).catch(() => null); if (rec) e = { name: rec.name, rate: rec.rate, channels: rec.channels }; }
    if (!e || !e.channels || !e.channels.length) return;
    link.send(packSample({ t: 'sample', to: m.from, id: m.id, name: e.name, rate: e.rate, n: e.channels.length, length: e.channels[0].length }, e.channels));
  }
  function onSample(data) {
    let s; try { s = unpackSample(data); } catch (_) { return; }
    const w = wants.get(s.head.id);
    if (w && s.channels.length && s.head.rate > 0) w.resolve({ name: String(s.head.name || 'Sample').slice(0, 80), rate: s.head.rate, channels: s.channels });
  }

  // ---------------------------------------------------------------- people
  function peersChanged(m) {
    c.peers = m.peers || [];
    if (m.joined && m.joined.id !== c.id) toast(`${m.joined.name} joined the session`);
    if (m.left) toast(`${m.left.name} left the session`);
    emit();
  }

  function finish(reason) {
    const was = c.state;
    c.state = 'off'; c.host = false; c.peers = []; c.code = ''; c.addresses = [];
    waiting = false; early = []; pending = []; outbox.clear(); shadow = null;
    clearTimeout(checkTimer);
    for (const w of [...wants.values()]) w.resolve(null);
    setIdAllocator(null);
    bank.remoteFetch = null;
    // ids made in the session: the project's counter continues after the highest one
    try { store.project.seq = Math.max(store.project.seq, normalize(JSON.parse(JSON.stringify(store.project))).seq); } catch (_) { /* keep */ }
    store.setSelectiveUndo(false);
    if (ready) ready.reject(new Error(reason || 'The session ended'));
    else if (was !== 'off' && reason) toast(reason, 4000);
    emit();
  }

  // ---------------------------------------------------------------- actions
  c.start = async (name) => {
    if (c.state !== 'off') return c;
    c.prefs.name = String(name || c.prefs.name || '').slice(0, 24); savePrefs(c.prefs);
    c.state = 'connecting'; emit();
    try {
      const until = waitReady();
      const r = await link.host({ name: c.prefs.name || 'Host' });
      c.port = r.port || 0; c.addresses = r.addresses || [];
      await until;
      emit();
      return c;
    } catch (err) { if (ready) ready.reject(err); c.state = 'off'; emit(); link.close(); throw err; }
  };
  c.join = async (address, code, name) => {
    if (c.state !== 'off') return c;
    c.prefs.name = String(name || c.prefs.name || '').slice(0, 24); c.prefs.address = String(address || '').trim(); savePrefs(c.prefs);
    c.state = 'connecting'; emit();
    try {
      const until = waitReady();
      const r = await link.join({ address: c.prefs.address, code: String(code || '').trim().toUpperCase(), name: c.prefs.name || 'Guest' });
      c.hostAddress = r.host || c.prefs.address;
      await until;
      return c;
    } catch (err) { if (ready) ready.reject(err); c.state = 'off'; emit(); link.close(); throw err; }
  };
  c.leave = async () => {
    if (c.state === 'off') return;
    flush();
    const host = c.host;
    finish(host ? 'You ended the session' : 'You left the session');
    await link.close();
  };
  c.open = () => openCollabDialog(app);

  // the status bar shows the session
  const bar = document.getElementById('statusbar');
  if (bar) {
    const el = h('span#status-collab.collab-badge', { hint: 'Collaboration on the local network — click for the session', onclick: () => c.open() });
    bar.insertBefore(el, document.getElementById('status-audio'));
    const show = () => {
      el.textContent = c.state === 'on' ? `● ${c.host ? 'Hosting' : 'Session'} · ${c.peers.length}` : c.state === 'connecting' ? '● Connecting…' : '';
      el.style.display = c.state === 'off' ? 'none' : '';
    };
    store.bus.on('collab', show);
    show();
  }
  window.addEventListener('beforeunload', () => { if (c.state !== 'off') link.close(); });
  return c;
}

// ---------------------------------------------------------------- the window
export function openCollabDialog(app) {
  const c = app.collab, store = app.store;
  const body = h('div.collab');
  const nameIn = h('input.field', { type: 'text', value: c.prefs.name, placeholder: 'Your name', maxLength: 24, style: { width: '180px' } });
  const addrIn = h('input.field', { type: 'text', value: c.prefs.address, placeholder: '192.168.1.20:47800', style: { width: '180px' } });
  const codeIn = h('input.field', { type: 'text', placeholder: 'ABC123', maxLength: 6, style: { width: '90px', textTransform: 'uppercase' } });
  for (const i of [nameIn, addrIn, codeIn]) i.addEventListener('keydown', (e) => e.stopPropagation());
  const msg = h('div.collab-msg');
  const btn = (label, fn, primary) => h('button.btn' + (primary ? '.primary' : ''), { onclick: fn }, label);
  const fail = (err) => { msg.textContent = String(err && err.message || err); msg.className = 'collab-msg err'; };

  const render = () => {
    clear(body);
    if (c.state === 'off') {
      body.append(
        h('div.collab-row', h('span.dim', 'Your name'), nameIn),
        h('div.mx-title', 'Host a session on this computer'),
        h('div.dim.collab-p', c.canHost
          ? 'This computer becomes the server: the others join with its address and a code. Your project is the one everybody works on. Stop the session and anyone can host the next one.'
          : 'Hosting needs the FL LUA desktop app (a browser cannot open a server). You can join a session from here.'),
        c.canHost ? btn('Start session', async () => { msg.textContent = ''; try { await c.start(nameIn.value); } catch (err) { fail(err); } }, true) : null,
        h('div.mx-title', 'Join a session'),
        h('div.dim.collab-p', 'Type the address and the code that the host’s FL LUA shows. Your current project is replaced by the session’s project (save it first if you need it).'),
        h('div.collab-row', h('span.dim', 'Address'), addrIn, h('span.dim', 'Code'), codeIn,
          btn('Join', async () => {
            msg.textContent = '';
            if (store.dirty && store.project.channels.length && !(await confirmBox('Join session', 'Your unsaved changes in this project will be replaced by the session’s project. Join?', 'Join'))) return;
            try { await c.join(addrIn.value, codeIn.value, nameIn.value); } catch (err) { fail(err); }
          })),
        msg);
      return;
    }
    if (c.state === 'connecting' && !c.code) { body.append(h('div.collab-p', 'Connecting…'), msg); return; }
    const addrs = c.host ? (c.addresses.length ? c.addresses.map((a) => `${a}:${c.port}`) : [`this computer:${c.port}`]) : [c.hostAddress];
    body.append(
      h('div.collab-code', h('span.dim', c.host ? 'Session code' : 'Connected to'), h('b', c.host ? c.code : addrs[0])),
      c.host ? h('div.collab-p', h('span.dim', 'Address for the others: '), ...addrs.map((a, i) => [i ? ', ' : '', h('b.collab-addr', a)]).flat()) : null,
      c.host ? h('div.dim.collab-p', 'On the other computers: TOOLS > Collaboration… > Join, with this address and code. They must be on the same network (Wi-Fi or cable); allow FL LUA in the firewall if asked.') : null,
      h('div.mx-title', `People (${c.peers.length})`),
      h('div.collab-people', ...c.peers.map((p) => h('div.collab-person', h('i', { style: { background: p.color } }), h('span', p.name + (p.id === c.id ? ' (you)' : '')), p.host ? h('span.dim', 'host') : null))),
      h('div.dim.collab-p', 'Edits, knob moves, new channels and recordings reach everyone at once. Undo takes back only your own edits. Playback and the current pattern stay your own.'),
      h('div.collab-row', btn(c.host ? 'Stop session' : 'Leave session', () => c.leave(), false)),
      msg);
  };
  const off = store.bus.on('collab', render);
  render();
  modal({ title: 'Collaboration', body, width: 520, buttons: [{ label: 'Close' }], onClose: () => off() });
}
