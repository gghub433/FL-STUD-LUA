// Dedicated editor windows for the built-in instruments.
import { h, drag, clamp, clear } from './h.js';
import { Knob } from './knob.js';
import { paramControl } from './param-controls.js';
import { showPopup, contextMenu } from './menu.js';
import { promptText } from './dialog.js';
import { drawWave } from './waveform.js';
import { drawEnv } from './env-graph.js';
import { keyName } from '../core/constants.js';
import { instrumentSchema, instrumentMeta } from '../core/instruments/index.js';
import { TARGETS, TARGET_LABEL } from '../core/instruments/sampler.js';
import { TYPE_PRESETS, renderOneShot } from '../core/instruments/drumsynth.js';
import { ALGOS, OPS, algoMatrix } from '../core/instruments/fmsynth.js';
import { PADS, BANKS, MAX_LAYERS } from '../core/instruments/fpc.js';
import { detectSlices, evenSlices, estimateLoop } from '../core/slice-detect.js';
import { FACTORY } from '../core/factory.js';
import { schemaMap } from '../core/schema.js';
import { instrumentPresetItems } from './presets-ui.js';
import { FOOTAGE, PRESETS as ORGAN_PRESETS } from '../core/instruments/organ.js';
import { frameWave, WT_FRAMES, TABLE_NAMES } from '../core/instruments/wavetable.js';

const addrOf = (chId) => (id) => `ch:${chId}:p:${id}`;

// ---------------------------------------------------------------------------------- shared pieces
function chHead(app, win, chId, extra = []) {
  const store = app.store, ch = () => store.channel(chId);
  const meta = instrumentMeta(ch().type);
  win.setTitle(ch().name, meta.name);
  const head = h('div.rack-head',
    new Knob(app, { addr: `ch:${chId}:vol`, size: 'sm', title: 'Channel volume' }).el,
    new Knob(app, { addr: `ch:${chId}:pan`, size: 'sm', title: 'Channel panning' }).el,
    new Knob(app, { addr: `ch:${chId}:pitch`, size: 'sm', title: 'Channel pitch (semitones)' }).el,
    ...extra, h('div.grow'),
    h('div.btn', { hint: 'Presets — factory and your own saved settings for this plugin', onclick: (e) => { const r = e.currentTarget.getBoundingClientRect(); showPopup(instrumentPresetItems(app, chId), r.left, r.bottom, r); } }, 'Presets ▾'),
    h('div.btn', { hint: 'Preview — plays the channel at its root key', onclick: () => app.preview(chId) }, '▶ Preview'));
  return head;
}

function tabbed(app, chId, schema, tabs, visuals = {}, labelFix = (d) => d.name) {
  // tabs: [{ name, groups:[...] }] ; visuals[name]: () => element
  let cur = tabs[0].name;
  const bar = h('div.rack-groups'), body = h('div.scroll', { style: { flex: 1, minHeight: 0 } });
  const render = () => {
    clear(bar); clear(body);
    for (const t of tabs) bar.append(h('div.rack-tab', { class: t.name === cur ? 'on' : '', onclick: () => { cur = t.name; render(); } }, t.name));
    const tab = tabs.find((t) => t.name === cur);
    if (visuals[cur]) body.append(visuals[cur]());
    for (const g of tab.groups) {
      const defs = schema.filter((d) => (d.group || 'Main') === g);
      if (!defs.length) continue;
      body.append(h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '10px 14px', padding: '8px 10px', alignContent: 'flex-start' } }, defs.map((d) => paramControl(app, addrOf(chId)(d.id), d, { label: labelFix(d) }))));
    }
  };
  render();
  return { bar, body, render };
}

// Rebuilding controls while one of them is being dragged would destroy the dragged element; defer until release.
function deferWhileDragging(root, fn) {
  let down = false, dirty = false;
  const up = () => { if (!down) return; down = false; if (dirty) { dirty = false; fn(); } };
  root.addEventListener('pointerdown', () => { down = true; }, true);
  window.addEventListener('pointerup', up, true);
  window.addEventListener('pointercancel', up, true);
  const run = () => { if (down) dirty = true; else fn(); };
  run.dispose = () => { window.removeEventListener('pointerup', up, true); window.removeEventListener('pointercancel', up, true); };
  return run;
}

function pickFile(accept, cb) {
  const inp = h('input', { type: 'file', accept, style: { display: 'none' } });
  inp.addEventListener('change', async () => { const f = inp.files[0]; if (f) await cb(f); inp.remove(); });
  document.body.append(inp); inp.click();
}

async function loadSampleFile(app, f) {
  const e = await app.bank.decode(f.name, await f.arrayBuffer());
  return { id: e.id, name: e.name };
}

function sampleMenu(app, onPick, anchor) {
  const items = [{ label: 'Load from disk…', fn: () => pickFile('audio/*,.wav,.mp3,.ogg,.flac,.aif,.aiff,.m4a', async (f) => { try { onPick(await loadSampleFile(app, f)); } catch (e) { app.toast(`Could not decode ${f.name}`); } }) }];
  const cats = {};
  for (const f of FACTORY) (cats[f.cat] = cats[f.cat] || []).push(f);
  items.push({ sep: true }, { title: 'Factory sounds' });
  for (const [cat, list] of Object.entries(cats)) items.push({ label: cat, submenu: list.map((f) => ({ label: f.name, fn: () => onPick({ id: `factory:${f.id}`, name: f.name }) })) });
  const user = [...app.bank.map.values()].filter((e) => e.id.startsWith('user:'));
  if (user.length) items.push({ sep: true }, { title: 'Loaded in this session' }, ...user.slice(0, 30).map((e) => ({ label: e.name, fn: () => onPick({ id: e.id, name: e.name }) })));
  const r = anchor.getBoundingClientRect();
  showPopup(items, r.left, r.bottom, r);
}

function dropFiles(el, app, handler) {
  el.addEventListener('dragover', (e) => { if ([...e.dataTransfer.types].includes('Files') || [...e.dataTransfer.types].includes('application/x-stepwise-sample')) { e.preventDefault(); e.stopPropagation(); } });
  el.addEventListener('drop', async (e) => {
    const sid = e.dataTransfer.getData('application/x-stepwise-sample');
    if (sid) { e.preventDefault(); e.stopPropagation(); const s = JSON.parse(sid); await app.bank.ensure(s.id); handler(s); return; }
    if (!e.dataTransfer.files.length) return;
    e.preventDefault(); e.stopPropagation();
    try { handler(await loadSampleFile(app, e.dataTransfer.files[0])); } catch (err) { app.toast('Could not decode that file'); }
  });
}

