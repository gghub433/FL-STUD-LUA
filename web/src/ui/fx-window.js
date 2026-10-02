// Effect editor windows: header (bypass, mix, presets) + custom visual panel per effect type
// (EQ with draggable bands and spectrum, dynamics meters, convolver IR picker, 36-slot curve editor)
// + a schema-generated parameter area for everything else.
import { h, drag, clamp, clear } from './h.js';
import { Knob } from './knob.js';
import { paramControl } from './param-controls.js';
import { showPopup } from './menu.js';
import { promptText } from './dialog.js';
import { EFFECTS } from '../core/effects/index.js';
import { eqResponse, BANDS, BAND_TYPES } from '../core/effects/eq.js';
import { defaultSlots, SLOTS, evalCurve } from '../core/effects/grossbeat.js';
import { defaults } from '../core/schema.js';
import { EFFECT_PRESETS } from '../core/presets.js';
import { IRS } from '../core/factory.js';
import { trackName } from '../core/addr.js';
import { patcherFxPanel } from './patcher.js';

const BAND_COLORS = ['#e35d5d', '#e8894a', '#e0b84a', '#7fdc5c', '#4cc3a6', '#4aaedc', '#a07fe0'];

export function openFxEditor(app, track, slot) {
  const store = app.store;
  const s = store.project.mixer.tracks[track].fx[slot];
  if (!s) return null;
  const id = `fx:${track}:${slot}`;
  if (app.wm.isOpen(id)) { app.wm.focus(id); return app.wm.get(id); }
  const meta = EFFECTS[s.type].meta;
  const big = ['eq', 'grossbeat', 'convolver', 'multiband', 'compressor', 'limiter', 'gate'].includes(s.type);
  return app.wm.open(id, {
    title: meta.name, dynamic: true,
    rect: { x: 220, y: 80, w: s.type === 'patcher' ? 980 : s.type === 'grossbeat' ? 820 : big ? 680 : 520, h: s.type === 'patcher' ? 580 : s.type === 'grossbeat' ? 640 : s.type === 'eq' ? 560 : 400 },
    minW: 360, minH: 220,
    create: (win) => fxEditor(win, app, track, slot),
  });
}

function presetsFor(type) {
  try { return JSON.parse(localStorage.getItem(`stepwise.fxpresets.${type}`) || '{}'); } catch (_) { return {}; }
}

export function fxPresetItems(app, track, slot) {
  const store = app.store;
  const s = store.project.mixer.tracks[track].fx[slot];
  if (!s) return [];
  const type = s.type, schema = EFFECTS[type].schema;
  const presets = presetsFor(type);
  const apply = (params, extra) => {
    store.edit('Load preset', (p) => {
      const sl = p.mixer.tracks[track].fx[slot];
      if (!sl) return;
      sl.params = { ...defaults(schema), ...params };
      if (extra) sl.extra = JSON.parse(JSON.stringify(extra)); else delete sl.extra;
    }, [['mixer', 'tracks', track]]);
  };
  const items = [
    { label: 'Save preset…', fn: async () => {
      const name = await promptText('Save preset', 'Preset name', `${EFFECTS[type].meta.name} preset`);
      if (!name) return;
      const all = presetsFor(type);
      all[name] = { params: JSON.parse(JSON.stringify(store.project.mixer.tracks[track].fx[slot].params)), extra: store.project.mixer.tracks[track].fx[slot].extra };
      try { localStorage.setItem(`stepwise.fxpresets.${type}`, JSON.stringify(all)); app.toast(`Saved preset "${name}"`); } catch (_) { app.toast('Could not save (storage disabled)'); }
    } },
    { label: 'Reset to defaults', fn: () => apply({}) },
  ];
  const factory = (EFFECT_PRESETS[type] || {});
  const fnames = Object.keys(factory);
  if (fnames.length) { items.push({ sep: true }, { title: 'Factory presets' }); for (const n of fnames) items.push({ label: n, fn: () => apply(factory[n]) }); }
  const names = Object.keys(presets);
  if (names.length) {
    items.push({ sep: true }, { title: 'User presets' });
    for (const n of names) items.push({ label: n, fn: () => apply(presets[n].params, presets[n].extra) });
    items.push({ sep: true }, { label: 'Delete preset…', submenu: names.map((n) => ({ label: n, fn: () => { const all = presetsFor(type); delete all[n]; localStorage.setItem(`stepwise.fxpresets.${type}`, JSON.stringify(all)); } })) });
  }
  return items;
}

