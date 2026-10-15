// VST / CLAP plugins on screen:
//   pluginPanel        the inside of a plugin's FL LUA window (wrapper): its state, "Show plugin window", Reload,
//                      and knobs for its parameters (automatable like any other knob)
//   pluginEditor       the window of a plugin channel (app.editors.plugin)
//   createPluginManager  OPTIONS > Manage plugins…: folders, "Find plugins", what was found, what failed
//   pluginMenuItems    installed plugins as menu items (ADD menu, mixer slots), grouped by maker
import { h, clear } from './h.js';
import { t as tr } from './i18n.js';
import { Knob } from './knob.js';
import { paramDef } from '../core/addr.js';
import { formatLabel } from '../core/plugin-schema.js';

const PAGE = 48;
// "25.000000 Hz" -> "25 Hz", "0.1234" -> "0.12"
const tidy = (s) => String(s || '').trim().replace(/^(-?\d+\.\d+)/, (m) => String(Math.round(+m * 100) / 100));

export function pluginPanel(app, owner, { addrOf, name }) {
  const P = app.plugins, store = app.store;
  const body = h('div.plug-panel');
  let filter = '', shown = PAGE;
  const status = h('div.plug-status');
  const showBtn = h('div.btn.primary', { onclick: () => toggleEditor(), hint: 'The plugin’s own window with its controls' });
  const reload = h('div.btn', { onclick: () => P.reload(owner), hint: 'Start the plugin again (keeps its saved settings)' }, 'Reload');
  const manage = h('div.btn', { onclick: () => app.openWindow('plugins'), hint: 'Folders with plugins, find newly installed ones' }, 'Manage plugins…');
  const search = h('input.input.plug-search', { type: 'search', placeholder: 'Find a parameter…' });
  search.addEventListener('input', () => { filter = search.value.trim().toLowerCase(); shown = PAGE; renderParams(); });
  search.addEventListener('keydown', (e) => e.stopPropagation());
  const params = h('div.plug-params');
  const more = h('div.btn.sm', { onclick: () => { shown += PAGE * 2; renderParams(); } }, 'More…');

  const toggleEditor = async () => {
    const it = P.item(owner);
    if (!it) return;
    if (it.editorOpen) await P.closeEditor(owner); else await P.openEditor(owner);
  };

  const ref = () => {
    if (owner.startsWith('ch:')) { const c = store.channel(+owner.slice(3)); return c && c.plugin; }
    for (const t of store.project.mixer.tracks) for (const s of t.fx) if (s && s.type === 'plugin' && s.extra && s.extra.plugin && `fx:${s.extra.plugin.id}` === owner) return s.extra.plugin;
    return null;
  };

  const renderStatus = () => {
    const st = P.statusOf(owner), it = P.item(owner), r = ref();
    clear(status);
    const what = r ? `${r.name || 'Plugin'}${r.vendor ? ` · ${r.vendor}` : ''} · ${formatLabel(r.format)}` : '';
    status.append(h('div.plug-name', what));
    let line = '', cls = '';
    if (!P.available) { line = 'VST and CLAP plugins run in the FL LUA desktop app.'; cls = 'err'; }
    else if (!st || st.state === 'loading') line = 'Loading…';
    else if (st.state === 'ready') line = it && it.latency ? `Running · latency ${it.latency} samples` : 'Running';
    else if (st.state === 'missing') { line = `Not installed on this computer: ${r ? r.path : ''}`; cls = 'err'; }
    else { line = st.error || 'Could not start'; cls = 'err'; }
    status.append(h(`div.plug-line${cls ? '.' + cls : ''}`, line));
    if (st && st.stateError) status.append(h('div.plug-line.err', st.stateError));
    showBtn.textContent = it && it.editorOpen ? 'Hide plugin window' : 'Show plugin window';
    showBtn.classList.toggle('disabled', !(it && it.hasEditor));
    if (it && !it.hasEditor) showBtn.setAttribute('hint', 'This plugin has no window of its own: use the knobs below');
  };

  // the value under each knob is the plugin's own text (dB, Hz, note names…), asked from the plugin
  const texts = new Map();          // param id -> { val, addr }
  let textTimer = 0;
  const refreshTexts = () => {
    clearTimeout(textTimer);
    textTimer = setTimeout(async () => {
      if (!P.item(owner) || !texts.size) { for (const t of texts.values()) t.val.textContent = ''; return; }
      const ids = [...texts.keys()];
      const items = ids.map((id) => ({ id: +id, value: store.getParam(texts.get(id).addr) ?? 0 }));
      const out = await P.paramTexts(owner, items);
      ids.forEach((id, i) => { const t = texts.get(id); if (t) t.val.textContent = tidy(out[i]) || `${Math.round((items[i].value || 0) * 100)}%`; });
    }, 60);
  };
  // the knobs keep themselves up to date; they are built again only when the list, the search or the page changes
  let built = null;
  const renderParams = () => {
    const r = ref();
    const list = (r && r.params) || [];
    const key = `${filter}|${shown}`;
    if (built && built.list === list && built.key === key) return;
    built = { list, key };
    clear(params);
    texts.clear();
    const match = list.filter((p) => !filter || String(p[1]).toLowerCase().includes(filter));
    for (const p of match.slice(0, shown)) {
      const addr = addrOf(p[0]);
      const d = addr && paramDef(store.project, addr);
      if (!d) continue;
      const name = p[1] || `#${p[0]}`;
      const k = new Knob(app, { addr, size: 'sm', label: name, title: name });
      const val = h('div.knob-label.plug-val', '');
      k.root.append(val);
      texts.set(String(p[0]), { val, addr });
      params.append(k.root);
    }
    refreshTexts();
    if (!match.length) params.append(h('div.dim', list.length ? 'No parameter with that name.' : 'The plugin has no automatable parameters (or it is not loaded yet).'));
    more.style.display = match.length > shown ? '' : 'none';
  };

  body.append(
    h('div.plug-top', status, h('div.grow'), showBtn, reload, manage),
    h('div.plug-bar', h('span.dim', 'Parameters (right-click a knob to automate it)'), h('div.grow'), search),
    h('div.scroll.plug-scroll', params, more));
  const subs = [
    store.bus.on('plugins', () => { renderStatus(); renderParams(); }),
    store.bus.on('change', ({ paths }) => { if (paths.some((x) => x[0] === 'channels' || x[0] === 'mixer')) { renderStatus(); renderParams(); refreshTexts(); } }),
    store.bus.on('param', (a) => { if (texts.size && [...texts.values()].some((t) => t.addr === a)) refreshTexts(); }),
  ];
  renderStatus(); renderParams();
  return { el: body, destroy() { for (const s of subs) s(); }, refresh() { renderStatus(); renderParams(); } };
}