// =================================================================================== SAMPLER
export function samplerEditor(win, app, chId) {
  const store = app.store, cmd = app.cmd;
  const ch = () => store.channel(chId);
  const P = (id) => ch().params[id];
  const sampleName = h('span', { style: { color: 'var(--accent)', minWidth: '90px' } }, '');
  const load = h('div.btn', { hint: 'Choose a sample — from disk, the factory pack or this session', onclick: (e) => sampleMenu(app, (s) => { cmd.setChannelSample(store, chId, s); }, e.currentTarget) }, 'Sample…');
  const head = chHead(app, win, chId, [sampleName, load]);
  const wave = h('canvas', { width: 640, height: 130, style: { width: '100%', height: '130px', display: 'block', background: '#0e1012', cursor: 'default' }, hint: 'Waveform — drag the start/end markers (orange) and the loop markers (blue); drop an audio file here' });
  const entry = () => { const c = ch(); return c && c.sample ? store.bank.get(c.sample.use || c.sample.id) : null; };

  const draw = () => {
    const w = wave.parentNode ? Math.max(200, Math.floor(wave.clientWidth || 640)) : 640;
    if (wave.width !== w) wave.width = w;
    const e = entry();
    drawWave(wave, e, { dim: [P('start'), P('end')] });
    const c = wave.getContext('2d'), W = wave.width, H = wave.height;
    const mark = (v, color, label) => { c.fillStyle = color; c.fillRect(Math.round(v * W) - 1, 0, 2, H); c.font = '10px sans-serif'; c.fillText(label, Math.min(W - 36, v * W + 4), 12); };
    if (e) {
      mark(P('start'), '#ffb02e', 'start'); mark(P('end'), '#ffb02e', 'end');
      if (P('loop')) { mark(P('loopStart'), '#4aaedc', 'loop'); mark(P('loopEnd'), '#4aaedc', 'loop'); }
      c.fillStyle = '#8e989f'; c.fillText(`${(e.length / e.rate).toFixed(2)} s  ·  ${e.channels.length === 2 ? 'stereo' : 'mono'}  ·  ${e.rate} Hz`, 8, H - 6);
    }
  };
  const markers = () => [['start', P('start')], ['end', P('end')]].concat(P('loop') ? [['loopStart', P('loopStart')], ['loopEnd', P('loopEnd')]] : []);
  wave.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const r = wave.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    let best = null, bd = 8 / r.width;
    for (const [id, v] of markers()) { const d = Math.abs(v - x); if (d < bd) { bd = d; best = id; } }
    if (!best) { app.preview(chId); return; }
    drag(e, (dx, dy, ev) => {
      let v = clamp((ev.clientX - r.left) / r.width, 0, 1);
      if (best === 'start') v = Math.min(v, P('end') - 0.002);
      if (best === 'end') v = Math.max(v, P('start') + 0.002);
      if (best === 'loopStart') v = clamp(v, P('start'), P('loopEnd') - 0.002);
      if (best === 'loopEnd') v = clamp(v, P('loopStart') + 0.002, P('end'));
      store.setParam(`ch:${chId}:p:${best}`, v, { coalesce: `smp:${best}` });
    });
  });
  dropFiles(wave, app, (s) => cmd.setChannelSample(store, chId, s));

  // ---- INS tab visuals (one block per modulation target)
  const insBlock = (t) => {
    const L = TARGET_LABEL[t];
    const cv = h('canvas', { width: 190, height: 70, style: { width: '190px', height: '70px', background: '#0e1012', border: '1px solid #000' } });
    const lfo = h('canvas', { width: 190, height: 40, style: { width: '190px', height: '40px', background: '#0e1012', border: '1px solid #000' } });
    const redraw = () => {
      const g = (k) => P(`${t}${k}`);
      const isVol = t === 'vol', on = isVol ? P('volEnvOn') : g('Amt') !== 0;
      const sus = g('Sus');
      const stages = isVol && !P('volEnvOn')
        ? [{ t: 0.01, to: 1 }, { t: 0.3, to: 1, hold: 1 }, { t: P('volRel'), to: 0, curve: 'exp' }]
        : [{ t: g('Del'), to: 0 }, { t: g('Att'), to: 1 }, { t: g('Hold'), to: 1 }, { t: g('Dec'), to: sus, curve: 'exp' }, { t: 0.4, to: sus, hold: 1 }, { t: g('Rel'), to: 0, curve: 'exp' }];
      drawEnv(cv, stages, { color: on ? '#ffb02e' : '#5d4a1f' });
      const c = lfo.getContext('2d'), W = lfo.width, H = lfo.height;
      c.fillStyle = '#0e1012'; c.fillRect(0, 0, W, H); c.strokeStyle = g('LfoAmt') !== 0 ? '#4aaedc' : '#25414f'; c.lineWidth = 1.5; c.beginPath();
      const shape = g('LfoShape');
      for (let x = 0; x < W; x++) {
        const ph = ((x / W) * 2) % 1; let v;
        switch (shape) { case 0: v = Math.sin(2 * Math.PI * ph); break; case 1: v = ph < 0.5 ? 4 * ph - 1 : 3 - 4 * ph; break; case 2: v = 2 * ph - 1; break; case 3: v = 1 - 2 * ph; break; case 4: v = ph < 0.5 ? 1 : -1; break; default: v = Math.sin(ph * 40) * Math.cos(ph * 7); }
        const y = H / 2 - v * (H / 2 - 4) * Math.min(1, Math.abs(g('LfoAmt')) + 0.15);
        if (x === 0) c.moveTo(x, y); else c.lineTo(x, y);
      }
      c.stroke();
    };
    redraw();
    const off = store.bus.on('param', (a) => { if (cv.isConnected && a.startsWith(`ch:${chId}:p:${t}`)) redraw(); else if (!cv.isConnected) off(); });
    const ctl = (id, label) => paramControl(app, addrOf(chId)(`${t}${id}`), instrumentSchema('sampler').find((d) => d.id === `${t}${id}`), { label, size: 'sm' });
    return h('div', { style: { padding: '8px 10px', borderBottom: '1px solid #1b1e21' } },
      h('div.row', { style: { gap: '10px', alignItems: 'flex-start' } },
        h('div', h('div.mx-title', { style: { margin: 0 } }, `${L} envelope`), cv, h('div.mx-title', { style: { margin: '4px 0 0' } }, 'LFO'), lfo),
        h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '6px 10px', maxWidth: '420px' } },
          t === 'vol' ? paramControl(app, addrOf(chId)('volEnvOn'), instrumentSchema('sampler').find((d) => d.id === 'volEnvOn'), { label: 'Envelope on' }) : null,
          ...['Del', 'Att', 'Hold', 'Dec', 'Sus', 'Rel'].map((k) => ctl(k, k)), t === 'vol' ? null : ctl('Amt', 'Amount'),
          ctl('LfoAmt', 'LFO amt'), ctl('LfoRate', 'LFO rate'), ctl('LfoShape', 'Shape'), ctl('LfoDel', 'LFO delay'), ctl('LfoAtt', 'LFO att'))));
  };
  const stretchBlock = () => h('div.row', { style: { padding: '4px 10px 10px', gap: '10px' } },
    h('div.btn', { hint: 'Render a time-stretched / pitch-shifted copy of the sample (keeps pitch while changing length) and play that instead', onclick: async () => { app.toast('Stretching…'); await new Promise((r) => setTimeout(r, 20)); const ok = await cmd.applyStretch(store, chId); app.toast(ok ? 'Stretched copy ready' : 'Load a sample first'); } }, 'Apply stretch'),
    h('div.btn', { hint: 'Go back to the original sample', onclick: () => cmd.setSampleUse(store, chId, null) }, 'Use original'),
    h('span.dim', 'Set “Time stretch”, “Stretch time” and “Stretch pitch”, then Apply.'));

  const schema = instrumentSchema('sampler');
  const smpSchema = schema.filter((d) => d.group === 'SMP');
  const insDefs = schema.filter((d) => d.group === 'INS' && !/^(vol|pan|cut|res|pitch)(Del|Att|Hold|Dec|Sus|Rel|Amt|Lfo)/.test(d.id) && d.id !== 'volEnvOn');
  void smpSchema;
  const tabs = [{ name: 'SMP', groups: ['SMP'] }, { name: 'INS', groups: ['INS'] }, { name: 'MISC', groups: ['MISC'] }, { name: 'FUNC', groups: ['FUNC'] }];
  // INS tab uses the custom blocks; the generic grid would repeat every envelope knob
  const ctl = tabbed(app, chId, schema.filter((d) => d.group !== 'INS' || insDefs.includes(d)), tabs, {
    SMP: () => stretchBlock(),
    INS: () => h('div', TARGETS.map((t) => insBlock(t))),
  });
  const el = h('div.rack', head, h('div', { style: { padding: '0 8px', background: '#0e1012', flex: 'none' } }, wave), ctl.bar, ctl.body);
  const subs = [
    store.bus.on('change', () => { const c = ch(); if (c) { win.setTitle(c.name, instrumentMeta(c.type).name); sampleName.textContent = c.sample ? c.sample.name + (c.sample.use ? ' (stretched)' : '') : '(no sample)'; draw(); } }),
    store.bus.on('param', (a) => { if (a.startsWith(`ch:${chId}:p:`)) draw(); }),
    store.bus.on('samples', draw),
    store.bus.on('project', () => { if (!ch()) win.close(); else draw(); }),
  ];
  sampleName.textContent = ch().sample ? ch().sample.name : '(no sample)';
  requestAnimationFrame(draw);
  return { el, onResize: draw, destroy() { for (const s of subs) s(); } };
}