function fxEditor(win, app, track, slotIdx) {
  const store = app.store;
  const slot0 = store.project.mixer.tracks[track].fx[slotIdx];
  const type = slot0.type;
  const mod = EFFECTS[type];
  const schema = mod.schema;
  const addrOf = (id) => `mx:${track}:fx:${slotIdx}:p:${id}`;
  const title = () => `${mod.meta.name} — ${trackName(store.project, track)} / slot ${slotIdx + 1}`;
  win.setTitle(title());

  const live = () => store.project.mixer.tracks[track].fx[slotIdx];
  const led = h('div.led', { class: slot0.on ? 'on' : '', hint: 'Enable / bypass', onclick: () => store.setParam(`mx:${track}:fx:${slotIdx}:on`, live().on ? 0 : 1) });
  const mix = new Knob(app, { addr: `mx:${track}:fx:${slotIdx}:mix`, size: 'sm', title: 'Dry / wet mix' });
  const presetBtn = h('div.btn.sm', { hint: 'Presets — save, load and reset', onclick: (e) => { const r = e.currentTarget.getBoundingClientRect(); showPopup(fxPresetItems(app, track, slotIdx), r.left, r.bottom, r); } }, 'Presets ▾');
  const head = h('div.rack-head', led, h('b', mod.meta.name), h('span.dim', mod.meta.description), h('div.grow'), h('span.dim', 'Mix'), mix.el, presetBtn);

  const custom = h('div', { style: { flex: 'none' } });
  const state = { meters: [], status: '', spec: null, band: 1, extra: null };
  const subs = [];
  const watching = () => app.host.watch(track, slotIdx);
  const painters = [];

  // ---------------------------------------------------------------- per-type panels
  if (type === 'eq') painters.push(eqPanel(app, track, slotIdx, custom, state, subs));
  else if (['compressor', 'limiter', 'gate', 'multiband'].includes(type)) painters.push(meterPanel(type, custom, state));
  else if (type === 'convolver') painters.push(convolverPanel(app, track, slotIdx, custom, state));
  else if (type === 'grossbeat') painters.push(grossPanel(app, track, slotIdx, custom, state));

  // ---------------------------------------------------------------- generic parameter area
  const groups = [];
  for (const d of schema) { const g = d.group || 'Main'; if (!groups.includes(g)) groups.push(g); }
  let tab = type === 'eq' ? null : groups[0];
  const tabsEl = h('div.rack-groups');
  const body = h('div.scroll', { style: { flex: 1, minHeight: 0 } });
  const renderParams = () => {
    clear(tabsEl); clear(body);
    if (type === 'eq') {
      const b = state.band;
      tabsEl.append(...Array.from({ length: BANDS }, (_, i) => h('div.rack-tab', { class: i + 1 === b ? 'on' : '', style: { color: i + 1 === b ? BAND_COLORS[i] : '' }, onclick: () => { state.band = i + 1; renderParams(); } }, `Band ${i + 1}`)), h('div.rack-tab', { class: b === 0 ? 'on' : '', onclick: () => { state.band = 0; renderParams(); } }, 'Output'));
      const defs = b === 0 ? schema.filter((d) => !d.group || d.group === 'Main') : schema.filter((d) => d.group === `Band ${b}`);
      body.append(h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '10px 16px', padding: '10px' } }, defs.map((d) => paramControl(app, addrOf(d.id), d, { label: d.name.replace(/^Band \d /, '') }))));
      return;
    }
    if (groups.length > 1) for (const g of groups) tabsEl.append(h('div.rack-tab', { class: g === tab ? 'on' : '', onclick: () => { tab = g; renderParams(); } }, g));
    const defs = schema.filter((d) => (d.group || 'Main') === tab);
    body.append(h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '10px 16px', padding: '10px', alignContent: 'flex-start' } }, defs.map((d) => paramControl(app, addrOf(d.id), d))));
  };
  state.onBand = () => renderParams();
  renderParams();

  // the Patcher brings its own editor (node canvas + macros) instead of the generic parameter area
  const patcher = type === 'patcher' ? patcherFxPanel(app, win, track, slotIdx) : null;
  const el = patcher ? h('div.rack', head, patcher.el) : h('div.rack', head, custom, (groups.length > 1 || type === 'eq') ? tabsEl : null, body);

  // ---------------------------------------------------------------- engine feedback
  subs.push(app.host.bus.on('spectrum', (m) => { if (m.track === track && m.slot === slotIdx) state.spec = m.mags; }));
  subs.push(app.host.bus.on('fxmeter', (m) => { if (m.track === track && m.slot === slotIdx) { state.meters = m.values; state.status = m.status; } }));
  subs.push(store.bus.on('change', ({ paths }) => {
    if (!paths.some((p) => p[0] === 'mixer')) return;
    const s = live();
    if (!s || s.type !== type) { win.close(); return; }
    led.classList.toggle('on', !!s.on);
    win.setTitle(title());
  }));
  subs.push(store.bus.on('param', (a, v) => { if (a === `mx:${track}:fx:${slotIdx}:on`) led.classList.toggle('on', !!v); }));
  subs.push(store.bus.on('project', () => { if (!live() || live().type !== type) win.close(); else renderParams(); }));

  let rafId = 0;
  const loop = () => { if (win.open) for (const p of painters) p(); rafId = requestAnimationFrame(loop); };
  rafId = requestAnimationFrame(loop);
  watching();
  return {
    el,
    onShow: watching,
    destroy() { cancelAnimationFrame(rafId); for (const s of subs) s(); if (patcher) patcher.destroy(); app.mixerRewatch && app.mixerRewatch(); },
  };
}

