// WAM 2.0 plugins in the app (Web Audio Modules: instruments and effects published on the web as ES modules).
//   ADD > WAM plugin… (or any instrument list) adds a channel; "WAM plugin…" in a mixer slot's effect list adds an
//   effect. The plugin is loaded from its address; the project keeps the address and the plugin's state.
//   The live plugins follow the project: added, removed, undone, replaced projects, a new audio device (the engine
//   restarts) — sync() makes the running set match. Their state is read back every few seconds and before export.
//   Export of a project with WAM plugins renders through an OfflineAudioContext (host/export/render-webaudio.js).
import { h, clear } from '../ui/h.js';
import { modal, toast } from '../ui/dialog.js';
import { WamRig, wamUses, absoluteUrl } from '../host/wam-host.js';
import { createFxSlot, normalizeWam } from '../core/project.js';
import { WAM_PORTS } from '../core/wam-link.js';
import { useWebAudioRenderer } from '../host/export/render-client.js';
import { renderWithWebAudio } from '../host/export/render-webaudio.js';

const RECENT = 'fllua.wam.recent';
export const WAM_EXAMPLES = [
  { url: 'wam/example-synth/index.js', name: 'FL LUA Example Synth', kind: 'inst', description: 'Polyphonic synth: sine, saw or square, filter, attack and release. A WAM 2.0 plugin built with the WAM SDK, for trying the format' },
  { url: 'wam/example-tremolo/index.js', name: 'FL LUA Example Tremolo', kind: 'fx', description: 'Tremolo and auto-pan. A WAM 2.0 effect built with the WAM SDK, for trying the format' },
];
const COMMUNITY = 'https://www.webaudiomodules.com/community/';

const loadRecent = () => { try { return (JSON.parse(localStorage.getItem(RECENT) || '[]') || []).filter((r) => r && typeof r.url === 'string'); } catch (_) { return []; } };
const saveRecent = (list) => { try { localStorage.setItem(RECENT, JSON.stringify(list.slice(0, 12))); } catch (_) { /* private mode */ } };
const guessName = (url) => { try { const parts = new URL(url, location.href).pathname.split('/').filter((x) => x && !/^(index|main)\.m?js$/i.test(x) && x !== 'dist'); return decodeURIComponent(parts.pop() || 'WAM plugin').slice(0, 40); } catch (_) { return 'WAM plugin'; } };