// =================================================================================== FPC
export function fpcEditor(win, app, chId) {
  const store = app.store, cmd = app.cmd;
  const ch = () => store.channel(chId);
  let sel = 0;
  const head = chHead(app, win, chId);
  const bankEl = h('div.seg');
  const grid = h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '5px', padding: '8px', flex: 'none', width: '300px' } });
  const insp = h('div.scroll', { style: { flex: 1, minWidth: 0 } });
  const bank = () => ch().padBank || 0;
  const padIdx = (slot) => bank() * 16 + slot;       // slot 0..15 in visual order (bottom-left = 0)

  const buildBanks = () => {
    clear(bankEl);
    BANKS.forEach((b, i) => bankEl.append(h('div.btn' + (bank() === i ? '.on' : ''), { hint: `Bank ${b} — pads ${i * 16 + 1}–${i * 16 + 16}`, onclick: () => { sel = i * 16 + (sel % 16); cmd.setChannelData(store, chId, { padBank: i }, 'FPC bank'); } }, b)));
  };
  const buildGrid = () => {
    clear(grid);
    for (let row = 3; row >= 0; row--) for (let col = 0; col < 4; col++) {
      const slot = row * 4 + col, idx = padIdx(slot), pad = ch().pads[idx];
      const label = pad.name || (pad.layers[0] ? pad.layers[0].sample.name : '');
      const el = h('div.fpc-pad', { class: `${idx === sel ? 'sel ' : ''}${pad.layers.length ? 'has ' : ''}${pad.mute ? 'mute' : ''}`, dataset: { pad: idx },
        hint: `Pad ${idx + 1} (${keyName(pad.note)}) — click to play and edit, drop a sample on it` },
      h('div.fpc-n', String(idx + 1)), h('div.fpc-l', label || '—'));
      el.addEventListener('pointerdown', (e) => { if (e.button !== 0) return; sel = idx; app.preview(chId, pad.note); buildGrid(); buildInsp(); });
      el.addEventListener('contextmenu', (e) => contextMenu(e, [
        { label: 'Load sample…', fn: () => pickFile('audio/*', async (f) => { const s = await loadSampleFile(app, f); addLayer(idx, s); }) },
        { label: 'Clear pad', fn: () => cmd.editPad(store, chId, idx, (pd) => { pd.layers = []; pd.name = ''; }, 'Clear pad') },
        { label: pad.mute ? 'Unmute' : 'Mute', fn: () => cmd.editPad(store, chId, idx, (pd) => { pd.mute = pd.mute ? 0 : 1; }, 'Mute pad') },
      ]));
      dropFiles(el, app, (s) => { sel = idx; addLayer(idx, s); });
      grid.append(el);
    }
  };
  const addLayer = (idx, s) => {
    app.bank.ensure(s.id);
    cmd.editPad(store, chId, idx, (pd) => { if (pd.layers.length < MAX_LAYERS) pd.layers.push({ sample: { id: s.id, name: s.name }, vol: 1, pan: 0, pitch: 0, start: 0 }); }, 'Add layer');
  };

  const buildInsp = () => {
    clear(insp);
    const pad = ch().pads[sel];
    const edit = (fn, label) => cmd.editPad(store, chId, sel, fn, label);
    const k = (title, key, min, max, def, unit = '') => new Knob(app, { def: { id: key, name: title, min, max, def, unit, curve: 'lin', step: key === 'pitch' ? 0.01 : undefined }, value: pad[key], size: 'sm', title, label: title, onChange: (v) => edit((pd) => { pd[key] = v; }, `Pad ${key}`) }).root;
    const nameIn = h('input.field', { type: 'text', value: pad.name, placeholder: 'Pad name', style: { width: '140px' } });
    nameIn.addEventListener('change', () => edit((pd) => { pd.name = nameIn.value.slice(0, 24); }, 'Rename pad'));
    const note = h('input.field', { type: 'number', min: 0, max: 127, value: pad.note, style: { width: '60px' }, hint: 'MIDI key that triggers this pad (60 = C5)' });
    note.addEventListener('change', () => edit((pd) => { pd.note = clamp(+note.value || 0, 0, 127); }, 'Pad note'));
    const choke = h('select.select', { hint: 'Choke group — pads in the same group cut each other' }, [h('option', { value: 0 }, 'No choke'), ...[1, 2, 3, 4, 5, 6, 7, 8].map((n) => h('option', { value: n }, `Group ${n}`))]);
    choke.value = String(pad.choke); choke.addEventListener('change', () => edit((pd) => { pd.choke = +choke.value; }, 'Pad choke'));
    const tog = (key, label, hint) => h('div.btn' + (pad[key] ? '.on' : ''), { hint, onclick: () => edit((pd) => { pd[key] = pd[key] ? 0 : 1; }, `Pad ${key}`) }, label);
    insp.append(h('div.mx-title', `Pad ${sel + 1}  ·  ${keyName(pad.note)}`),
      h('div.row', { style: { padding: '6px 10px', gap: '10px', flexWrap: 'wrap' } }, nameIn, h('span.dim', 'Key'), note, choke, tog('mute', 'Mute', 'Mute this pad'), tog('solo', 'Solo', 'Solo this pad'), tog('gate', 'Gate', 'Gate: the sound stops when the note ends')),
      h('div.row', { style: { padding: '4px 10px 8px', gap: '14px' } }, k('Volume', 'vol', 0, 2, 1), k('Pan', 'pan', -1, 1, 0), k('Pitch', 'pitch', -24, 24, 0, 'st')),
      h('div.mx-title', 'Layers (all layers play together)'));
    pad.layers.forEach((l, li) => {
      const lk = (title, key, min, max, def) => new Knob(app, { def: { id: key, name: title, min, max, def, unit: '', curve: 'lin', step: key === 'pitch' ? 0.01 : undefined }, value: l[key], size: 'sm', title, label: title, onChange: (v) => edit((pd) => { if (pd.layers[li]) pd.layers[li][key] = v; }, `Layer ${key}`) }).root;
      insp.append(h('div.row', { style: { padding: '4px 10px', gap: '10px', borderBottom: '1px solid #1b1e21' } },
        h('div', { style: { width: '130px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--accent)' }, hint: l.sample.name }, l.sample.name),
        lk('Vol', 'vol', 0, 2, 1), lk('Pan', 'pan', -1, 1, 0), lk('Pitch', 'pitch', -24, 24, 0), lk('Start', 'start', 0, 0.9, 0),
        h('div.btn.sm', { hint: 'Replace this layer\'s sample', onclick: (e) => sampleMenu(app, (s) => { app.bank.ensure(s.id); edit((pd) => { pd.layers[li].sample = { id: s.id, name: s.name }; }, 'Replace layer'); }, e.currentTarget) }, '…'),
        h('div.btn.sm', { hint: 'Remove layer', onclick: () => edit((pd) => { pd.layers.splice(li, 1); }, 'Remove layer') }, '✕')));
    });
    if (pad.layers.length < MAX_LAYERS) insp.append(h('div.row', { style: { padding: '8px 10px' } }, h('div.btn', { hint: 'Add a sample layer to this pad', onclick: (e) => sampleMenu(app, (s) => addLayer(sel, s), e.currentTarget) }, '＋ Add layer')));
  };
  const all = () => { buildBanks(); buildGrid(); buildInsp(); };
  all();
  const left = h('div', { style: { display: 'flex', flexDirection: 'column', flex: 'none', borderRight: '1px solid #000' } }, h('div.row', { style: { padding: '6px 8px', gap: '8px' } }, h('span.dim', 'Bank'), bankEl), grid);
  const el = h('div.rack', head, h('div', { style: { display: 'flex', flex: 1, minHeight: 0 } }, left, insp));
  const refresh = deferWhileDragging(insp, () => { if (ch()) { sel = clamp(sel, bank() * 16, bank() * 16 + 15); all(); } });
  const subs = [
    store.bus.on('change', ({ paths }) => { if (paths.some((p) => p[0] === 'channels')) { if (!ch()) return; refresh(); } }),
    store.bus.on('project', () => { if (!ch()) win.close(); else all(); }),
    refresh.dispose,
  ];
  return { el, destroy() { for (const s of subs) s(); } };
}