// ======================================================================================= EQ
function eqPanel(app, track, slotIdx, host, state) {
  const store = app.store;
  const W = 640, H = 230;
  const canvas = h('canvas', { width: W, height: H, style: { width: '100%', maxWidth: `${W}px`, height: 'auto', aspectRatio: `${W}/${H}`, background: '#0e1012', borderBottom: '1px solid #000', display: 'block' }, hint: 'Drag a node: left/right = frequency, up/down = gain. Wheel = Q, double-click = on/off' });
  host.append(canvas);
  const sr = app.host.sampleRate;
  const fx = (f) => (Math.log(f / 20) / Math.log(1000)) * W;
  const fromX = (x) => 20 * Math.pow(1000, x / W);
  const dbRange = 24;
  const yOf = (g) => H / 2 - (g / dbRange) * (H / 2 - 10);
  const params = () => store.project.mixer.tracks[track].fx[slotIdx].params;
  const nodePos = (i) => { const p = params(); return [fx(p[`b${i}freq`]), BAND_TYPES[p[`b${i}type`]].includes('pass') || BAND_TYPES[p[`b${i}type`]] === 'Notch' ? H / 2 : yOf(p[`b${i}gain`])]; };
  const hit = (e) => {
    const r = canvas.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * W, y = ((e.clientY - r.top) / r.height) * H;
    let best = 0, bd = 18;
    for (let i = 1; i <= BANDS; i++) { const [nx, ny] = nodePos(i); const d = Math.hypot(nx - x, ny - y); if (d < bd) { bd = d; best = i; } }
    return { best, x, y };
  };
  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const { best } = hit(e);
    if (!best) return;
    state.band = best;
    state.onBand && state.onBand();
    const r = canvas.getBoundingClientRect();
    drag(e, (dx, dy, ev) => {
      const x = ((ev.clientX - r.left) / r.width) * W, y = ((ev.clientY - r.top) / r.height) * H;
      const p = params(), t = BAND_TYPES[p[`b${best}type`]];
      store.setParam(`mx:${track}:fx:${slotIdx}:p:b${best}freq`, clamp(fromX(clamp(x, 0, W)), 20, 20000), { coalesce: `eq${best}f` });
      if (!(t.includes('pass') || t === 'Notch')) store.setParam(`mx:${track}:fx:${slotIdx}:p:b${best}gain`, clamp(((H / 2 - y) / (H / 2 - 10)) * dbRange, -24, 24), { coalesce: `eq${best}g` });
    });
  });
  canvas.addEventListener('dblclick', (e) => { const { best } = hit(e); if (best) store.setParam(`mx:${track}:fx:${slotIdx}:p:b${best}on`, params()[`b${best}on`] ? 0 : 1); });
  canvas.addEventListener('wheel', (e) => {
    const { best } = hit(e);
    if (!best) return;
    e.preventDefault();
    const q = params()[`b${best}q`];
    store.setParam(`mx:${track}:fx:${slotIdx}:p:b${best}q`, clamp(q * (e.deltaY < 0 ? 1.12 : 1 / 1.12), 0.1, 18), { coalesce: `eq${best}q` });
  }, { passive: false });

  const freqs = new Float32Array(W / 2);
  for (let i = 0; i < freqs.length; i++) freqs[i] = fromX(i * 2);
  const ctx = canvas.getContext('2d');
  return () => {
    ctx.fillStyle = '#0e1012'; ctx.fillRect(0, 0, W, H);
    ctx.lineWidth = 1; ctx.strokeStyle = '#1f2529'; ctx.fillStyle = '#5b666e'; ctx.font = '10px sans-serif';
    for (const f of [30, 50, 100, 200, 500, 1000, 2000, 5000, 10000]) { const x = fx(f); ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); ctx.fillText(f >= 1000 ? `${f / 1000}k` : String(f), x + 3, H - 4); }
    for (const d of [-18, -12, -6, 0, 6, 12, 18]) { const y = yOf(d); ctx.strokeStyle = d === 0 ? '#3a4249' : '#1f2529'; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); ctx.fillText(`${d}`, 3, y - 2); }
    if (state.spec) {
      ctx.beginPath(); ctx.moveTo(0, H);
      for (let x = 0; x <= W; x += 2) { const kf = Math.min(1022, (fromX(x) / (sr / 2)) * 1024), k = Math.floor(kf), v = state.spec[k] + (state.spec[k + 1] - state.spec[k]) * (kf - k); ctx.lineTo(x, clamp(H - ((v + 90) / 90) * H * 0.9, 0, H)); }
      ctx.lineTo(W, H); ctx.closePath(); ctx.fillStyle = 'rgba(255,176,46,.28)'; ctx.fill();
    }
    const full = defaults(EFFECTS.eq.schema); Object.assign(full, params());
    const resp = eqResponse(full, sr, freqs);
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.beginPath();
    for (let i = 0; i < resp.length; i++) { const y = clamp(yOf(resp[i]), 0, H); if (i === 0) ctx.moveTo(i * 2, y); else ctx.lineTo(i * 2, y); }
    ctx.stroke();
    for (let i = 1; i <= BANDS; i++) {
      const [x, y] = nodePos(i), on = params()[`b${i}on`];
      ctx.beginPath(); ctx.arc(x, y, i === state.band ? 8 : 6, 0, 7);
      ctx.fillStyle = on ? BAND_COLORS[i - 1] : '#3a4046'; ctx.fill();
      ctx.lineWidth = i === state.band ? 2.5 : 1; ctx.strokeStyle = '#000'; ctx.stroke();
      ctx.fillStyle = '#111'; ctx.font = 'bold 9px sans-serif'; ctx.fillText(String(i), x - 2.5, y + 3);
    }
  };
}

