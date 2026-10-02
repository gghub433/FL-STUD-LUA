// Mixer window: Master + 125 insert strips (scrolling), and a detail panel for the selected track
// with the 10 effect slots, 3-band EQ + spectrum analyser, routing and track options.
import { h, drag, clamp, clear } from './h.js';
import { Knob } from './knob.js';
import { contextMenu, showPopup } from './menu.js';
import { promptText, pickColor } from './dialog.js';
import { faderGain } from '../core/dsp.js';
import { FX_SLOTS, MAX_INSERT } from '../core/constants.js';
import { EFFECTS } from '../core/effects/index.js';
import { trackName } from '../core/addr.js';
import { reaches } from '../core/project.js';

const ICONS = ['', '♪', '♫', '◉', '▲', '■', '●', '★', '☼', '☁', '⚑', '⚡', '♥', '☾'];
const dbOf = (v) => { const g = faderGain(v); return g <= 0.0001 ? '-inf' : (20 * Math.log10(g)).toFixed(1); };
const volForDb = (db) => 0.8 * Math.cbrt(Math.pow(10, db / 20));

export class MixerView {
  constructor(win, app) {
    this.win = win; this.app = app;
    this.strips = [];
    this.levels = new Float32Array((MAX_INSERT + 1) * 2);
    this.spec = null;
    this.specTrack = -1;

    this.stripsEl = h('div.mx-strips');
    this.detail = h('div.mx-detail');
    this.el = h('div.mixer', this.stripsEl, this.detail);
    win.setTitle('Mixer');

    for (let n = 0; n <= MAX_INSERT; n++) {
      const s = this.buildStrip(n);
      this.strips.push(s);
      this.stripsEl.append(s.el);
      if (n === 0) this.stripsEl.append(h('div.mx-sep'));
    }

    const store = app.store;
    this.off = [
      store.bus.on('project', () => { this.refreshAll(); this.buildDetail(); }),
      store.bus.on('change', ({ paths }) => {
        const touched = paths.filter((p) => p[0] === 'mixer');
        if (!touched.length && !paths.some((p) => p[0] === 'channels')) return;
        const tracks = new Set(); let all = false;
        for (const p of touched) { if (p[1] === 'tracks' && p.length >= 3) tracks.add(p[2]); else all = true; }
        if (all || paths.some((p) => p[0] === 'channels')) this.refreshAll(); else for (const n of tracks) this.refreshStrip(n);
        if (all || tracks.has(store.project.mixer.selected)) this.buildDetail();
      }),
      store.bus.on('param', (addr, v) => this.onParam(addr, v)),
      store.bus.on('mixerSel', () => { this.markSelection(); this.buildDetail(); }),
      app.host.bus.on('spectrum', (m) => { if (m.track === this.specTrack) this.spec = m.mags; }),
      app.host.bus.on('fxmeter', () => {}),
    ];
    this.refreshAll();
    this.buildDetail();
    this.raf = () => { this.tick(); this.rafId = requestAnimationFrame(this.raf); };
    this.rafId = requestAnimationFrame(this.raf);
  }

  get store() { return this.app.store; }
  destroy() { cancelAnimationFrame(this.rafId); for (const o of this.off) o(); this.app.host.watch(null); }
  onShow() { this.watchSelected(); }
  onHide() { this.app.host.watch(null); this.specTrack = -1; }