// =================================================================================== SLICER
export function slicerEditor(win, app, chId) {
  const store = app.store, cmd = app.cmd;
  const ch = () => store.channel(chId);
  const entry = () => (ch().sample ? store.bank.get(ch().sample.id) : null);
  const sampleName = h('span', { style: { color: 'var(--accent)' } }, '');
  const head = chHead(app, win, chId, [sampleName, h('div.btn', { hint: 'Load the loop to slice', onclick: (e) => sampleMenu(app, async (s) => { await app.bank.ensure(s.id); cmd.setChannelSample(store, chId, s); autoSlice(s.id); }, e.currentTarget) }, 'Loop…')]);
  const wave = h('canvas', { width: 700, height: 150, style: { width: '100%', height: '150px', display: 'block', background: '#0e1012' }, hint: 'Slices — click a slice to play it, drag a marker to move it, double-click to add, right-click a marker to delete' });
  let sens = 0.55;
  const sensIn = h('input', { type: 'range', min: 0, max: 100, value: sens * 100, style: { width: '110px', accentColor: 'var(--accent)' }, hint: 'Detection sensitivity — higher finds more transients' });
  sensIn.addEventListener('input', () => { sens = sensIn.value / 100; });
  const info = h('span.dim', '');

  const autoSlice = (id) => {
    const e = id ? store.bank.get(id) : entry();
    if (!e) return;
    const mono = e.channels.length === 1 ? e.channels[0] : Float32Array.from(e.channels[0], (v, i) => (v + e.channels[1][i]) / 2);
    const est = estimateLoop(e.length, e.rate);
    cmd.setSlices(store, chId, detectSlices(mono, e.rate, { sensitivity: sens }), est.bpm);
  };
  const barsSel = h('select.select', { hint: 'Length of the loop in bars — sets its tempo' }, [1, 2, 4, 8, 16].map((b) => h('option', { value: b }, `${b} bar${b > 1 ? 's' : ''}`)));
  barsSel.addEventListener('change', () => { const e = entry(); if (e) cmd.setSlices(store, chId, ch().slices, (+barsSel.value * 4 * 60) / (e.length / e.rate)); });
  const evenN = h('input.field', { type: 'number', min: 1, max: 64, value: 8, style: { width: '56px' } });
  const bar = h('div.row', { style: { padding: '5px 8px', gap: '8px', flexWrap: 'wrap', borderBottom: '1px solid #000', background: 'var(--bg2)' } },
    h('span.dim', 'Sensitivity'), sensIn,
    h('div.btn', { hint: 'Find transients and cut the loop there', onclick: () => autoSlice() }, 'Detect'),
    h('span.dim', 'or'), evenN, h('div.btn', { hint: 'Cut into equal parts', onclick: () => { const e = entry(); if (e) cmd.setSlices(store, chId, evenSlices(e.length, +evenN.value || 8)); } }, 'Even slices'),
    h('span.dim', 'Loop'), barsSel,
    h('div.btn.primary', { hint: 'Write the slices into the current pattern in their original order (starts snapped to the grid)', onclick: () => { const n = cmd.sliceToPattern(store, chId, app.snapTicks({ cell: 24 })); app.toast(n ? `Wrote ${n} notes to the current pattern` : 'Load a loop and cut it first'); } }, 'Generate MIDI'),
    info);
  const draw = () => {
    const w = Math.max(200, Math.floor(wave.clientWidth || 700)); if (wave.width !== w) wave.width = w;
    const e = entry();
    drawWave(wave, e, {});
    const c = wave.getContext('2d'), W = wave.width, H = wave.height;
    if (!e) return;
    const sl = ch().slices;
    sl.forEach((s, i) => {
      const x = (s / e.length) * W, nx = i + 1 < sl.length ? (sl[i + 1] / e.length) * W : W;
      c.fillStyle = i % 2 ? 'rgba(74,168,224,.10)' : 'rgba(255,176,46,.08)'; c.fillRect(x, 0, nx - x, H);
      c.fillStyle = '#ffb02e'; c.fillRect(Math.round(x), 0, 2, H);
      c.fillStyle = '#fff'; c.font = '10px sans-serif'; c.fillText(String(i + 1), x + 4, 12);
    });
    const bpm = ch().loopBpm;
    info.textContent = `${sl.length} slices${bpm ? ` · loop ${bpm.toFixed(1)} BPM` : ''} · keys C5–${keyName(60 + Math.max(0, sl.length - 1))}`;
    const bars = bpm && e ? Math.round((e.length / e.rate) * bpm / 240) : 0;
    if ([1, 2, 4, 8, 16].includes(bars)) barsSel.value = String(bars);
  };
  wave.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0) return;
    const e = entry(); if (!e) return;
    const r = wave.getBoundingClientRect(), x = (ev.clientX - r.left) / r.width;
    const sl = ch().slices.slice();
    let mi = -1, bd = 7 / r.width;
    sl.forEach((s, i) => { const d = Math.abs(s / e.length - x); if (d < bd) { bd = d; mi = i; } });
    if (mi < 0) { let idx = 0; sl.forEach((s, i) => { if (s / e.length <= x) idx = i; }); app.preview(chId, 60 + idx); return; }
    if (mi === 0) return;
    drag(ev, (dx, dy, mv) => {
      const v = clamp(((mv.clientX - r.left) / r.width) * e.length, (sl[mi - 1] || 0) + 64, (sl[mi + 1] || e.length) - 64);
      sl[mi] = Math.floor(v); cmd.setSlices(store, chId, sl);
    });
  });
  wave.addEventListener('dblclick', (ev) => {
    const e = entry(); if (!e) return;
    const r = wave.getBoundingClientRect(); const pos = Math.floor(((ev.clientX - r.left) / r.width) * e.length);
    const sl = ch().slices.slice();
    if (sl.some((s) => Math.abs(s - pos) < 400)) return;
    sl.push(pos); sl.sort((a, b) => a - b); cmd.setSlices(store, chId, sl);
  });
  wave.addEventListener('contextmenu', (ev) => {
    ev.preventDefault();
    const e = entry(); if (!e) return;
    const r = wave.getBoundingClientRect(), x = (ev.clientX - r.left) / r.width;
    const sl = ch().slices.slice();
    let mi = -1, bd = 9 / r.width;
    sl.forEach((s, i) => { const d = Math.abs(s / e.length - x); if (d < bd) { bd = d; mi = i; } });
    if (mi > 0) { sl.splice(mi, 1); cmd.setSlices(store, chId, sl); }
  });
  dropFiles(wave, app, async (s) => { await app.bank.ensure(s.id); cmd.setChannelSample(store, chId, s); autoSlice(s.id); });
  const ctl = tabbed(app, chId, instrumentSchema('slicer'), [{ name: 'Main', groups: ['Main'] }]);
  const el = h('div.rack', head, bar, h('div', { style: { padding: '0 8px', background: '#0e1012', flex: 'none' } }, wave), ctl.body);
  const subs = [
    store.bus.on('change', () => { const c = ch(); if (!c) return; sampleName.textContent = c.sample ? c.sample.name : '(no loop)'; draw(); }),
    store.bus.on('samples', draw), store.bus.on('project', () => { if (!ch()) win.close(); else draw(); }),
  ];
  sampleName.textContent = ch().sample ? ch().sample.name : '(no loop)';
  requestAnimationFrame(draw);
  return { el, onResize: draw, destroy() { for (const s of subs) s(); } };
}