// ======================================================================================= dynamics meters
function meterPanel(type, host, state) {
  const W = 640, H = 90;
  const canvas = h('canvas', { width: W, height: H, style: { width: '100%', maxWidth: `${W}px`, height: 'auto', aspectRatio: `${W}/${H}`, background: '#0e1012', display: 'block', borderBottom: '1px solid #000' } });
  host.append(canvas);
  const ctx = canvas.getContext('2d');
  const hist = [];
  return () => {
    ctx.fillStyle = '#0e1012'; ctx.fillRect(0, 0, W, H);
    const m = state.meters || [];
    const gr = type === 'multiband' ? Math.min(m[0] || 0, m[1] || 0, m[2] || 0, m[3] || 0) : (m[0] || 0);
    hist.push(gr); if (hist.length > 300) hist.shift();
    // gain-reduction history
    ctx.strokeStyle = '#1f2529'; ctx.fillStyle = '#5b666e'; ctx.font = '10px sans-serif';
    for (const d of [0, -6, -12, -18, -24]) { const y = 6 + (-d / 24) * (H - 14); ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); ctx.fillText(`${d} dB`, W - 40, y - 2); }
    ctx.beginPath(); ctx.moveTo(0, 6);
    hist.forEach((v, i) => ctx.lineTo((i / 300) * (W - 50), 6 + clamp(-v / 24, 0, 1) * (H - 14)));
    ctx.lineTo(((hist.length - 1) / 300) * (W - 50), 6); ctx.closePath(); ctx.fillStyle = 'rgba(230,90,75,.55)'; ctx.fill();
    ctx.fillStyle = '#d5dce0'; ctx.font = '11px sans-serif';
    if (type === 'multiband') ctx.fillText(`low ${(m[0] || 0).toFixed(1)}  mid ${(m[1] || 0).toFixed(1)}  high ${(m[2] || 0).toFixed(1)}  limiter ${(m[3] || 0).toFixed(1)} dB`, 8, H - 6);
    else ctx.fillText(`gain reduction ${gr.toFixed(1)} dB`, 8, H - 6);
  };
}