export function installWam(app) {
  const store = app.store, host = app.host;
  const w = app.wam = { rig: null, status: new Map(), examples: WAM_EXAMPLES };
  const emit = () => store.bus.emit('wam');
  const rig = () => {
    if (!w.rig || w.rig.ctx !== host.ctx) w.rig = new WamRig(host.ctx, host.node, (m) => host.send(m));
    return w.rig;
  };

  // ---- the running plugins follow the project
  let chain = Promise.resolve();
  w.sync = () => (chain = chain.then(doSync).catch((err) => console.warn('[wam]', err)));
  async function doSync() {
    if (!host.ctx || !host.node) return;
    dedupe();
    const uses = wamUses(store.project);
    if (!uses.length && !w.rig) return;
    const r = rig();
    const want = new Map(uses.map((u) => [u.owner, u]));
    for (const [owner, it] of [...r.items]) {
      const u = want.get(owner);
      if (!u || absoluteUrl(u.url) !== absoluteUrl(it.url)) { r.detach(owner); w.status.delete(owner); }
    }
    for (const [owner, st] of [...w.status]) if (!want.has(owner)) w.status.delete(owner);
    for (const u of uses) {
      if (r.items.has(u.owner)) continue;
      const st = w.status.get(u.owner);
      if (st && st.state === 'error' && st.url === u.url) continue;          // reload asks again (w.reload)
      w.status.set(u.owner, { state: 'loading', url: u.url });
      emit();
      try {
        const inst = await r.attach(u.owner, u.kind, u.url, u.state);
        const d = inst.descriptor || {};
        w.status.set(u.owner, { state: 'ready', url: u.url, name: d.name || inst.name || u.name, vendor: d.vendor || inst.vendor || '', isInstrument: !!d.isInstrument });
        if (!u.data.name && (d.name || inst.name)) { u.data.name = String(d.name || inst.name).slice(0, 80); u.data.vendor = String(d.vendor || '').slice(0, 80); }
      } catch (err) {
        const msg = String(err && err.message || err);
        w.status.set(u.owner, { state: 'error', url: u.url, error: msg });
        toast(`WAM plugin “${u.name || guessName(u.url)}” could not be loaded: ${msg}`, 5000);
      }
      emit();
    }
  }
  // a copied slot carries the same instance id: give the copy its own
  function dedupe() {
    const seen = new Set(), fix = [];
    store.project.mixer.tracks.forEach((t, n) => t.fx.forEach((s, i) => {
      const id = s && s.type === 'wam' && s.extra && s.extra.wam && s.extra.wam.id;
      if (!id) return;
      if (seen.has(id)) fix.push([n, i]); else seen.add(id);
    }));
    if (fix.length) store.edit('WAM plugin copy', (p) => { for (const [n, i] of fix) { const s = p.mixer.tracks[n].fx[i]; s.extra = { wam: normalizeWam({ ...s.extra.wam, id: '' }, true) }; } }, fix.map(([n]) => ['mixer', 'tracks', n]), { noUndo: true });
  }
  let timer = 0;
  const soon = () => { clearTimeout(timer); timer = setTimeout(() => w.sync(), 30); };
  store.bus.on('change', ({ paths }) => { if (paths.some((p) => p[0] === 'channels' || p[0] === 'mixer')) soon(); });
  store.bus.on('project', soon);
  host.restartHooks.push(async () => { await w.capture(); if (w.rig) w.rig.items.clear(); w.rig = null; w.status.clear(); });
  host.bus.on('restarted', () => w.sync());

  // ---- the plugins' state goes into the project (saved with it, used by export)
  w.capture = async () => {
    if (!w.rig || !w.rig.items.size) return false;
    let changed = false;
    for (const u of wamUses(store.project)) {
      const s = await w.rig.stateOf(u.owner);
      if (s && JSON.stringify(s) !== JSON.stringify(u.data.state)) { u.data.state = JSON.parse(JSON.stringify(s)); changed = true; }
    }
    if (changed) store.markDirty();
    return changed;
  };
  setInterval(() => { if (w.rig && w.rig.items.size) w.capture(); }, 3000);

  w.reload = (owner) => { if (w.rig) w.rig.detach(owner); w.status.delete(owner); return w.sync(); };
  w.instance = (owner) => (w.rig ? w.rig.instance(owner) : null);
  w.statusOf = (owner) => w.status.get(owner) || null;

  // ---- choosing a plugin
  w.choose = (kind, current = '') => new Promise((resolve) => {
    const input = h('input.field', { type: 'text', value: current, placeholder: 'https://…/index.js', style: { width: '100%' } });
    input.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') done(input.value); });
    const listOf = (items, title) => items.length ? [h('div.mx-title', title), ...items.map((it) => h('div.wam-pick', {
      hint: it.description || it.url, onclick: () => { input.value = it.url; }, ondblclick: () => done(it.url),
    }, h('b', it.name || guessName(it.url)), h('span.dim', ` ${it.url}`)))] : [];
    const recent = loadRecent().filter((r) => !r.kind || r.kind === kind);
    const body = h('div.wam-choose',
      h('div', { style: { lineHeight: 1.5, marginBottom: '6px' } }, kind === 'fx'
        ? 'A WAM effect (Web Audio Modules 2.0) runs in this mixer slot. Paste the address of the plugin’s main module (usually …/index.js).'
        : 'A WAM instrument (Web Audio Modules 2.0) plays this channel’s notes. Paste the address of the plugin’s main module (usually …/index.js).'),
      input,
      ...listOf(WAM_EXAMPLES.filter((e) => e.kind === kind), 'Examples (included)'),
      ...listOf(recent, 'Recent'),
      h('div.dim', { style: { marginTop: '8px', fontSize: '11px' } }, 'More plugins: ', h('a', { href: COMMUNITY, target: '_blank', rel: 'noopener' }, 'webaudiomodules.com/community'), '. Plugins from other sites must allow loading from here (CORS).'));
    let settled = false;
    const done = (v) => {
      if (settled) return;
      const url = String(v || '').trim();
      if (v !== null && !url) { input.focus(); return; }
      settled = true; m.close(); resolve(url || null);
    };
    const m = modal({ title: kind === 'fx' ? 'WAM effect' : 'WAM instrument', body, width: 560,
      buttons: [{ label: 'Cancel', fn: () => { done(null); return false; } }, { label: 'Add', primary: true, fn: () => { done(input.value); return false; } }],
      onClose: () => { if (!settled) { settled = true; resolve(null); } } });
    setTimeout(() => input.focus(), 0);
  });
  const remember = (url, kind) => saveRecent([{ url, kind, name: guessName(url) }, ...loadRecent().filter((r) => r.url !== url)]);
  const exampleName = (url) => (WAM_EXAMPLES.find((e) => e.url === url) || {}).name || '';

  w.addInstrument = async (url) => {
    url = url || await w.choose('inst');
    if (!url) return null;
    remember(url, 'inst');
    const ch = app.cmd.addChannel(store, 'wam', { name: (exampleName(url) || guessName(url)).slice(0, 40), wam: { url } });
    app.openChannelEditor(ch.id);
    return ch;
  };
  w.setEffect = async (track, slot, url) => {
    url = url || await w.choose('fx');
    if (!url) return false;
    remember(url, 'fx');
    store.edit('Insert WAM plugin', (p) => { const s = createFxSlot('wam'); s.extra.wam.url = url; s.extra.wam.name = exampleName(url); p.mixer.tracks[track].fx[slot] = s; }, [['mixer', 'tracks', track]]);
    return true;
  };
  w.addEffectToSelected = async (url) => {
    const tn = store.project.mixer.selected, t = store.project.mixer.tracks[tn];
    const slot = t.fx.findIndex((s) => !s);
    if (slot < 0) { toast('All 10 effect slots on this track are used'); return false; }
    return w.setEffect(tn, slot, url);
  };
  // a channel or slot that has no plugin yet (made by "Replace plugin" or a preset) gets one here
  w.setUrl = async (owner, url) => {
    if (owner.startsWith('ch:')) {
      const id = Number(owner.slice(3));
      store.edit('Choose WAM plugin', () => { const c = store.channel(id); if (c) { c.wam = normalizeWam({ url, name: exampleName(url) }); c.name = (exampleName(url) || guessName(url)).slice(0, 40); } }, [['channels']]);
    } else {
      const loc = slotOf(owner.slice(3));
      if (!loc) return;
      store.edit('Choose WAM plugin', (p) => { const s = p.mixer.tracks[loc[0]].fx[loc[1]]; s.extra = { wam: normalizeWam({ id: owner.slice(3), url, name: exampleName(url) }, true) }; }, [['mixer', 'tracks', loc[0]]]);
    }
    remember(url, owner.startsWith('ch:') ? 'inst' : 'fx');
  };
  const slotOf = (id) => {
    const ts = store.project.mixer.tracks;
    for (let n = 0; n < ts.length; n++) for (let i = 0; i < ts[n].fx.length; i++) { const s = ts[n].fx[i]; if (s && s.type === 'wam' && s.extra && s.extra.wam && s.extra.wam.id === id) return [n, i]; }
    return null;
  };

  // ---- editor windows: the plugin's own interface, or sliders for its parameters
  w.editor = (win, owner, { title, preview }) => {
    const head = h('div.rack-head');
    const body = h('div.wam-body');
    const el = h('div.rack.wam-editor', head, body);
    let gui = null, guiInst = null, shown = '';
    const data = () => {
      if (owner.startsWith('ch:')) { const c = store.channel(Number(owner.slice(3))); return c && c.wam; }
      const loc = slotOf(owner.slice(3)); return loc ? store.project.mixer.tracks[loc[0]].fx[loc[1]].extra.wam : null;
    };
    const dropGui = () => {
      if (gui && guiInst && typeof guiInst.destroyGui === 'function') { try { guiInst.destroyGui(gui); } catch (_) { /* plugin */ } }
      gui = null; guiInst = null;
    };
    const render = async () => {
      const d = data();
      if (!d) { win.close(); return; }
      const st = w.statusOf(owner), inst = w.instance(owner);
      const key = `${d.url}|${st ? st.state : ''}|${inst ? inst.instanceId : ''}`;
      if (key === shown) return;
      shown = key;
      win.setTitle(title(), st && st.name ? st.name : 'WAM plugin');
      clear(head);
      head.append(h('b', (st && st.name) || d.name || (d.url ? guessName(d.url) : 'WAM plugin')),
        h('span.dim', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0, flex: 1 }, title: d.url }, st && st.vendor ? `${st.vendor} · ${d.url}` : d.url),
        preview ? h('div.btn', { hint: 'Play a note', onclick: preview }, '▶') : null,
        h('div.btn', { hint: 'Load another plugin here', onclick: async () => { const url = await w.choose(owner.startsWith('ch:') ? 'inst' : 'fx', d.url); if (url) w.setUrl(owner, url); } }, d.url ? 'Change…' : 'Choose…'),
        d.url ? h('div.btn', { hint: 'Load the plugin again', onclick: () => { shown = ''; w.reload(owner); } }, 'Reload') : null);
      dropGui();
      clear(body);
      if (!d.url) { body.append(h('div.dim.wam-msg', 'No plugin yet. Choose one to load it here.')); return; }
      if (!st || st.state === 'loading') { body.append(h('div.dim.wam-msg', 'Loading the plugin…')); return; }
      if (st.state === 'error') { body.append(h('div.wam-msg', h('b', 'The plugin could not be loaded'), h('div.dim', st.error))); return; }
      if (!inst) return;
      try {
        const el2 = typeof inst.createGui === 'function' ? await inst.createGui() : null;
        if (shown !== key) { if (el2 && typeof inst.destroyGui === 'function') inst.destroyGui(el2); return; }
        if (el2) { gui = el2; guiInst = inst; body.append(h('div.wam-gui', el2)); return; }
      } catch (err) { body.append(h('div.dim.wam-msg', `The plugin’s own interface failed: ${err.message || err}`)); }
      body.append(await paramPanel(inst));
    };
    const subs = [store.bus.on('wam', render), store.bus.on('change', () => render()), store.bus.on('project', () => render())];
    render();
    return { el, destroy() { for (const s of subs) s(); dropGui(); w.capture(); } };
  };

  async function paramPanel(inst) {
    const node = inst.audioNode;
    const box = h('div.wam-params');
    let info = {}, values = {};
    try { info = (await node.getParameterInfo()) || {}; values = (await node.getParameterValues(false)) || {}; } catch (_) { /* none */ }
    const ids = Object.keys(info);
    if (!ids.length) { box.append(h('div.dim.wam-msg', 'This plugin has no interface and no parameters.')); return box; }
    for (const id of ids) {
      const p = info[id], v = values[id] ? values[id].value : p.defaultValue;
      const set = (x) => node.setParameterValues({ [id]: { id, value: +x, normalized: false } });
      let ctl;
      if (p.type === 'choice' && p.choices && p.choices.length) {
        ctl = h('select.select', p.choices.map((c, i) => h('option', { value: String(i) }, c)));
        ctl.value = String(Math.round(v)); ctl.addEventListener('change', () => set(ctl.value));
      } else if (p.type === 'boolean') {
        ctl = h('input', { type: 'checkbox', checked: v >= 0.5 }); ctl.addEventListener('change', () => set(ctl.checked ? 1 : 0));
      } else {
        const step = p.discreteStep > 0 ? p.discreteStep : (p.maxValue - p.minValue) / 1000;
        const out = h('span.dim.wam-val', fmt(v, p.units));
        ctl = h('span.row', { style: { gap: '6px', flex: 1 } }, (() => { const r = h('input', { type: 'range', min: p.minValue, max: p.maxValue, step, value: v, style: { flex: 1 } }); r.addEventListener('input', () => { set(r.value); out.textContent = fmt(+r.value, p.units); }); return r; })(), out);
      }
      box.append(h('label.wam-param', h('span', p.label || id), ctl));
    }
    return box;
  }
  const fmt = (v, u) => `${Math.abs(v) >= 100 ? Math.round(v) : (+v).toFixed(2)}${u ? ` ${u}` : ''}`;

  // export, stems and the loudness analysis of projects with WAM plugins
  useWebAudioRenderer((job, opts) => renderWithWebAudio(job, opts, { workletUrl: host.workletUrl, moduleHooks: host.moduleHooks, liveState: (owner) => (w.rig ? w.rig.stateOf(owner) : null) }));

  app.editors = app.editors || {};
  app.editors.wam = (win, a, chId) => w.editor(win, `ch:${chId}`, { title: () => (store.channel(chId) || {}).name || 'WAM plugin', preview: () => app.preview(chId) });
  app.editors.wam.rect = { w: 580, h: 340 };
  w.ports = WAM_PORTS;
  return w;
}