// =================================================================================== DRUM SYNTH
export function drumsEditor(win, app, chId) {
  const store = app.store, cmd = app.cmd;
  const ch = () => store.channel(chId);
  const schema = instrumentSchema('drums');
  const preview = h('canvas', { width: 520, height: 90, style: { width: '100%', height: '90px', display: 'block', background: '#0e1012' }, hint: 'Rendered preview of the current settings' });
  const draw = () => {
    const w = Math.max(200, Math.floor(preview.clientWidth || 520)); if (preview.width !== w) preview.width = w;
    const params = { ...ch().params };
    const data = renderOneShot(app.host.sampleRate, params, 1.4, 60);
    drawWave(preview, { channels: [data], length: data.length, rate: app.host.sampleRate }, { color: '#ffb02e' });
  };
  const typeSel = h('select.select', { hint: 'Drum type — loads a matching starting point' }, ['Kick', 'Snare', 'Hat', 'Tom'].map((n, i) => h('option', { value: i }, n)));
  typeSel.value = String(ch().params.type);
  typeSel.addEventListener('change', () => { const t = +typeSel.value; cmd.applyParams(store, chId, { type: t, ...TYPE_PRESETS[t] }, 'Drum type'); app.preview(chId); });
  const head = chHead(app, win, chId, [h('span.dim', 'Type'), typeSel]);
  const ctl = tabbed(app, chId, schema.filter((d) => d.id !== 'type'), [{ name: 'Sound', groups: ['Main', ''] }]);
  const el = h('div.rack', head, preview, ctl.body);
  let t = 0;
  const subs = [
    store.bus.on('param', (a) => { if (a.startsWith(`ch:${chId}:p:`)) { clearTimeout(t); t = setTimeout(draw, 40); typeSel.value = String(ch().params.type); } }),
    store.bus.on('change', () => { if (ch()) { win.setTitle(ch().name, 'Drum synth'); draw(); } }),
    store.bus.on('project', () => { if (!ch()) win.close(); else draw(); }),
  ];
  requestAnimationFrame(draw);
  return { el, onResize: draw, destroy() { for (const s of subs) s(); clearTimeout(t); } };
}

