// VST3 and CLAP plugins in the desktop app (app.plugins). The plugin host is a separate process (desktop/native);
// this module keeps it in step with the project:
//   - connects once: the preload hands over the shared ring (SharedArrayBuffer), the engine attaches to it
//   - every channel / mixer slot of type 'plugin' gets a running instance in a slot of the ring (load / unload)
//   - the plugin's own window: openEditor / closeEditor; knobs turned there come back as parameter changes
//   - its settings (state) go into the project before saving, when it reports a change, and every few seconds
//   - export renders with the same instances (the live engine pauses them meanwhile)
// In the browser version there is no plugin host: app.plugins.available is false.
import { pluginUses } from '../core/plugin-link.js';
import { paramListOf, normalizePluginRef } from '../core/plugin-schema.js';
import { matches as layoutMatches, SLOTS } from '../core/plugin-layout.js';
import { createFxSlot } from '../core/project.js';
import { usePluginHook } from '../host/export/render-client.js';
import { toast } from '../ui/dialog.js';

const K_KEY = 'fllua.plugins.k';

export function installNativePlugins(app) {
  const store = app.store, host = app.host;
  const desk = window.flluaDesktop && window.flluaDesktop.plugins;
  const P = app.plugins = {
    available: !!desk, connected: false, error: '',
    catalog: { plugins: [], failed: [], folders: [], scannedAt: 0, available: false },
    scanning: null,                 // { done, total, file } while a scan runs
    items: new Map(),               // owner -> { inst, slot, latency, hasEditor, editorOpen, params, values, hasInput }
    status: null,                   // owner -> { state: 'loading' | 'ready' | 'error' | 'missing', error }
    K: (() => { try { return Math.max(2, Math.min(6, +localStorage.getItem(K_KEY) || 3)); } catch (_) { return 3; } })(),
  };
  const emit = () => store.bus.emit('plugins', P);
  // statuses change rarely: the channel rack listens to this, not to every 'plugins' event
  const statusMap = new Map();
  P.status = { get: (k) => statusMap.get(k), has: (k) => statusMap.has(k), keys: () => statusMap.keys(),
    set: (k, v) => { statusMap.set(k, v); store.bus.emit('plugins-status'); }, delete: (k) => { statusMap.delete(k); store.bus.emit('plugins-status'); },
    clear: () => { statusMap.clear(); store.bus.emit('plugins-status'); } };
  // what the rest of the app may call in the browser version too (no plugin host there)
  P.statusOf = (owner) => P.status.get(owner) || null;
  P.item = () => null;
  P.sync = async () => {};
  P.reload = async () => {};
  P.paramTexts = async () => [];
  P.openEditor = async () => false;
  P.closeEditor = async () => {};
  if (!desk) return P;
  const free = new Set(Array.from({ length: SLOTS }, (_, i) => i));
  let sab = null, connecting = null;

  // ---------------------------------------------------------------- connection
  const linkAll = () => {
    host.send({ t: 'plug', op: 'attach', sab, K: P.K });
    for (const [owner, it] of P.items) host.send({ t: 'plug', op: 'link', owner, slot: it.slot, latency: it.latency });
  };
  P.connect = () => connecting || (connecting = (async () => {
    const got = new Promise((resolve, reject) => {
      const on = (e) => { if (e.source === window && e.data && e.data.type === 'fllua-plugins-sab') { window.removeEventListener('message', on); resolve(e.data); } };
      window.addEventListener('message', on);
      setTimeout(() => { window.removeEventListener('message', on); reject(new Error('The plugin bridge did not answer')); }, 20000);
    });
    await desk.connect();
    const m = await got;
    if (!layoutMatches(m.layout)) throw new Error('The plugin bridge is a different version than the app');
    sab = m.sab;
    await desk.cmd({ cmd: 'setRate', sampleRate: host.sampleRate });
    linkAll();
    P.connected = true; P.error = '';
    emit();
  })().catch((err) => { connecting = null; P.error = String(err && err.message || err); emit(); throw err; }));

  host.bus.on('restarted', async () => {         // a new audio engine (other sample rate or device)
    if (!P.connected) return;
    await desk.cmd({ cmd: 'setRate', sampleRate: host.sampleRate });
    linkAll();
  });

  // ---------------------------------------------------------------- the plugins follow the project
  const ownerOf = (inst) => { for (const [o, it] of P.items) if (it.inst === inst) return o; return null; };
  const useOf = (owner) => pluginUses(store.project).find((u) => u.owner === owner) || null;
  // the parameter address of a plugin parameter, for knobs and automation
  P.addrOf = (owner, pid) => {
    if (owner.startsWith('ch:')) return `${owner}:p:${pid}`;
    const u = useOf(owner);
    return u ? `mx:${u.track}:fx:${u.slot}:p:${pid}` : null;
  };

  let chain = Promise.resolve();
  P.sync = () => (chain = chain.then(doSync).catch((err) => console.warn('[plugins]', err)));
  async function doSync() {
    dedupe();
    const uses = pluginUses(store.project);
    if (!uses.length && !P.items.size) return;
    if (!P.connected) {
      try { await P.connect(); } catch (err) {
        for (const u of uses) P.status.set(u.owner, { state: 'error', error: P.error || String(err.message || err) });
        emit();
        return;
      }
    }
    const want = new Map(uses.map((u) => [u.owner, u]));
    for (const [owner, it] of [...P.items]) {
      const u = want.get(owner);
      if (!u || u.data.path !== it.path || u.data.uid !== it.uid) await unload(owner);
    }
    for (const owner of [...P.status.keys()]) if (!want.has(owner)) P.status.delete(owner);
    for (const u of uses) {
      if (P.items.has(u.owner)) { if (!P.status.has(u.owner)) P.status.set(u.owner, { state: 'ready', path: u.data.path }); continue; }
      const st = P.status.get(u.owner);
      if (st && (st.state === 'error' || st.state === 'missing') && st.path === u.data.path) continue;       // P.reload asks again
      await load(u);
    }
    emit();
  }

  async function load(u) {
    const slot = Math.min(...free);
    if (!Number.isFinite(slot)) { P.status.set(u.owner, { state: 'error', error: `At most ${SLOTS} plugins can run at the same time`, path: u.data.path }); return; }
    free.delete(slot);
    P.status.set(u.owner, { state: 'loading', path: u.data.path });
    emit();
    const r = await desk.cmd({ cmd: 'load', format: u.data.format, path: u.data.path, uid: u.data.uid, slot, sampleRate: host.sampleRate, state: u.data.state || '' });
    if (!r.ok) {
      free.add(slot);
      const missing = /no binary|could not load|not a vst3|no clap_entry|no class|no plugin/i.test(r.error || '');
      P.status.set(u.owner, { state: missing ? 'missing' : 'error', error: r.error || 'Could not load the plugin', path: u.data.path });
      toast(`${u.data.name || 'Plugin'}: ${missing ? 'not installed on this computer' : r.error}`, 5000);
      return;
    }
    if (!useOf(u.owner)) { await desk.cmd({ cmd: 'unload', inst: r.inst }); free.add(slot); return; }      // removed meanwhile
    P.items.set(u.owner, { inst: r.inst, slot, latency: r.latency || 0, hasEditor: !!r.hasEditor, editorOpen: false, params: r.params || [], values: r.values || {}, hasInput: !!r.hasInput, path: u.data.path, uid: u.data.uid });
    P.status.set(u.owner, { state: 'ready', path: u.data.path, stateError: r.stateError || '' });
    // the parameter list and the names go into the project (knobs and automation work without the plugin too)
    const list = paramListOf(r.params);
    const info = r.info || {};
    // ...and the plugin's current values, so knobs show where it really is
    const values = r.values || {};
    const differs = list.some(([id]) => values[id] !== undefined && u.params[String(id)] !== values[id]);
    if (differs || JSON.stringify(list) !== JSON.stringify(u.data.params) || (!u.data.name && info.name)) {
      store.edit('Plugin parameters', () => {
        const d = useOf(u.owner);
        if (!d) return;
        d.data.params = list;
        if (!d.data.name) d.data.name = info.name || '';
        if (!d.data.vendor) d.data.vendor = info.vendor || '';
        for (const [id] of list) if (typeof values[id] === 'number') d.params[String(id)] = values[id];
      }, [sectionOf(u.owner)], { noUndo: true });
    }
    host.send({ t: 'plug', op: 'link', owner: u.owner, slot, latency: r.latency || 0 });
  }

  async function unload(owner) {
    const it = P.items.get(owner);
    if (!it) return;
    P.items.delete(owner);
    host.send({ t: 'plug', op: 'link', owner, slot: -1 });
    await desk.cmd({ cmd: 'unload', inst: it.inst });
    free.add(it.slot);
  }

  const sectionOf = (owner) => {
    if (owner.startsWith('ch:')) return ['channels'];
    const u = useOf(owner);
    return u ? ['mixer', 'tracks', u.track] : ['mixer'];
  };

  // a copied mixer slot carries the same plugin id: give the copy its own (it then loads its own instance)
  function dedupe() {
    const seen = new Set(), fix = [];
    store.project.mixer.tracks.forEach((t, n) => t.fx.forEach((s, i) => {
      const id = s && s.type === 'plugin' && s.extra && s.extra.plugin && s.extra.plugin.id;
      if (!id) return;
      if (seen.has(id)) fix.push([n, i]); else seen.add(id);
    }));
    if (fix.length) store.edit('Plugin copy', (p) => { for (const [n, i] of fix) { const s = p.mixer.tracks[n].fx[i]; s.extra = { plugin: normalizePluginRef({ ...s.extra.plugin, id: '' }, true) }; } }, fix.map(([n]) => ['mixer', 'tracks', n]), { noUndo: true });
  }

  let timer = 0;
  const soon = () => { clearTimeout(timer); timer = setTimeout(() => P.sync(), 30); };
  store.bus.on('change', ({ paths }) => { if (paths.some((p) => p[0] === 'channels' || p[0] === 'mixer')) soon(); });
  // another project (opened, new, reopened): its plugins load with their own saved states
  store.bus.on('replaced', () => {
    for (const owner of [...P.items.keys()]) P.status.delete(owner);
    chain = chain.then(async () => { for (const owner of [...P.items.keys()]) await unload(owner); P.status.clear(); });
    soon();
  });
  store.bus.on('project', soon);          // undo / redo: the same plugins stay

  P.reload = async (owner) => { await unload(owner); P.status.delete(owner); return P.sync(); };
  P.statusOf = (owner) => P.status.get(owner) || null;
  P.item = (owner) => P.items.get(owner) || null;

  // ---------------------------------------------------------------- what the plugin host tells
  const dirty = new Set();
  desk.onEvent((m) => {
    if (m.ev === 'scan') { P.scanning = m.finished ? null : m; emit(); return; }
    if (m.ev === 'crashed') {
      const names = [...P.items.keys()].map((o) => (useOf(o) || {}).name).filter(Boolean);
      for (const [owner, it] of P.items) { free.add(it.slot); host.send({ t: 'plug', op: 'link', owner, slot: -1 }); P.status.set(owner, { state: 'error', error: 'The plugin host stopped (a plugin crashed)', path: it.path }); }
      P.items.clear();
      P.connected = false; connecting = null;
      emit();
      toast(`A plugin crashed${names.length ? ` (${names.slice(0, 3).join(', ')})` : ''}. The others are safe: open the plugin's channel and choose Reload, or reopen the project.`, 8000);
      return;
    }
    const owner = ownerOf(m.inst);
    if (!owner) return;
    const it = P.items.get(owner);
    if (m.ev === 'param') {
      it.values[String(m.id)] = m.value;
      const addr = P.addrOf(owner, m.id);
      if (addr) store.setParam(addr, m.value, { noUndo: true });         // knobs follow; automation recording hears it
      dirty.add(owner);
      emit();
    } else if (m.ev === 'dirty') {
      dirty.add(owner);
      clearTimeout(captureTimer); captureTimer = setTimeout(() => P.capture(), 800);
    } else if (m.ev === 'params') {
      it.params = m.params || it.params; Object.assign(it.values, m.values || {});
      const list = paramListOf(it.params), u = useOf(owner);
      // a preset chosen in the plugin's window changes many values at once: the knobs follow
      if (u) store.edit('Plugin parameters', () => {
        const d = useOf(owner);
        if (!d) return;
        if (JSON.stringify(list) !== JSON.stringify(d.data.params)) d.data.params = list;
        for (const [id] of list) if (typeof it.values[id] === 'number') d.params[String(id)] = it.values[id];
      }, [sectionOf(owner)], { noUndo: true });
      dirty.add(owner);
      emit();
    } else if (m.ev === 'latency') {
      it.latency = m.samples || 0;
      host.send({ t: 'plug', op: 'link', owner, slot: it.slot, latency: it.latency });
    } else if (m.ev === 'editorClosed') {
      it.editorOpen = false;
      emit();
    }
  });

  // ---------------------------------------------------------------- settings (state) into the project
  let captureTimer = 0;
  P.capture = async (all = false) => {
    let changed = false;
    for (const [owner, it] of [...P.items]) {
      if (!all && !dirty.has(owner)) continue;
      dirty.delete(owner);
      const r = await desk.cmd({ cmd: 'getState', inst: it.inst });
      const u = useOf(owner);
      if (r.ok && u && r.data !== u.data.state) { u.data.state = r.data; changed = true; }
    }
    if (changed) store.markDirty();
    return changed;
  };
  setInterval(() => { if (dirty.size) P.capture(); }, 5000);
  (app.saveHooks || (app.saveHooks = [])).push(() => P.capture(true));
  host.restartHooks.push(() => P.capture(true));

  // ---------------------------------------------------------------- editors
  P.openEditor = async (owner) => {
    const it = P.items.get(owner);
    if (!it) return false;
    const u = useOf(owner);
    const r = await desk.cmd({ cmd: 'editor', inst: it.inst, show: true, title: (u && (u.name || u.data.name)) || 'Plugin' });
    it.editorOpen = !!(r && r.open);
    emit();
    return it.editorOpen;
  };
  P.closeEditor = async (owner) => {
    const it = P.items.get(owner);
    if (!it) return;
    await desk.cmd({ cmd: 'editor', inst: it.inst, show: false });
    it.editorOpen = false;
    emit();
  };
  P.paramTexts = async (owner, items) => {
    const it = P.items.get(owner);
    if (!it) return [];
    const r = await desk.cmd({ cmd: 'paramText', inst: it.inst, items });
    return (r && r.texts) || [];
  };
  P.refreshValues = async (owner) => {
    const it = P.items.get(owner);
    if (!it) return null;
    const r = await desk.cmd({ cmd: 'params', inst: it.inst });
    if (r.ok) { it.params = r.params; it.values = r.values; emit(); }
    return it.values;
  };
  // MIDI controllers (mod wheel, pitch bend…) to the channel's plugin
  P.midi = (chId, type, channel, key, value) => host.send({ t: 'plug', op: 'midi', ch: chId, type, channel, key, value });

  // ---------------------------------------------------------------- the list of installed plugins
  const setCatalog = (c) => { P.catalog = c; store.bus.emit('plugins-catalog', c); emit(); return c; };
  P.refreshCatalog = async () => setCatalog(await desk.list());
  P.scan = async (force = false) => { P.scanning = { done: 0, total: 0 }; emit(); try { setCatalog(await desk.scan({ force })); } finally { P.scanning = null; emit(); } return P.catalog; };
  P.addFolder = async () => setCatalog(await desk.addFolder());
  P.removeFolder = async (f) => setCatalog(await desk.removeFolder(f));
  P.setLatencyBlocks = (k) => {
    P.K = Math.max(2, Math.min(6, k | 0));
    try { localStorage.setItem(K_KEY, String(P.K)); } catch (_) { /* private mode */ }
    if (sab) host.send({ t: 'plug', op: 'attach', sab, K: P.K });
    emit();
  };
  P.stats = () => desk.stats();

  // adding plugins to the project
  P.addInstrument = (info) => {
    const ch = app.cmd.addChannel(store, 'plugin', { name: (info.name || 'Plugin').slice(0, 40), plugin: { ...info, kind: 'instrument' } });
    P.sync().then(() => { if (P.items.has(`ch:${ch.id}`) && P.items.get(`ch:${ch.id}`).hasEditor) P.openEditor(`ch:${ch.id}`); });
    return ch;
  };
  P.addEffect = (track, slot, info) => {
    const fx = createFxSlot('plugin', { ...info, kind: 'effect' });
    store.edit(`Insert ${info.name || 'plugin'}`, (p) => { p.mixer.tracks[track].fx[slot] = fx; }, [['mixer', 'tracks', track]]);
    const owner = `fx:${fx.extra.plugin.id}`;
    P.sync().then(() => { const it = P.items.get(owner); if (it && it.hasEditor) P.openEditor(owner); });
    return owner;
  };

  // ---------------------------------------------------------------- export with plugins
  usePluginHook(async (job) => {
    const uses = pluginUses(job.project);
    if (!uses.length || !P.connected || !sab) return null;
    await P.capture(true);
    const rate = job.opts.sampleRate || host.sampleRate;
    host.send({ t: 'plug', op: 'pause', on: true });
    if (rate !== host.sampleRate) await desk.cmd({ cmd: 'setRate', sampleRate: rate });
    job.opts.plug = { sab, K: P.K, links: [...P.items].map(([owner, it]) => [owner, { slot: it.slot, latency: it.latency }]) };
    return async () => {
      if (rate !== host.sampleRate) await desk.cmd({ cmd: 'setRate', sampleRate: host.sampleRate });
      host.send({ t: 'plug', op: 'pause', on: false });
    };
  });

  P.refreshCatalog().catch(() => {});
  return P;
}