// the window of a plugin channel (FL's plugin wrapper)
export function pluginEditor(win, app, chId) {
  const store = app.store, P = app.plugins, owner = `ch:${chId}`;
  const ch = () => store.channel(chId);
  win.setTitle(ch().name, (ch().plugin && ch().plugin.name) || 'Plugin');
  const head = h('div.rack-head',
    new Knob(app, { addr: `ch:${chId}:vol`, size: 'sm', title: 'Channel volume' }).el,
    new Knob(app, { addr: `ch:${chId}:pan`, size: 'sm', title: 'Channel panning' }).el,
    new Knob(app, { addr: `ch:${chId}:pitch`, size: 'sm', title: 'Channel pitch (semitones)' }).el,
    h('div.grow'),
    h('div.btn', { hint: 'Preview — plays the channel at its root key', onclick: () => app.preview(chId) }, '▶ Preview'));
  const panel = pluginPanel(app, owner, { addrOf: (pid) => `ch:${chId}:p:${pid}` });
  const el = h('div.rack', head, panel.el);
  const off = store.bus.on('project', () => { if (!ch()) win.close(); });
  // like FL Studio: opening the channel shows the plugin's own window too
  P.sync().then(() => { const it = P.item(owner); if (it && it.hasEditor && !it.editorOpen) P.openEditor(owner); });
  return { el, destroy() { panel.destroy(); off(); } };
}
pluginEditor.rect = { w: 560, h: 420 };

// installed plugins as menu items: kind 'instrument' | 'effect'
export function pluginMenuItems(app, kind, pick) {
  const P = app.plugins;
  if (!P || !P.available) return [{ label: 'VST / CLAP plugins: in the desktop app', disabled: true }];
  const list = (P.catalog.plugins || []).filter((p) => p.kind === kind);
  const items = [];
  if (!list.length) items.push({ label: P.catalog.scannedAt ? 'No plugins found yet' : 'Not looked for plugins yet', disabled: true });
  const byVendor = new Map();
  for (const p of list) { const v = p.vendor || 'Other'; if (!byVendor.has(v)) byVendor.set(v, []); byVendor.get(v).push(p); }
  const fmt = (p) => `${p.name}${list.some((q) => q !== p && q.name === p.name) ? ` (${formatLabel(p.format)})` : ''}`;
  if (list.length <= 14) for (const p of list) items.push({ label: fmt(p), fn: () => pick(p) });
  else for (const [v, ps] of [...byVendor].sort((a, b) => a[0].localeCompare(b[0]))) items.push({ label: v, submenu: ps.map((p) => ({ label: fmt(p), fn: () => pick(p) })) });
  items.push({ sep: true }, { label: 'Find plugins', fn: () => P.scan().then((c) => app.toast(`${c.plugins.length} plugins found`)) }, { label: 'Manage plugins…', fn: () => app.openWindow('plugins') });
  return items;
}