// =================================================================================== SUB SYNTH
export function synthEditor(win, app, chId) {
  const store = app.store;
  const ch = () => store.channel(chId);
  const schema = instrumentSchema('subsynth');
  const groups = [...new Set(schema.map((d) => d.group))];
  const envBox = (prefix, label) => () => {
    const cv = h('canvas', { width: 280, height: 90, style: { width: '280px', height: '90px', background: '#0e1012', border: '1px solid #000', margin: '8px 10px 0' } });
    const redraw = () => {
      const p = ch().params;
      drawEnv(cv, [{ t: p[`${prefix}a`], to: 1 }, { t: p[`${prefix}d`], to: p[`${prefix}s`], curve: 'exp' }, { t: 0.5, to: p[`${prefix}s`], hold: 1 }, { t: p[`${prefix}r`], to: 0, curve: 'exp' }], { color: prefix === 'f' ? '#4aaedc' : '#ffb02e' });
    };
    redraw();
    const off = store.bus.on('param', (a) => { if (cv.isConnected) { if (a.startsWith(`ch:${chId}:p:${prefix}`)) redraw(); } else off(); });
    return h('div', h('div.mx-title', { style: { margin: '0' } }, `${label} envelope`), cv);
  };
  const head = chHead(app, win, chId);
  const ctl = tabbed(app, chId, schema, groups.map((g) => ({ name: g, groups: [g] })), { Filter: envBox('f', 'Filter'), Amp: envBox('a', 'Amplitude') }, (d) => d.name.replace(/^(Osc \d|LFO \d) /, ''));
  const el = h('div.rack', head, ctl.bar, ctl.body);
  const sub = store.bus.on('change', () => { if (ch()) win.setTitle(ch().name, 'Sub Synth'); });
  return { el, destroy() { sub(); } };
}