// ======================================================================================= convolver
function convolverPanel(app, track, slotIdx, host, state) {
  const store = app.store;
  const status = h('span.dim', '');
  const sel = h('select.select', { style: { minWidth: '200px' } });
  const canvas = h('canvas', { width: 640, height: 110, style: { width: '100%', maxWidth: '640px', height: 'auto', aspectRatio: '640/110', background: '#0e1012', display: 'block' } });
  const irId = () => (store.project.mixer.tracks[track].fx[slotIdx]?.extra?.irId) || '';
  const fill = () => {
    clear(sel);
    sel.append(h('option', { value: '' }, '(choose an impulse response)'));
    for (const f of IRS) sel.append(h('option', { value: `factory:${f.id}` }, f.name));
    for (const [id, e] of app.bank.map) if (id.startsWith('user:')) sel.append(h('option', { value: id }, `${e.name} (loaded)`));
    sel.value = irId();
  };
  sel.addEventListener('change', async () => {
    const id = sel.value;
    if (id) await app.bank.ensure(id);
    app.cmd.setFxExtra(store, track, slotIdx, { irId: id || null });
  });
  const load = h('div.btn.sm', { hint: 'Load an impulse response from an audio file', onclick: () => {
    const inp = h('input', { type: 'file', accept: 'audio/*,.wav,.aif,.aiff,.flac,.ogg,.mp3', style: { display: 'none' } });
    inp.addEventListener('change', async () => {
      const f = inp.files[0]; if (!f) return;
      try { const e = await app.bank.decode(f.name, await f.arrayBuffer()); fill(); sel.value = e.id; app.cmd.setFxExtra(store, track, slotIdx, { irId: e.id }); } catch (err) { app.toast(`Could not decode ${f.name}`); }
      inp.remove();
    });
    document.body.append(inp); inp.click();
  } }, 'Load file…');
  host.append(h('div.row', { style: { padding: '6px 8px', gap: '8px' } }, h('span.dim', 'Impulse response'), sel, load, status), canvas);
  fill();
  const ctx = canvas.getContext('2d');
  let lastId = '';
  return () => {
    const id = irId();
    if (id !== lastId) { lastId = id; if (sel.value !== id) sel.value = id; if (id && !app.bank.has(id)) app.bank.ensure(id); }
    status.textContent = state.status ? `· ${state.status}` : '';
    ctx.fillStyle = '#0e1012'; ctx.fillRect(0, 0, 640, 110);
    const e = id ? app.bank.get(id) : null;
    if (!e) { ctx.fillStyle = '#5b666e'; ctx.fillText('No impulse response selected', 12, 55); return; }
    const d = e.channels[0], n = d.length;
    ctx.fillStyle = '#ffb02e';
    for (let x = 0; x < 640; x++) {
      const a = Math.floor((x / 640) * n), b = Math.floor(((x + 1) / 640) * n);
      let mn = 0, mx = 0; for (let i = a; i < b; i += Math.max(1, (b - a) >> 4)) { if (d[i] < mn) mn = d[i]; if (d[i] > mx) mx = d[i]; }
      ctx.fillRect(x, 55 - mx * 50, 1, Math.max(1, (mx - mn) * 50));
    }
  };
}