  // ------------------------------------------------------------------ strips
  buildStrip(n) {
    const app = this.app, store = this.store;
    const label = h('span.mx-label', '');
    const num = h('span.mx-num', n === 0 ? 'M' : String(n));
    const name = h('div.mx-name', { hint: 'Track name — double-click to rename, right-click for options', dataset: { track: n } }, num, label);
    name.addEventListener('dblclick', () => this.rename(n));
    name.addEventListener('contextmenu', (e) => contextMenu(e, this.trackMenu(n)));
    name.addEventListener('dragover', (e) => { const t = e.dataTransfer.types; if (t.includes('application/x-stepwise-fx') || t.includes('application/x-stepwise-mixer')) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } });
    name.addEventListener('drop', (e) => {
      const fx = e.dataTransfer.getData('application/x-stepwise-fx'), mx = e.dataTransfer.getData('application/x-stepwise-mixer');
      if (!fx && !mx) return;
      e.preventDefault(); e.stopPropagation();
      if (fx) { const d = JSON.parse(fx); if (app.cmd.setFxPreset(store, n, -1, d.type, d.params, d.extra) < 0) app.toast('All 10 effect slots on this track are used'); }
      else app.cmd.applyMixerSnapshot(store, n, JSON.parse(mx));
    });
    const icon = h('div.mx-icon', { hint: 'Track icon — click to change', onclick: (e) => this.iconMenu(e, n) });
    const pan = n === 0 ? null : new Knob(app, { addr: `mx:${n}:pan`, size: 'sm', title: `${trackName(store.project, n)} · Pan` });
    const sep = new Knob(app, { addr: `mx:${n}:sep`, size: 'sm', title: `${trackName(store.project, n)} · Stereo separation` });
    const meterL = h('i'), meterR = h('i');
    const meter = h('div.mx-meter', meterL, meterR);
    const thumb = h('div.fader-thumb');
    const fader = h('div.fader', { hint: 'Volume — drag, wheel, double-click resets to 0 dB, Shift/Ctrl for fine control' }, h('div.fader-track'), thumb);
    this.wireFader(fader, n);
    const mute = h('div.btn.sm', { hint: 'Mute — silences this track', onclick: () => app.cmd.toggleTrackFlag(store, n, 'mute') }, 'M');
    const solo = h('div.btn.sm', { hint: 'Solo — click: solo, Ctrl+click: exclusive solo. Keeps the routing chain audible', onclick: (e) => app.cmd.soloTrack(store, n, e.ctrlKey || e.metaKey) }, 'S');
    const dots = h('div.mx-dots', Array.from({ length: FX_SLOTS }, () => h('i')));
    const route = h('div.btn.sm.mx-route', { onclick: (e) => this.routeClick(e, n), oncontextmenu: (e) => this.routeMenu(e, n) }, '→');
    route.addEventListener('contextmenu', (e) => this.routeMenu(e, n));
    const el = h('div.mx-strip', { dataset: { track: n } }, name, icon, pan ? pan.root : h('div', { style: { height: '22px' } }), sep.root, h('div.mx-fbox', meter, fader), h('div.mx-btns', mute, solo), dots, route);
    el.addEventListener('pointerdown', (e) => { if (!e.target.closest('.mx-route')) app.cmd.selectTrack(store, n); });
    return { n, el, name, label, num, icon, meterL, meterR, thumb, fader, mute, solo, dots, route, pan, sep };
  }

  wireFader(fader, n) {
    const store = this.store, addr = `mx:${n}:vol`;
    const H = () => fader.clientHeight - 14;
    fader.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const rect = fader.getBoundingClientRect();
      const start = store.getParam(addr);
      const onThumb = e.target.classList.contains('fader-thumb');
      let base = start, y0 = e.clientY;
      if (!onThumb) { base = clamp(1 - (e.clientY - rect.top - 7) / H(), 0, 1); store.setParam(addr, base); y0 = e.clientY; }
      drag(e, (dx, dy, ev) => {
        const fine = ev.shiftKey || ev.ctrlKey || ev.metaKey ? 0.15 : 1;
        store.setParam(addr, clamp(base - (dy * fine) / H(), 0, 1));
      });
    });
    fader.addEventListener('dblclick', () => store.setParam(addr, 0.8));
    fader.addEventListener('wheel', (e) => { e.preventDefault(); store.setParam(addr, clamp(store.getParam(addr) + (e.deltaY < 0 ? 1 : -1) * (e.shiftKey ? 0.002 : 0.01), 0, 1)); }, { passive: false });
    fader.addEventListener('contextmenu', (e) => contextMenu(e, [
      { label: 'Reset to 0 dB', fn: () => store.setParam(addr, 0.8) },
      { label: 'Set to -6 dB', fn: () => store.setParam(addr, volForDb(-6)) },
      { label: 'Set to -12 dB', fn: () => store.setParam(addr, volForDb(-12)) },
      ...(this.app.paramMenuItems ? [{ sep: true }, ...this.app.paramMenuItems(addr)] : []),
    ]));
  }

  refreshAll() { for (const s of this.strips) this.refreshStrip(s.n); this.markSelection(); }

  refreshStrip(n) {
    const p = this.store.project, t = p.mixer.tracks[n], s = this.strips[n];
    const nm = trackName(p, n);
    s.label.textContent = nm;
    s.name.style.setProperty('--c', t.color || '#555d65');
    s.name.classList.toggle('named', !!t.name);
    s.icon.textContent = t.icon ? (ICONS[+t.icon] || '') : '';
    s.mute.classList.toggle('on', !!t.mute);
    s.solo.classList.toggle('on', !!t.solo);
    s.mute.classList.toggle('mx-mute-on', !!t.mute);
    const used = p.channels.filter((c) => c.mixer === n).length;
    s.el.classList.toggle('empty', n !== 0 && !used && !t.fx.some(Boolean) && !p.mixer.tracks.some((o) => o.routes.some((r) => r[0] === n)));
    s.el.classList.toggle('muted', !!t.mute);
    this.placeThumb(s, t.vol);
    s.fader.dataset.hint = `${nm} volume — ${dbOf(t.vol)} dB. Drag, wheel, double-click resets to 0 dB`;
    t.fx.forEach((f, i) => { s.dots.children[i].className = f ? (f.on ? 'on' : 'byp') : ''; });
    // routing arrow: shows how this strip relates to the selected one
    this.refreshRoute(s, n);
    s.pan && 0;
  }

  refreshRoute(s, n) {
    const p = this.store.project, sel = p.mixer.selected;
    const t = p.mixer.tracks;
    if (n === sel) {
      const toMaster = n === 0 ? true : t[n].routes.some((r) => r[0] === 0);
      s.route.textContent = n === 0 ? '⏏' : '→M';
      s.route.classList.toggle('on', toMaster);
      s.route.dataset.hint = n === 0 ? 'Master output' : 'Route to Master — click toggles. Right-click for more routing';
      s.route.classList.remove('sc');
      return;
    }
    const r = t[sel].routes.find((x) => x[0] === n);
    s.route.textContent = r && r[2] ? '⇢' : '→';
    s.route.classList.toggle('on', !!r);
    s.route.classList.toggle('sc', !!(r && r[2]));
    const cyc = n === 0 ? false : reaches(t, n, sel);
    s.route.classList.toggle('nocycle', cyc || (n === 0 && sel === 0));
    s.route.dataset.hint = r ? `Routed from ${trackName(p, sel)} (${Math.round(r[1] * 100)}%${r[2] ? ', sidechain' : ''}) — click removes, Shift+click toggles sidechain` : `Send ${trackName(p, sel)} to ${trackName(p, n)} — click, or Shift+click for a sidechain send`;
  }

  placeThumb(s, vol) {
    const H = s.fader.clientHeight || 160;
    s.thumb.style.top = `${(1 - vol) * (H - 14)}px`;
  }

  markSelection() {
    const sel = this.store.project.mixer.selected;
    for (const s of this.strips) { s.el.classList.toggle('sel', s.n === sel); this.refreshRoute(s, s.n); }
    this.app.store.bus.emit('mixerSelChanged', sel);
  }

  onParam(addr, v) {
    if (!addr.startsWith('mx:') && !addr.startsWith('master:')) return;
    const m = /^mx:(\d+):vol$/.exec(addr);
    if (m) { const s = this.strips[+m[1]]; this.placeThumb(s, v); s.fader.dataset.hint = `${trackName(this.store.project, +m[1])} volume — ${dbOf(v)} dB`; if (this.app.hint) this.app.hint.update(s.fader); }
    if (addr === 'master:vol') { const s = this.strips[0]; this.placeThumb(s, v); }
  }

  rename(n) {
    const t = this.store.project.mixer.tracks[n];
    promptText('Rename track', 'Track name', t.name || (n === 0 ? 'Master' : '')).then((v) => { if (v !== null) this.app.cmd.setTrackField(this.store, n, 'name', v.slice(0, 24), 'Rename track'); });
  }

  trackMenu(n) {
    const cmd = this.app.cmd, store = this.store;
    return [
      { label: 'Rename…', fn: () => this.rename(n) },
      { label: 'Color…', fn: () => pickColor(innerWidth / 2 - 100, innerHeight / 3, store.project.mixer.tracks[n].color, (c) => cmd.setTrackField(store, n, 'color', c, 'Track color')) },
      { label: 'Clear color', fn: () => cmd.setTrackField(store, n, 'color', null, 'Track color') },
      { sep: true },
      { label: 'Save as mixer preset…', fn: () => this.app.saveMixerPreset(n) },
      { label: 'Reset track (clear effects and routing)', disabled: n === 0, fn: () => cmd.clearTrack(store, n) },
    ];
  }

  iconMenu(e, n) {
    const store = this.store;
    const items = ICONS.map((g, i) => ({ label: g ? `${g}  icon ${i}` : 'No icon', fn: () => this.app.cmd.setTrackField(store, n, 'icon', i ? String(i) : null, 'Track icon') }));
    const r = e.currentTarget.getBoundingClientRect();
    showPopup(items, r.left, r.bottom, r);
  }

  routeClick(e, n) {
    const store = this.store, sel = store.project.mixer.selected;
    e.stopPropagation();
    const src = n === sel ? sel : sel;
    const dest = n === sel ? 0 : n;
    if (n === sel && n === 0) return;
    const ok = this.app.cmd.toggleRoute(store, src, dest, !!e.shiftKey && n !== sel);
    if (!ok) this.app.toast('That route would create a loop');
  }

  routeMenu(e, n) {
    e.preventDefault(); e.stopPropagation();
    const store = this.store, sel = store.project.mixer.selected, p = store.project;
    const r = p.mixer.tracks[sel].routes.find((x) => x[0] === (n === sel ? 0 : n));
    const dest = n === sel ? 0 : n;
    showPopup([
      { title: `${trackName(p, sel)} → ${trackName(p, dest)}` },
      { label: r ? 'Remove route' : 'Add route', disabled: sel === dest, fn: () => this.app.cmd.toggleRoute(store, sel, dest, false) },
      { label: 'Add as sidechain send', disabled: sel === dest || !!r, fn: () => this.app.cmd.toggleRoute(store, sel, dest, true) },
      { label: r && r[2] ? 'Make it a normal send' : 'Make it a sidechain send', disabled: !r, fn: () => this.app.cmd.setRoute(store, sel, dest, undefined, !(r && r[2])) },
      { sep: true },
      { label: 'Level 100%', disabled: !r, fn: () => this.app.cmd.setRoute(store, sel, dest, 1) },
      { label: 'Level 50%', disabled: !r, fn: () => this.app.cmd.setRoute(store, sel, dest, 0.5) },
      { label: 'Level 25%', disabled: !r, fn: () => this.app.cmd.setRoute(store, sel, dest, 0.25) },
    ], e.clientX, e.clientY);
  }

  // ------------------------------------------------------------------ meters
  tick() {
    if (!this.win.open) return;
    const host = this.app.host, lv = this.levels;
    const sc = this.stripsEl;
    const first = Math.max(0, Math.floor(sc.scrollLeft / 66) - 2), last = Math.min(MAX_INSERT + 1, first + Math.ceil(sc.clientWidth / 66) + 4);
    const idx = [0]; for (let i = Math.max(1, first); i < last; i++) idx.push(i);
    for (const n of idx) {
      const [l, r] = host.peak(n);
      lv[n * 2] = Math.max(l, lv[n * 2] * 0.92); lv[n * 2 + 1] = Math.max(r, lv[n * 2 + 1] * 0.92);
      const s = this.strips[n];
      const tl = this.toMeter(lv[n * 2]), tr = this.toMeter(lv[n * 2 + 1]);
      if (s.lastL !== tl) { s.meterL.style.height = `${tl * 100}%`; s.lastL = tl; s.meterL.classList.toggle('hot', lv[n * 2] > 1); }
      if (s.lastR !== tr) { s.meterR.style.height = `${tr * 100}%`; s.lastR = tr; s.meterR.classList.toggle('hot', lv[n * 2 + 1] > 1); }
    }
    this.drawSpectrum();
    this.drawFxMeters();
  }

  toMeter(a) { const db = 20 * Math.log10(a + 1e-6); return clamp((db + 60) / 66, 0, 1); }

  // ------------------------------------------------------------------ detail panel
  watchSelected() {
    const sel = this.store.project.mixer.selected;
    this.specTrack = sel;
    this.spec = null;
    this.app.host.watch(sel, -1);
  }

  // audio input of an armed track: 0 = the browser's default device, then the devices found
  inputSelect(n) {
    const sel = h('select.select', { style: { maxWidth: '110px' }, hint: 'Audio input used when this track is armed and you press Record' }, h('option', { value: 0 }, 'Default input'));
    const cur = this.store.project.mixer.tracks[n].input || 0;
    sel.addEventListener('change', () => this.app.cmd.setTrackField(this.store, n, 'input', +sel.value, 'Track input'));
    if (this.app.audioRec) this.app.audioRec.devices().then((list) => {
      list.forEach((d, i) => sel.append(h('option', { value: i + 1 }, d.label)));
      sel.value = String(cur <= list.length ? cur : 0);
    });
    return sel;
  }

  buildDetail() {
    const app = this.app, store = this.store, p = store.project;
    const n = p.mixer.selected, t = p.mixer.tracks[n];
    clear(this.detail);
    const nm = trackName(p, n);
    this.detail.append(h('div.mx-dhead',
      h('div.mx-dname', { style: { '--c': t.color || '#555d65' }, onclick: () => this.rename(n), hint: 'Selected track — click to rename' }, `${n === 0 ? 'Master' : n + ' · ' + nm}`),
      n === 0 ? null : h('div.btn.sm' + (t.arm ? '.rec.on' : ''), { hint: 'Record arm — arm this track for audio recording. Press Record in the transport to capture the input into the playlist', onclick: () => app.cmd.toggleTrackFlag(store, n, 'arm') }, '●'),
      n === 0 ? null : this.inputSelect(n),
      h('div.btn.sm' + (t.invertPhase ? '.on' : ''), { hint: 'Invert phase of this track', onclick: () => app.cmd.toggleTrackFlag(store, n, 'invertPhase') }, 'Ø'),
      h('div.btn.sm' + (t.swapLR ? '.on' : ''), { hint: 'Swap left and right channels', onclick: () => app.cmd.toggleTrackFlag(store, n, 'swapLR') }, 'L↔R')));

    // linked channels
    const linked = p.channels.filter((c) => c.mixer === n);
    this.detail.append(h('div.mx-linked', { hint: 'Channels routed to this track' }, linked.length ? linked.map((c) => h('span.chip', { style: { '--c': c.color }, onclick: () => { store.select(c.id); } }, c.name)) : h('span.dim', 'No channels use this track')));

    // effect slots
    const slots = h('div.mx-slots');
    for (let i = 0; i < FX_SLOTS; i++) slots.append(this.slotRow(n, i));
    this.detail.append(h('div.mx-title', 'Effects'), slots);

    // EQ + spectrum
    const eqKnobs = h('div.mx-eq');
    for (const [key, title] of [['Low', 'LOW'], ['Mid', 'MID'], ['High', 'HIGH']]) {
      const col = h('div.mx-eqband', h('div.knob-label', title));
      col.append(new Knob(app, { addr: `mx:${n}:eq${key}G`, size: 'sm', title: `EQ ${key} level` }).el);
      col.append(new Knob(app, { addr: `mx:${n}:eq${key}F`, size: 'sm', title: `EQ ${key} frequency` }).el);
      if (key === 'Mid') col.append(new Knob(app, { addr: `mx:${n}:eqMidQ`, size: 'sm', title: 'EQ mid width' }).el);
      eqKnobs.append(col);
    }
    this.spCanvas = h('canvas.mx-spectrum', { width: 480, height: 150, hint: 'Spectrum of this track output with the track EQ curve' });
    this.detail.append(h('div.mx-title', 'EQ'), this.spCanvas, eqKnobs);
    this.sctx = this.spCanvas.getContext('2d');

    // routing
    const routes = h('div.mx-routes');
    if (n === 0) routes.append(h('span.dim', 'Master output goes to the audio device'));
    for (const r of t.routes) {
      const level = new Knob(app, { def: { id: 'lv', name: 'Send level', min: 0, max: 2, def: 1, unit: '', curve: 'lin' }, value: r[1], size: 'sm', title: 'Send level', onChange: (v) => app.cmd.setRoute(store, n, r[0], v) });
      routes.append(h('div.mx-route-row',
        h('span', { class: r[2] ? 'sc' : '' }, `${r[2] ? '⇢ sidechain to' : '→'} ${trackName(p, r[0])}`), level.el,
        h('span.dim', { style: { width: '34px', textAlign: 'right' } }, `${Math.round(r[1] * 100)}%`),
        h('div.btn.sm', { hint: 'Toggle sidechain delivery', onclick: () => app.cmd.setRoute(store, n, r[0], undefined, !r[2]) }, 'SC'),
        h('div.btn.sm', { hint: 'Remove route', onclick: () => app.cmd.toggleRoute(store, n, r[0]) }, '✕')));
    }
    const incoming = p.mixer.tracks.map((tt, i) => [tt, i]).filter(([tt]) => tt.routes.some((r) => r[0] === n)).map(([, i]) => trackName(p, i));
    if (incoming.length) routes.append(h('div.dim', { style: { marginTop: '4px' } }, `Inputs from: ${incoming.join(', ')}`));
    const addRoute = h('div.btn.sm', { hint: 'Add an output route to another track', onclick: (e) => {
      const items = [];
      for (let d = 0; d <= MAX_INSERT; d++) {
        if (d === n || t.routes.some((r) => r[0] === d) || (n !== 0 && d !== 0 && reaches(p.mixer.tracks, d, n))) continue;
        if (n === 0) continue;
        items.push({ label: trackName(p, d), fn: () => app.cmd.toggleRoute(store, n, d) });
      }
      const r = e.currentTarget.getBoundingClientRect();
      showPopup(items.length ? items.slice(0, 60) : [{ label: 'No free destinations', disabled: true }], r.left, r.bottom, r);
    } }, '＋ Route');
    this.detail.append(h('div.mx-title', 'Routing'), routes, n === 0 ? null : addRoute);

    // delay
    this.detail.append(h('div.mx-title', 'Track'),
      h('div.row', { style: { padding: '2px 8px 10px', gap: '14px' } },
        h('div.knob-wrap', new Knob(app, { addr: `mx:${n}:vol`, size: 'sm', title: 'Volume' }).el, h('div.knob-label', 'VOL')),
        n === 0 ? null : h('div.knob-wrap', new Knob(app, { addr: `mx:${n}:pan`, size: 'sm', title: 'Pan' }).el, h('div.knob-label', 'PAN')),
        h('div.knob-wrap', new Knob(app, { addr: `mx:${n}:sep`, size: 'sm', title: 'Stereo separation' }).el, h('div.knob-label', 'SEP')),
        h('div.knob-wrap', new Knob(app, { addr: `mx:${n}:delay`, size: 'sm', title: 'Track delay (ms)' }).el, h('div.knob-label', 'DELAY'))));
    this.watchSelected();
    this.markSelection();
  }

  slotRow(n, i) {
    const app = this.app, store = this.store;
    const slot = store.project.mixer.tracks[n].fx[i];
    const led = h('div.led', { class: slot && slot.on ? 'on' : '', hint: 'Enable / bypass this effect', onclick: (e) => { e.stopPropagation(); if (slot) store.setParam(`mx:${n}:fx:${i}:on`, slot.on ? 0 : 1); } });
    const meta = slot ? EFFECTS[slot.type].meta : null;
    const nameEl = h('div.mx-slotname', { class: slot ? '' : 'empty', dataset: { slot: i }, hint: slot ? `${meta.name} — click to open, right-click for options, drag to reorder` : 'Empty slot — click to choose an effect' }, slot ? meta.name : '(empty)');
    const mix = slot ? new Knob(app, { addr: `mx:${n}:fx:${i}:mix`, size: 'sm', title: 'Dry / wet mix' }).el : h('div', { style: { width: '22px' } });
    const row = h('div.mx-slot', { dataset: { slot: i } }, led, nameEl, mix);
    nameEl.addEventListener('click', (e) => { if (row._dragged) return; if (slot) app.openFxEditor(n, i); else this.pickEffect(e, n, i); });
    row.addEventListener('contextmenu', (e) => contextMenu(e, this.slotMenu(n, i)));
    // an effect preset dragged from the Browser lands in this slot
    row.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('application/x-stepwise-fx')) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; row.classList.add('drop'); } });
    row.addEventListener('dragleave', () => row.classList.remove('drop'));
    row.addEventListener('drop', (e) => {
      row.classList.remove('drop');
      const v = e.dataTransfer.getData('application/x-stepwise-fx');
      if (!v) return;
      e.preventDefault(); e.stopPropagation();
      const d = JSON.parse(v);
      app.cmd.setFxPreset(store, n, i, d.type, d.params, d.extra);
    });
    // reorder by dragging the name
    nameEl.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || !slot) return;
      row._dragged = false;
      let target = -1;
      drag(e, (dx, dy, ev) => {
        if (Math.abs(dy) < 4 && !row._dragged) return;
        row._dragged = true;
        const el = document.elementFromPoint(ev.clientX, ev.clientY);
        const r = el && el.closest ? el.closest('.mx-slot') : null;
        for (const c of this.detail.querySelectorAll('.mx-slot')) c.classList.remove('drop');
        if (r) { r.classList.add('drop'); target = +r.dataset.slot; } else target = -1;
      }, () => {
        for (const c of this.detail.querySelectorAll('.mx-slot')) c.classList.remove('drop');
        if (row._dragged && target >= 0 && target !== i) app.cmd.moveFx(store, n, i, target);
        setTimeout(() => { row._dragged = false; }, 0);
      }, { keepCursor: false });
    });
    return row;
  }

  pickEffect(e, n, i) {
    const cats = {};
    for (const [id, m] of Object.entries(EFFECTS)) (cats[m.meta.category] = cats[m.meta.category] || []).push([id, m.meta]);
    const items = [];
    for (const [cat, list] of Object.entries(cats)) {
      items.push({ title: cat });
      for (const [id, meta] of list) items.push({ label: meta.name, fn: () => { this.app.cmd.setFx(this.store, n, i, id); } });
    }
    const r = e.currentTarget.getBoundingClientRect();
    showPopup(items, r.left, r.bottom, r);
  }

  slotMenu(n, i) {
    const app = this.app, store = this.store;
    const slot = store.project.mixer.tracks[n].fx[i];
    const items = [];
    const pick = (e) => this.pickEffect({ currentTarget: this.detail.querySelectorAll('.mx-slot')[i] }, n, i);
    if (slot) {
      items.push({ label: 'Open editor', fn: () => app.openFxEditor(n, i) },
        { label: slot.on ? 'Bypass' : 'Enable', fn: () => store.setParam(`mx:${n}:fx:${i}:on`, slot.on ? 0 : 1) },
        { label: 'Replace effect', fn: pick }, { label: 'Delete', fn: () => app.cmd.setFx(store, n, i, null) },
        { sep: true },
        { label: 'Move up', disabled: i === 0, fn: () => app.cmd.swapFx(store, n, i, i - 1) },
        { label: 'Move down', disabled: i === FX_SLOTS - 1, fn: () => app.cmd.swapFx(store, n, i, i + 1) },
        { label: 'Duplicate to next free slot', fn: () => { const free = store.project.mixer.tracks[n].fx.findIndex((s) => !s); if (free >= 0) app.cmd.copyFx(store, n, i, n, free); } },
        { sep: true },
        ...(app.fxPresetItems ? app.fxPresetItems(n, i) : []));
    } else items.push({ label: 'Choose effect…', fn: pick });
    return items;
  }

  // ------------------------------------------------------------------ spectrum + EQ curve
  drawSpectrum() {
    const c = this.sctx;
    if (!c || !this.spCanvas.isConnected) return;
    const W = this.spCanvas.width, H = this.spCanvas.height;
    c.fillStyle = '#0e1012'; c.fillRect(0, 0, W, H);
    const fx = (f) => (Math.log(f / 20) / Math.log(1000)) * W;
    c.strokeStyle = '#1e2327'; c.lineWidth = 1; c.fillStyle = '#5b666e'; c.font = '9px sans-serif';
    for (const f of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) {
      const x = fx(f); c.beginPath(); c.moveTo(x, 0); c.lineTo(x, H); c.stroke();
      c.fillText(f >= 1000 ? `${f / 1000}k` : String(f), x + 2, H - 3);
    }
    for (const d of [-20, -40, -60, -80]) { const y = (-d / 90) * H; c.beginPath(); c.moveTo(0, y); c.lineTo(W, y); c.stroke(); }
    if (this.spec) {
      const sr = this.app.host.sampleRate, N = 2048, mags = this.spec;
      c.beginPath(); c.moveTo(0, H);
      for (let x = 0; x < W; x += 2) {
        const f = 20 * Math.pow(1000, x / W), kf = Math.min(1022, (f / (sr / 2)) * 1024), k = Math.floor(kf);
        const y = clamp((-(mags[k] + (mags[k + 1] - mags[k]) * (kf - k)) / 90) * H, 0, H);
        c.lineTo(x, y);
      }
      c.lineTo(W, H); c.closePath();
      const g = c.createLinearGradient(0, 0, 0, H); g.addColorStop(0, 'rgba(255,176,46,.55)'); g.addColorStop(1, 'rgba(255,176,46,.05)');
      c.fillStyle = g; c.fill();
      void N;
    }
    // track EQ curve
    const t = this.store.project.mixer.tracks[this.store.project.mixer.selected];
    if (Math.abs(t.eqLowG) + Math.abs(t.eqMidG) + Math.abs(t.eqHighG) > 0.01) {
      c.strokeStyle = '#4aa8e0'; c.lineWidth = 1.5; c.beginPath();
      for (let x = 0; x < W; x += 3) {
        const f = 20 * Math.pow(1000, x / W);
        const g = this.eqGain(t, f);
        const y = H / 2 - (g / 24) * (H / 2) * 1.0;
        if (x === 0) c.moveTo(x, y); else c.lineTo(x, y);
      }
      c.stroke();
    }
  }

  eqGain(t, f) {
    // analytic approximation of the three track EQ bands (shelf / bell / shelf) for display
    const sh = (g, fc, hi) => { const r = Math.log2(f / fc); const s = 1 / (1 + Math.exp((hi ? -r : r) * 2.2)); return g * s; };
    const bell = (g, fc, q) => g * Math.exp(-Math.pow(Math.log2(f / fc) * q * 1.6, 2));
    return sh(t.eqLowG, t.eqLowF, false) + bell(t.eqMidG, t.eqMidF, t.eqMidQ) + sh(t.eqHighG, t.eqHighF, true);
  }

  drawFxMeters() {}
}

export function createMixer(win, app) { return new MixerView(win, app); }