// =================================================================================== FM SYNTH
export function fmEditor(win, app, chId) {
  const store = app.store, cmd = app.cmd;
  const ch = () => store.channel(chId);
  const P = (id) => ch().params[id];
  const schema = instrumentSchema('fm');
  const map = schemaMap(schema);
  const head = chHead(app, win, chId);
  const algoSel = h('select.select', { style: { maxWidth: '260px' }, hint: 'Algorithm — how the six operators modulate each other. Editing the matrix switches to Custom' }, map.get('algo').options.map((n, i) => h('option', { value: i }, n)));
  algoSel.addEventListener('change', () => store.setParam(`ch:${chId}:p:algo`, +algoSel.value));
  const diagram = h('canvas', { width: 300, height: 130, style: { width: '300px', height: '130px', background: '#0e1012', border: '1px solid #000' } });
  const matrixEl = h('div');

  const current = () => (P('algo') < ALGOS.length ? algoMatrix(P('algo')) : {
    m: Array.from({ length: OPS }, (_, i) => Array.from({ length: OPS }, (_, j) => P(`mod${i + 1}${j + 1}`))),
    out: Array.from({ length: OPS }, (_, i) => P(`out${i + 1}`)),
  });
  const ensureCustom = () => {
    if (P('algo') < ALGOS.length) {
      const { m, out } = algoMatrix(P('algo'));
      const vals = { algo: ALGOS.length };
      for (let i = 0; i < OPS; i++) { for (let j = 0; j < OPS; j++) vals[`mod${i + 1}${j + 1}`] = m[i][j]; vals[`out${i + 1}`] = out[i]; }
      cmd.applyParams(store, chId, vals, 'Switch to custom algorithm');
      for (const [k, v] of Object.entries(vals)) store.host.send({ t: 'param', addr: `ch:${chId}:p:${k}`, value: v });
    }
  };
  const drawDiagram = () => {
    const c = diagram.getContext('2d'), W = diagram.width, H = diagram.height;
    c.fillStyle = '#0e1012'; c.fillRect(0, 0, W, H);
    const { m, out } = current();
    // level of each operator = longest chain of modulators above it
    const level = new Array(OPS).fill(0);
    for (let pass = 0; pass < OPS; pass++) for (let i = 0; i < OPS; i++) for (let j = 0; j < OPS; j++) if (i !== j && m[i][j] > 0) level[j] = Math.max(level[j], level[i] + 1);
    const maxL = Math.max(...level);
    const cols = new Array(maxL + 1).fill(0), pos = [];
    for (let i = 0; i < OPS; i++) { pos[i] = [level[i], cols[level[i]]++]; }
    const xy = (i) => [30 + (pos[i][1] + 0.5) * ((W - 60) / Math.max(1, Math.max(...cols))), 18 + (maxL - pos[i][0]) * ((H - 52) / Math.max(1, maxL))];
    c.strokeStyle = '#4aaedc'; c.lineWidth = 1.5;
    for (let i = 0; i < OPS; i++) for (let j = 0; j < OPS; j++) if (i !== j && m[i][j] > 0) { const [x0, y0] = xy(j), [x1, y1] = xy(i); c.globalAlpha = 0.3 + 0.7 * m[i][j]; c.beginPath(); c.moveTo(x0, y0 + 10); c.lineTo(x1, y1 - 10); c.stroke(); }
    c.globalAlpha = 1;
    for (let i = 0; i < OPS; i++) {
      const [x, y] = xy(i), car = out[i] > 0;
      c.fillStyle = car ? '#ffb02e' : '#2d343a'; c.strokeStyle = '#000'; c.beginPath(); c.roundRect(x - 13, y - 10, 26, 20, 4); c.fill(); c.stroke();
      c.fillStyle = car ? '#1a1306' : '#d5dce0'; c.font = 'bold 11px sans-serif'; c.fillText(String(i + 1), x - 3.5, y + 4);
      if (m[i][i] > 0 || P(`fb${i + 1}`) > 0) { c.strokeStyle = '#7fdc5c'; c.beginPath(); c.arc(x + 15, y - 8, 5, 0, 6.28); c.stroke(); }
      if (car) { c.strokeStyle = '#ffb02e'; c.beginPath(); c.moveTo(x, y + 10); c.lineTo(x, y + 20); c.stroke(); }
    }
    c.fillStyle = '#8e989f'; c.font = '9px sans-serif'; c.fillText('orange = carriers (heard), blue lines = modulation', 6, H - 4);
  };
  const buildMatrix = () => {
    clear(matrixEl);
    const { m, out } = current();
    const tbl = h('div', { style: { display: 'grid', gridTemplateColumns: `34px repeat(${OPS}, 34px) 40px`, gap: '2px', padding: '8px 10px', alignItems: 'center' } });
    tbl.append(h('div.dim', { style: { fontSize: '9px' } }, 'to ⟵ from'));
    for (let j = 0; j < OPS; j++) tbl.append(h('div.knob-label', `Op ${j + 1}`));
    tbl.append(h('div.knob-label', 'Out'));
    for (let i = 0; i < OPS; i++) {
      tbl.append(h('div.knob-label', `Op ${i + 1}`));
      for (let j = 0; j < OPS; j++) tbl.append(cell(m[i][j], (v) => { ensureCustom(); store.setParam(`ch:${chId}:p:mod${i + 1}${j + 1}`, v, { coalesce: `fmmx${i}${j}` }); }, i === j ? 'feedback' : `Op ${j + 1} → Op ${i + 1}`));
      tbl.append(cell(out[i], (v) => { ensureCustom(); store.setParam(`ch:${chId}:p:out${i + 1}`, v, { coalesce: `fmout${i}` }); }, `Op ${i + 1} output level`, true));
    }
    matrixEl.append(h('div.mx-title', 'Modulation matrix (drag a cell up/down, double-click clears)'), tbl);
  };
  const cell = (v, set, hint, isOut) => {
    const el = h('div', { hint, style: { height: '24px', background: `rgba(${isOut ? '255,176,46' : '74,168,224'},${0.08 + v * 0.8})`, border: '1px solid #000', borderRadius: '3px', textAlign: 'center', lineHeight: '24px', cursor: 'ns-resize', fontSize: '10px', color: v > 0 ? '#fff' : '#5b666e' } }, v > 0 ? v.toFixed(2) : '·');
    el.addEventListener('pointerdown', (e) => { if (e.button !== 0) return; const start = v; drag(e, (dx, dy) => { const nv = Math.round(clamp(start - dy / 80, 0, 1) * 100) / 100; set(nv); }); });
    el.addEventListener('dblclick', () => set(0));
    return el;
  };
  const opSel = h('div.rack-groups');
  const opBody = h('div.scroll', { style: { flex: 1, minHeight: 0 } });
  let op = 1;
  const buildOp = () => {
    clear(opSel); clear(opBody);
    for (let i = 1; i <= OPS; i++) opSel.append(h('div.rack-tab', { class: i === op ? 'on' : '', onclick: () => { op = i; buildOp(); } }, `Op ${i}`));
    opSel.append(h('div.rack-tab', { class: op === 0 ? 'on' : '', onclick: () => { op = 0; buildOp(); } }, 'Global'));
    const defs = op === 0 ? schema.filter((d) => d.group === 'Main' && d.id !== 'algo') : schema.filter((d) => d.group === `Op ${op}`);
    if (op > 0) {
      const cv = h('canvas', { width: 220, height: 70, style: { width: '220px', height: '70px', background: '#0e1012', border: '1px solid #000', margin: '8px 10px 0' } });
      const redraw = () => drawEnv(cv, [{ t: P(`att${op}`), to: 1 }, { t: P(`dec${op}`), to: P(`sus${op}`), curve: 'exp' }, { t: 0.4, to: P(`sus${op}`), hold: 1 }, { t: P(`rel${op}`), to: 0, curve: 'exp' }], {});
      redraw();
      const o = store.bus.on('param', (a) => { if (cv.isConnected) { if (a.startsWith(`ch:${chId}:p:`)) redraw(); } else o(); });
      opBody.append(cv);
    }
    opBody.append(h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '10px 14px', padding: '8px 10px' } }, defs.map((d) => paramControl(app, addrOf(chId)(d.id), d, { label: d.name.replace(/^Op \d /, '') }))));
  };
  const refresh = () => { algoSel.value = String(P('algo')); drawDiagram(); buildMatrix(); };
  const top = h('div', { style: { display: 'flex', gap: '12px', padding: '8px 10px', alignItems: 'flex-start', flexWrap: 'wrap', borderBottom: '1px solid #000' } },
    h('div', h('div.knob-label', { style: { textAlign: 'left' } }, 'ALGORITHM'), algoSel, h('div', { style: { height: '6px' } }), diagram), matrixEl);
  refresh(); buildOp();
  const el = h('div.rack', head, top, opSel, opBody);
  let tm = 0;
  const subs = [
    store.bus.on('param', (a) => { if (a.startsWith(`ch:${chId}:p:`) && /:(algo|mod\d\d|out\d|fb\d)$/.test(a)) { clearTimeout(tm); tm = setTimeout(refresh, 30); } }),
    store.bus.on('project', () => { if (!ch()) win.close(); else { refresh(); buildOp(); } }),
    store.bus.on('change', () => { if (ch()) win.setTitle(ch().name, 'FM Synth'); }),
  ];
  return { el, destroy() { for (const s of subs) s(); clearTimeout(tm); } };
}

// default window sizes
samplerEditor.rect = { w: 660, h: 520 };
fpcEditor.rect = { w: 740, h: 480 };
slicerEditor.rect = { w: 720, h: 430 };
drumsEditor.rect = { w: 560, h: 400 };
synthEditor.rect = { w: 620, h: 440 };
fmEditor.rect = { w: 780, h: 580 };