// ======================================================================================= gross-beat style curve editor
function grossPanel(app, track, slotIdx, host, state) {
  const store = app.store;
  const live = () => store.project.mixer.tracks[track].fx[slotIdx];
  const getSlots = () => (live().extra && live().extra.slots) || null;
  let editing = 0;
  const grid = h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(12, 1fr)', gap: '3px', padding: '6px 8px' } });
  const info = h('div.row', { style: { padding: '0 8px 4px', gap: '8px' } });
  const mk = (title) => h('canvas', { width: 380, height: 150, style: { width: '100%', height: 'auto', aspectRatio: '380/150', background: '#0e1012', border: '1px solid #000', cursor: 'crosshair' }, hint: `${title} curve — click to add a point, drag to move, double-click or right-click a point to delete` });
  const timeC = mk('Time'), volC = mk('Volume');
  host.append(grid, info, h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', padding: '4px 8px 8px' } },
    h('div', h('div.knob-label', 'TIME (what part of the cycle is heard)'), timeC), h('div', h('div.knob-label', 'VOLUME'), volC)));

  const slots = () => getSlots() || defaultSlots();
  const materialize = () => { if (!getSlots()) app.cmd.setFxExtra(store, track, slotIdx, { slots: JSON.parse(JSON.stringify(defaultSlots())) }); return getSlots(); };
  const names = () => slots().map((s, i) => s.name || `Slot ${i + 1}`);

  const buildGrid = () => {
    clear(grid);
    names().forEach((nm, i) => grid.append(h('div.btn.sm', { hint: `Slot ${i + 1}: ${nm} — click plays this pattern, right-click edits it`, dataset: { slot: i }, style: { minWidth: 0, padding: '0 2px' },
      onclick: () => store.setParam(`mx:${track}:fx:${slotIdx}:p:slot`, i), oncontextmenu: (e) => { e.preventDefault(); editing = i; buildInfo(); } }, String(i + 1))));
  };
  const buildInfo = () => {
    clear(info);
    const s = slots()[editing];
    const nameIn = h('input.field', { type: 'text', value: s.name || '', style: { width: '170px' } });
    nameIn.addEventListener('change', () => { const sl = materialize(); sl[editing].name = nameIn.value.slice(0, 30); app.cmd.setFxExtra(store, track, slotIdx, { slots: sl }); buildGrid(); });
    info.append(h('span.dim', `Editing slot ${editing + 1}`), nameIn,
      h('div.btn.sm' + (s.lookback ? '.on' : ''), { hint: 'Look back — read from the previous cycle (needed for reverse; adds one cycle of latency to this slot)', onclick: () => { const sl = materialize(); sl[editing].lookback = sl[editing].lookback ? 0 : 1; app.cmd.setFxExtra(store, track, slotIdx, { slots: sl }); buildInfo(); } }, 'Look back'),
      h('div.btn.sm', { hint: 'Restore this slot to its factory pattern', onclick: () => { const sl = materialize(); sl[editing] = JSON.parse(JSON.stringify(defaultSlots()[editing])); app.cmd.setFxExtra(store, track, slotIdx, { slots: sl }); buildGrid(); buildInfo(); } }, 'Reset slot'),
      h('div.btn.sm', { hint: 'Make the time and volume curves flat (normal playback)', onclick: () => { const sl = materialize(); sl[editing].time = [[0, 0], [1, 1]]; sl[editing].vol = [[0, 1], [1, 1]]; app.cmd.setFxExtra(store, track, slotIdx, { slots: sl }); } }, 'Straight'));
  };

  // curve editing on a canvas
  const wire = (canvas, key) => {
    const W = canvas.width, H = canvas.height;
    const pos = (e) => { const r = canvas.getBoundingClientRect(); return [clamp((e.clientX - r.left) / r.width, 0, 1), clamp(1 - (e.clientY - r.top) / r.height, 0, 1)]; };
    const nearest = (pts, x, y) => { let bi = -1, bd = 0.045; pts.forEach((p, i) => { const d = Math.hypot((p[0] - x) * 2.5, p[1] - y); if (d < bd) { bd = d; bi = i; } }); return bi; };
    canvas.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const sl = materialize(), pts = sl[editing][key]; const [x, y] = pos(e); const i = nearest(pts, x, y);
      if (i >= 0 && pts.length > 2) { pts.splice(i, 1); app.cmd.setFxExtra(store, track, slotIdx, { slots: sl }); }
    });
    canvas.addEventListener('dblclick', (e) => {
      const sl = materialize(), pts = sl[editing][key]; const [x, y] = pos(e); const i = nearest(pts, x, y);
      if (i >= 0 && pts.length > 2) { pts.splice(i, 1); app.cmd.setFxExtra(store, track, slotIdx, { slots: sl }); }
    });
    canvas.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const sl = materialize(), pts = sl[editing][key];
      const [x, y] = pos(e);
      let i = nearest(pts, x, y);
      if (i < 0) { pts.push([x, y]); pts.sort((a, b) => a[0] - b[0]); i = pts.findIndex((p) => p[0] === x && p[1] === y); }
      const grab = pts[i];
      drag(e, (dx, dy, ev) => {
        const [mx, my] = pos(ev);
        const k = pts.indexOf(grab);
        const lo = k > 0 ? pts[k - 1][0] : 0, hi = k < pts.length - 1 ? pts[k + 1][0] : 1;
        grab[0] = k === 0 ? 0 : k === pts.length - 1 ? 1 : clamp(mx, lo, hi);
        grab[1] = my;
        const cur = getSlots(); if (cur) { cur[editing][key] = pts; }
        app.cmd.setFxExtra(store, track, slotIdx, { slots: sl });
      });
    });
  };
  wire(timeC, 'time'); wire(volC, 'vol');

  const draw = (canvas, pts, color, diag) => {
    const c = canvas.getContext('2d'), W = canvas.width, H = canvas.height;
    c.fillStyle = '#0e1012'; c.fillRect(0, 0, W, H);
    c.strokeStyle = '#1f2529'; c.lineWidth = 1;
    for (let i = 1; i < 4; i++) { c.beginPath(); c.moveTo((i / 4) * W, 0); c.lineTo((i / 4) * W, H); c.stroke(); c.beginPath(); c.moveTo(0, (i / 4) * H); c.lineTo(W, (i / 4) * H); c.stroke(); }
    if (diag) { c.strokeStyle = '#2c343a'; c.beginPath(); c.moveTo(0, H); c.lineTo(W, 0); c.stroke(); }
    c.strokeStyle = color; c.lineWidth = 2; c.beginPath();
    for (let x = 0; x <= W; x += 2) { const y = H - evalCurve(pts, x / W) * H; if (x === 0) c.moveTo(x, y); else c.lineTo(x, y); }
    c.stroke();
    c.fillStyle = color;
    for (const p of pts) { c.beginPath(); c.arc(p[0] * W, H - p[1] * H, 3.5, 0, 7); c.fill(); }
  };

  buildGrid(); buildInfo();
  let lastSlotsRef = null, lastCurrent = -1;
  return () => {
    const s = slots(), cur = Math.round(live().params.slot);
    if (cur !== lastCurrent) { lastCurrent = cur; for (const b of grid.children) b.classList.toggle('on', +b.dataset.slot === cur); }
    const ref = getSlots();
    if (ref !== lastSlotsRef) { lastSlotsRef = ref; buildGrid(); buildInfo(); for (const b of grid.children) b.classList.toggle('on', +b.dataset.slot === cur); }
    draw(timeC, s[editing].time, '#ffb02e', true);
    draw(volC, s[editing].vol, '#7fdc5c', false);
    // moving playhead across both curves
    const ph = state.meters && state.meters[0];
    if (ph !== undefined) for (const cv of [timeC, volC]) { const c = cv.getContext('2d'); c.fillStyle = 'rgba(255,255,255,.7)'; c.fillRect(ph * cv.width, 0, 2, cv.height); }
  };
}