// OPTIONS > Manage plugins…
export function createPluginManager(win, app) {
  const P = app.plugins, store = app.store;
  win.setTitle('Plugin manager');
  let filter = '';
  const list = h('div.scroll.plug-list');
  const folders = h('div.plug-folders');
  const progress = h('div.plug-progress.dim');
  const search = h('input.input.plug-search', { type: 'search', placeholder: 'Find a plugin…' });
  search.addEventListener('input', () => { filter = search.value.trim().toLowerCase(); render(); });
  search.addEventListener('keydown', (e) => e.stopPropagation());
  const scanBtn = h('div.btn.primary', { onclick: () => P.scan(), hint: 'Look through the folders for VST and CLAP plugins (new ones are checked one by one)' }, 'Find plugins');
  const rescan = h('div.btn', { onclick: () => P.scan(true), hint: 'Check every plugin again' }, 'Check all again');
  const addFolder = h('div.btn', { onclick: () => P.addFolder(), hint: 'Add a folder where you keep plugins' }, 'Add folder…');
  // how many 128-sample blocks the plugins get to answer: fewer = sooner sound, more = safer on a busy computer
  const latSel = h('select.select', { hint: 'How long plugins have to answer. Shorter = less delay; longer = no crackles when the computer is busy. The mixer keeps everything in time either way.' });
  const fillLat = () => {
    const sr = app.host.sampleRate || 48000;
    latSel.textContent = '';
    latSel.append(...[2, 3, 4, 6].map((k) => h('option', { value: String(k) }, `${tr('Plugin delay')} ${((k * 128) / sr * 1000).toFixed(1)} ms${k === 3 ? ` (${tr('default')})` : ''}`)));
    latSel.value = String(P.K);
  };
  latSel.addEventListener('change', () => P.setLatencyBlocks(+latSel.value));

  const add = (p) => {
    if (p.kind === 'instrument') { const ch = P.addInstrument(p); app.openChannelEditor(ch.id); }
    else {
      const pr = store.project, tn = pr.mixer.selected, slot = pr.mixer.tracks[tn].fx.findIndex((s) => !s);
      if (slot < 0) { app.toast('All 10 effect slots of the selected mixer track are used'); return; }
      P.addEffect(tn, slot, p);
      app.toast(`${p.name} added to ${tn === 0 ? 'Master' : `insert ${tn}`}, slot ${slot + 1}`);
    }
  };

  const render = () => {
    clear(folders); clear(list);
    if (!P.available) {
      list.append(h('div.plug-empty', h('b', 'VST and CLAP plugins run in the FL LUA desktop app.'), h('p.dim', 'Download it from the releases page; your projects open there as they are. In the browser you can use the built-in instruments and effects, plugin packs and WAM plugins.')));
      scanBtn.classList.add('disabled'); rescan.classList.add('disabled'); addFolder.classList.add('disabled'); latSel.disabled = true;
      return;
    }
    if (latSel.value !== String(P.K)) fillLat();
    const c = P.catalog;
    for (const f of c.folders || []) folders.append(h('div.plug-folder', h('span', f), h('div.btn.sm', { onclick: () => P.removeFolder(f), hint: 'Do not look in this folder' }, '✕')));
    const sc = P.scanning;
    progress.textContent = sc ? (sc.total ? tr(`Checking plugins: ${sc.done} of ${sc.total}`) + (sc.file ? ` · ${sc.file}` : '') : tr('Looking for plugins…')) : (c.scannedAt ? tr(`${(c.plugins || []).length} plugins`) : tr('Not looked for plugins yet: press Find plugins.'));
    const match = (c.plugins || []).filter((p) => !filter || `${p.name} ${p.vendor}`.toLowerCase().includes(filter));
    for (const [title, kind] of [['Instruments', 'instrument'], ['Effects', 'effect']]) {
      const ps = match.filter((p) => p.kind === kind);
      if (!ps.length) continue;
      list.append(h('div.plug-group', `${tr(title)} · ${ps.length}`));
      for (const p of ps) {
        list.append(h('div.plug-row', { ondblclick: () => add(p), hint: `${p.path}\n${p.category || ''}` },
          h('span.plug-fmt', formatLabel(p.format)),
          h('b', p.name), h('span.dim', p.vendor || ''), h('div.grow'),
          h('div.btn.sm', { onclick: () => add(p) }, kind === 'instrument' ? 'Add to rack' : 'Add to mixer')));
      }
    }
    if ((c.failed || []).length) {
      list.append(h('div.plug-group.err', `${tr('Could not be used')} · ${c.failed.length}`));
      for (const f of c.failed) list.append(h('div.plug-row.err', { hint: f.path }, h('span', f.path.split(/[\\/]/).pop()), h('span.dim', f.error)));
    }
    if (c.scannedAt && !(c.plugins || []).length) list.append(h('div.plug-empty', h('b', 'No plugins found.'), h('p.dim', 'Install VST or CLAP plugins (for example Vital, Surge XT, Dexed, Valhalla Supermassive) and press Find plugins. If they are in another folder, add it.')));
  };

  const el = h('div.rack.plug-manager',
    h('div.rack-head', scanBtn, rescan, addFolder, latSel, h('div.grow'), search),
    h('div.plug-sub', h('span.dim', 'Folders'), folders),
    progress,
    list);
  const off = store.bus.on('plugins', render);
  render();
  if (P.available && !P.catalog.scannedAt && !P.scanning) P.scan();
  fillLat();
  return { el, onShow: () => { P.refreshCatalog && P.refreshCatalog().catch(() => {}); fillLat(); render(); }, destroy() { off(); } };
}