// =================================================================================== ORGAN
const DRAWBAR_COLOR = ['#8a5a2b', '#8a5a2b', '#e8e6e1', '#e8e6e1', '#2a2d31', '#e8e6e1', '#2a2d31', '#e8e6e1', '#e8e6e1'];
export function organEditor(win, app, chId) {
  const store = app.store, cmd = app.cmd;
  const ch = () => store.channel(chId);
  const schema = instrumentSchema('organ');
  const head = chHead(app, win, chId);
  const bars = h('div.organ-bars');
  const drawbar = (i) => {
    const el = h('div.organ-bar', { dataset: { bar: i }, hint: `Drawbar ${FOOTAGE[i][0]} — drag or click to set the level (0 to 8), double-click resets` },
      h('div.organ-track'), h('div.organ-knob', { style: { background: DRAWBAR_COLOR[i], color: DRAWBAR_COLOR[i] === '#e8e6e1' ? '#222' : '#fff' } }), h('div.organ-label', FOOTAGE[i][0]), h('div.organ-val'));
    const set = (clientY) => {
      const r = el.querySelector('.organ-track').getBoundingClientRect();
      const lv = clamp(Math.round(((clientY - r.top) / r.height) * 8), 0, 8);
      store.setParam(`ch:${chId}:p:d${i}`, lv, { coalesce: `organ:d${i}` });
    };
    el.addEventListener('pointerdown', (e) => { if (e.button !== 0) return; set(e.clientY); drag(e, (dx, dy, ev) => set(ev.clientY)); });
    el.addEventListener('dblclick', () => store.setParam(`ch:${chId}:p:d${i}`, schema.find((d) => d.id === `d${i}`).def));
    el.addEventListener('contextmenu', (e) => contextMenu(e, [{ title: `Drawbar ${FOOTAGE[i][0]}` }, ...(app.paramMenuItems ? app.paramMenuItems(`ch:${chId}:p:d${i}`) : [])]));
    return el;
  };
  for (let i = 0; i < 9; i++) bars.append(drawbar(i));
  const paint = () => {
    const c = ch(); if (!c) return;
    bars.querySelectorAll('.organ-bar').forEach((el, i) => {
      const v = c.params[`d${i}`];
      el.querySelector('.organ-knob').style.top = `${(v / 8) * 100}%`;
      el.querySelector('.organ-val').textContent = String(v);
      el.querySelector('.organ-track').style.setProperty('--fill', `${(v / 8) * 100}%`);
    });
  };
  const presetRow = h('div.row', { style: { padding: '6px 10px', gap: '6px', flexWrap: 'wrap' } }, h('span.dim', 'Registrations'),
    ...Object.entries(ORGAN_PRESETS).map(([name, lv]) => h('div.btn.sm', { hint: `${name} — sets all nine drawbars`, onclick: () => cmd.applyParams(store, chId, Object.fromEntries(lv.map((v, i) => [`d${i}`, v])), `Registration: ${name}`) }, name)));
  const ctl = tabbed(app, chId, schema, [{ name: 'Drawbars', groups: [] }, { name: 'Percussion', groups: ['Percussion'] }, { name: 'Sound', groups: ['Sound'] }], { Drawbars: () => h('div', bars, presetRow) });
  const el = h('div.rack', head, ctl.bar, ctl.body);
  const subs = [store.bus.on('param', (a) => { if (a.startsWith(`ch:${chId}:p:d`)) paint(); }), store.bus.on('change', paint), store.bus.on('project', () => { if (!ch()) win.close(); else paint(); })];
  ctl.bar.addEventListener('click', () => requestAnimationFrame(paint));       // the drawbars are re-attached when their tab is shown
  requestAnimationFrame(paint);
  return { el, destroy() { for (const s of subs) s(); } };
}
organEditor.rect = { w: 560, h: 420 };

// =================================================================================== WAVETABLE
export function wavetableEditor(win, app, chId) {
  const store = app.store;
  const ch = () => store.channel(chId);
  const schema = instrumentSchema('wavetable');
  const head = chHead(app, win, chId);
  const cv = h('canvas', { width: 520, height: 150, style: { width: '100%', height: '150px', display: 'block', background: '#0e1012', cursor: 'ew-resize' }, hint: 'Wavetable — drag horizontally to scan through the frames (Position)' });
  const draw = () => {
    const c = ch(); if (!c) return;
    const W = Math.max(200, Math.floor(cv.clientWidth || 520)); if (cv.width !== W) cv.width = W;
    const H = cv.height, g = cv.getContext('2d');
    g.fillStyle = '#0e1012'; g.fillRect(0, 0, W, H);
    const table = c.params.table, pos = c.params.pos;
    const N = 2048, buf = new Float32Array(N);
    const frames = WT_FRAMES, plotW = W - 80, plotH = H - 50;
    // back-to-front stack of all frames, slightly offset like a waterfall
    for (let f = frames - 1; f >= 0; f--) {
      frameWave(table, f / (frames - 1), buf);
      const ox = 10 + (f / (frames - 1)) * 60, oy = 8 + (1 - f / (frames - 1)) * 30;
      g.strokeStyle = `rgba(255,176,46,${0.18 + 0.1 * (1 - f / (frames - 1))})`; g.lineWidth = 1; g.beginPath();
      for (let x = 0; x <= 128; x++) { const v = buf[Math.min(N - 1, Math.floor((x / 128) * N))]; const px = ox + (x / 128) * plotW, py = oy + plotH / 2 - v * plotH * 0.42; if (x === 0) g.moveTo(px, py); else g.lineTo(px, py); }
      g.stroke();
    }
    // current frame, bright
    frameWave(table, pos, buf);
    const ox = 10 + pos * 60, oy = 8 + (1 - pos) * 30;
    g.strokeStyle = '#ffc04a'; g.lineWidth = 2; g.beginPath();
    for (let x = 0; x <= 256; x++) { const v = buf[Math.min(N - 1, Math.floor((x / 256) * N))]; const px = ox + (x / 256) * plotW, py = oy + plotH / 2 - v * plotH * 0.42; if (x === 0) g.moveTo(px, py); else g.lineTo(px, py); }
    g.stroke();
    g.fillStyle = '#8e989f'; g.font = '10px sans-serif'; g.fillText(`${TABLE_NAMES[table]}  ·  position ${(pos * 100).toFixed(0)}%`, 8, H - 6);
  };
  cv.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const r = cv.getBoundingClientRect(), start = ch().params.pos, sx = e.clientX;
    drag(e, (dx, dy, ev) => store.setParam(`ch:${chId}:p:pos`, clamp(start + (ev.clientX - sx) / r.width * 1.2, 0, 1), { coalesce: 'wt:pos' }));
  });
  const groups = [...new Set(schema.map((d) => d.group))];
  const ctl = tabbed(app, chId, schema, groups.map((g) => ({ name: g, groups: [g] })), {});
  const el = h('div.rack', head, h('div', { style: { padding: '0 8px', background: '#0e1012', flex: 'none' } }, cv), ctl.bar, ctl.body);
  const subs = [
    store.bus.on('param', (a) => { if (a.startsWith(`ch:${chId}:p:`)) draw(); }),
    store.bus.on('change', draw), store.bus.on('project', () => { if (!ch()) win.close(); else draw(); }),
  ];
  requestAnimationFrame(draw);
  return { el, onResize: draw, destroy() { for (const s of subs) s(); } };
}
wavetableEditor.rect = { w: 640, h: 520 };
