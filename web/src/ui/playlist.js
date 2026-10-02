// Playlist: arrange pattern, audio and automation clips on up to 500 tracks.
import { h, drag, clamp, clear } from './h.js';
import { contextMenu, showPopup } from './menu.js';
import { promptText, pickColor } from './dialog.js';
import { formDialog } from './forms.js';
import { icon } from './icons.js';
import { PPQ, STEP } from '../core/constants.js';
import { patternLength, barTicks, COLORS } from '../core/project.js';
import { TimeMap } from '../core/timemap.js';
import { MAX_TRACK, defaultClipLength, spanOf, trimLeft } from '../core/playlist-ops.js';
import { renderCurve } from '../core/automation.js';

const NAMES_W = 132, MARK_H = 16, RULER_H = 22, TOP = MARK_H + RULER_H, EDGE = 6, HEAD_H = 14;

const TOOLS = [
  ['draw', 'P', 'Draw — click to place the selected pattern / clip, drag to move, drag an edge to resize, right-click deletes', 'pencil'],
  ['paint', 'B', 'Paint — drag to place clips back to back', 'brush'],
  ['delete', 'D', 'Delete — click or drag over clips to remove them', 'trash'],
  ['mute', 'T', 'Mute — click or drag to mute / unmute clips', 'mute'],
  ['slice', 'C', 'Slice — drag a line across clips to cut them', 'slice'],
  ['select', 'E', 'Select — drag a rectangle to select clips (Shift adds)', 'select'],
  ['zoom', 'Z', 'Zoom — drag a rectangle to zoom in, right-click to zoom out', 'zoom'],
  ['playback', 'Y', 'Playback — hold the mouse to play from that point', 'play'],
];
const QUANT = [[0, 'Immediate'], [PPQ, '1 beat'], [PPQ * 4, '1 bar'], [PPQ * 8, '2 bars'], [PPQ * 16, '4 bars']];
const STORE_KEY = 'stepwise.playlist';
const prefsLoad = () => { try { return JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch (_) { return {}; } };
const prefsSave = (o) => { try { localStorage.setItem(STORE_KEY, JSON.stringify(o)); } catch (_) { /* private mode */ } };

export class Playlist {
  constructor(win, app) {
    this.win = win; this.app = app;
    const pr = prefsLoad();
    this.tool = 'draw';
    this.sel = new Set();
    this.view = { px: pr.px || 0.12, rowH: pr.rowH || 44, x0: 0, y0: 0 };
    this.source = { type: 'pattern', ref: null };
    this.perf = false;
    this.quant = pr.quant ?? PPQ * 4;
    this.perfEntries = [];
    this.gesture = 0;
    this.dirty = true;
    this.cursorT = 0;
    this.sideOpen = pr.side !== false;
    this.cache = new Map();
    this.build();
    this.bind();
    this.ro = new ResizeObserver(() => this.layout());     // header wrapping or window resizes change the canvas area
    this.ro.observe(this.centerWrap);
  }

  get store() { return this.app.store; }
  get project() { return this.store.project; }
  get arr() { return this.store.arrangement; }
  get tm() { return new TimeMap(this.project.timeSig, this.arr.markers); }
  get barT() { return barTicks(this.project.timeSig); }
  get beatT() { return Math.round((PPQ * 4) / this.project.timeSig.den); }
  get selClips() { return this.arr.clips.filter((c) => this.sel.has(c.id)); }

  // ------------------------------------------------------------------ layout
  build() {
    this.toolBtns = {};
    const tools = h('div.seg');
    for (const [id, key, hint, ic] of TOOLS) {
      const b = h('div.btn', { dataset: { tool: id }, hint: `${hint} (${key})`, onclick: () => this.setTool(id) }, icon(ic, 14));
      this.toolBtns[id] = b; tools.append(b);
    }
    this.info = h('span.dim', '');
    this.tabs = h('div.pl-tabs');
    this.perfBtn = h('div.btn.sm', { hint: 'Performance mode — click a clip to launch it live, it loops until you stop it or launch another clip on its track', onclick: () => this.setPerf(!this.perf) }, 'Perf');
    this.quantSel = h('select.select', { hint: 'Launch quantize — where a launched clip starts', onchange: () => { this.quant = +this.quantSel.value; this.prefs(); } }, QUANT.map(([v, l]) => h('option', { value: v }, l)));
    this.quantSel.value = String(this.quant);
    this.stopAllBtn = h('div.btn.sm', { hint: 'Stop all launched clips at the next boundary', onclick: () => this.app.transport.perfStopAll(this.quant) }, 'Stop all');
    this.sideBtn = h('div.btn.sm', { hint: 'Show / hide the clip source list', onclick: () => { this.sideOpen = !this.sideOpen; this.prefs(); this.refreshBtns(); this.layout(); } }, 'Sources');
    this.zoomX = h('input', { type: 'range', min: 0, max: 100, style: { width: '70px', accentColor: 'var(--accent)' }, hint: 'Horizontal zoom (Ctrl + wheel)' });
    this.zoomY = h('input', { type: 'range', min: 0, max: 100, style: { width: '56px', accentColor: 'var(--accent)' }, hint: 'Track height (Alt + wheel)' });
    this.zoomX.addEventListener('input', () => this.setZoomX(0.01 * Math.pow(2 / 0.01, +this.zoomX.value / 100)));
    this.zoomY.addEventListener('input', () => this.setRowH(20 + (+this.zoomY.value / 100) * 90));
    this.head = h('div.rack-head.pl-head', tools, this.info, h('div.pr-sep'), this.tabs, h('div.grow'),
      this.perfBtn, h('span.dim', 'Launch'), this.quantSel, this.stopAllBtn, h('div.pr-sep'), this.sideBtn, h('span.dim', '⇔'), this.zoomX, h('span.dim', '⇕'), this.zoomY);

    this.side = h('div.pl-side');
    this.names = h('canvas.pl-names');
    this.ruler = h('canvas.pl-ruler', { hint: 'Click to set the song position. Right-click for markers, loop, start and punch. Shift-drag sets the loop region' });
    this.grid = h('canvas.pl-grid');
    this.playhead = h('div.pl-playhead');
    this.hscroll = h('input.pl-hscroll', { type: 'range', min: 0, max: 1000, value: 0 });
    this.centerWrap = h('div.pl-center', this.ruler, this.grid, this.playhead);
    this.namesWrap = h('div.pl-nameswrap', this.names);
    this.main = h('div.pl-main', this.side, this.namesWrap, this.centerWrap);
    this.el = h('div.rack.pl', this.head, this.main);
    this.refreshBtns();
  }

  prefs() { prefsSave({ px: this.view.px, rowH: this.view.rowH, quant: this.quant, side: this.sideOpen }); }

  refreshBtns() {
    for (const [id, b] of Object.entries(this.toolBtns)) b.classList.toggle('on', id === this.tool);
    this.perfBtn.classList.toggle('on', this.perf);
    this.sideBtn.classList.toggle('on', this.sideOpen);
    this.side.style.display = this.sideOpen ? '' : 'none';
    this.quantSel.style.display = this.perf ? '' : 'none';
    this.stopAllBtn.style.display = this.perf ? '' : 'none';
  }

  buildTabs() {
    clear(this.tabs);
    const p = this.project;
    for (const a of p.playlist.arrangements) {
      const t = h('div.btn.sm' + (a.id === p.playlist.current ? '.on' : ''), { dataset: { arr: a.id }, hint: `${a.name} — click to switch arrangement, right-click for more`, onclick: () => this.app.cmd.selectArrangement(this.store, a.id) }, a.name);
      t.addEventListener('contextmenu', (e) => contextMenu(e, [
        { label: 'Rename…', fn: async () => { const n = await promptText('Rename arrangement', 'Name', a.name); if (n) this.app.cmd.renameArrangement(this.store, a.id, n); } },
        { label: 'Duplicate', fn: () => this.app.cmd.cloneArrangement(this.store, a.id) },
        { label: 'Delete', disabled: p.playlist.arrangements.length < 2, fn: () => this.app.cmd.deleteArrangement(this.store, a.id) },
      ]));
      this.tabs.append(t);
    }
    this.tabs.append(h('div.btn.sm', { hint: 'New arrangement — a separate set of clips, markers and loop for the same patterns', onclick: () => this.app.cmd.addArrangement(this.store) }, '+'));
  }

  buildSide() {
    clear(this.side);
    const p = this.project, app = this.app;
    if (this.source.type === 'pattern' && (this.source.ref == null || !p.patterns[this.source.ref])) this.source.ref = p.currentPattern;
    const item = (type, ref, label, color) => {
      const on = this.source.type === type && this.source.ref === ref;
      const el = h('div.pl-src' + (on ? '.on' : ''), { draggable: 'true', dataset: { type, ref }, hint: `${label} — click to use it with the Draw tool, or drag it into the playlist` },
        h('i', { style: { background: color || '#8e989f' } }), h('span', label));
      el.addEventListener('click', () => { this.source = { type, ref }; if (type === 'pattern') app.cmd.selectPattern(this.store, ref); this.buildSide(); });
      el.addEventListener('dragstart', (e) => { e.dataTransfer.setData('application/x-stepwise-clip', JSON.stringify({ type, ref })); e.dataTransfer.effectAllowed = 'copy'; });
      if (type === 'pattern') el.addEventListener('dblclick', () => app.openWindow('pianoroll'));
      return el;
    };
    const ids = Object.keys(p.patterns).map(Number).sort((a, b) => a - b);
    this.side.append(h('div.mx-title', 'Patterns'));
    for (const id of ids) this.side.append(item('pattern', id, `${String(id).padStart(2, '0')} ${p.patterns[id].name}`, p.patterns[id].color || COLORS[(id - 1) % COLORS.length]));
    this.side.append(h('div.row', { style: { padding: '4px 8px' } }, h('div.btn.sm', { hint: 'Create a new empty pattern', onclick: () => app.cmd.newPattern(this.store) }, '＋ Pattern')));
    const audio = p.channels.filter((c) => c.type === 'audio'), autos = p.channels.filter((c) => c.type === 'automation');
    this.side.append(h('div.mx-title', 'Audio clips'));
    for (const c of audio) this.side.append(item('audio', c.id, c.name, c.color));
    this.side.append(h('div.row', { style: { padding: '4px 8px' } }, h('div.btn.sm', { hint: 'Load an audio file as a clip source (or drop files onto the playlist)', onclick: () => app.addAudioClipChannel && app.addAudioClipChannel() }, '＋ Audio…')));
    this.side.append(h('div.mx-title', 'Automation clips'));
    for (const c of autos) this.side.append(item('automation', c.id, c.name, c.color));
    this.side.append(h('div.row', { style: { padding: '4px 8px' } }, h('div.btn.sm', { hint: 'Create an automation clip. Right-click any knob → Create automation clip also works', onclick: () => app.addAutomationChannel && app.addAutomationChannel() }, '＋ Automation')));
  }

  layout() {
    const W = this.centerWrap.clientWidth, H = this.centerWrap.clientHeight;
    if (!W || !H) return;
    const dpr = window.devicePixelRatio || 1;
    this.dpr = dpr; this.W = W; this.gridH = Math.max(40, H - TOP);
    const set = (cv, w, hh, top) => { cv.style.width = `${w}px`; cv.style.height = `${hh}px`; cv.style.top = `${top}px`; cv.width = Math.round(w * dpr); cv.height = Math.round(hh * dpr); };
    set(this.ruler, W, TOP, 0);
    set(this.grid, W, this.gridH, TOP);
    this.names.style.width = `${NAMES_W}px`; this.names.style.height = `${this.gridH}px`; this.names.style.top = `${TOP}px`;
    this.names.width = Math.round(NAMES_W * dpr); this.names.height = Math.round(this.gridH * dpr);
    this.clampView();
    this.invalidate();
  }

  onResize() { this.layout(); }
  onShow() { this.buildTabs(); this.buildSide(); this.layout(); this.startLoop(); }
  onHide() { this.stopLoop(); }
  destroy() { this.stopLoop(); if (this.ro) this.ro.disconnect(); for (const off of this.subs || []) off(); }

  // ------------------------------------------------------------------ view
  tx(t) { return (t - this.view.x0) * this.view.px; }
  xt(x) { return x / this.view.px + this.view.x0; }
  ty(track) { return (track - 1) * this.view.rowH - this.view.y0; }
  trackAt(y) { return Math.floor((y + this.view.y0) / this.view.rowH) + 1; }

  contentEnd() { let e = 0; for (const c of this.arr.clips) e = Math.max(e, c.s + c.l); return Math.max(e, this.barT * 16) + this.barT * 8; }

  clampView() {
    const v = this.view;
    v.px = clamp(v.px, 0.01, 2); v.rowH = clamp(v.rowH, 20, 110);
    v.y0 = clamp(v.y0, 0, Math.max(0, MAX_TRACK * v.rowH - (this.gridH || 300)));
    v.x0 = clamp(v.x0, 0, Math.max(0, this.contentEnd()));
  }

  setZoomX(px, ax = (this.W || 600) / 2) {
    const t = this.xt(ax);
    this.view.px = clamp(px, 0.01, 2);
    this.view.x0 = Math.max(0, t - ax / this.view.px);
    this.zoomX.value = String((Math.log(this.view.px / 0.01) / Math.log(200)) * 100);
    this.prefs(); this.clampView(); this.invalidate();
  }

  setRowH(rh, ay = (this.gridH || 300) / 2) {
    const k = (ay + this.view.y0) / this.view.rowH;
    this.view.rowH = clamp(rh, 20, 110);
    this.view.y0 = k * this.view.rowH - ay;
    this.zoomY.value = String(((this.view.rowH - 20) / 90) * 100);
    this.prefs(); this.clampView(); this.invalidate();
  }

  snapTicks() { return this.app.snapTicks({ cell: this.barT, line: this.lineTicks() }); }

  lineTicks() {
    const cands = [this.barT * 8, this.barT * 4, this.barT * 2, this.barT, this.beatT, this.beatT / 2, STEP].map(Math.round);
    let best = cands[0];
    for (const c of cands) if (c * this.view.px >= 12) best = c;
    return best;
  }

  snapT(t, ev) { if (ev && ev.altKey) return Math.round(t); const g = this.snapTicks(); return Math.round(t / g) * g; }
  floorT(t, ev) { if (ev && ev.altKey) return Math.floor(t); const g = this.snapTicks(); return Math.floor(t / g) * g; }

  setTool(id) { this.tool = id; this.refreshBtns(); this.invalidate(); }

  setPerf(on) {
    this.perf = on;
    if (!on) this.app.transport.perfStopAll(0);
    this.refreshBtns(); this.invalidate();
  }

  // ------------------------------------------------------------------ colours / names
  clipSource(c) {
    const p = this.project;
    if (c.type === 'pattern') { const pat = p.patterns[c.ref]; return pat ? { name: pat.name, color: pat.color || COLORS[(pat.id - 1) % COLORS.length] } : { name: '?', color: '#555' }; }
    const ch = this.store.channel(c.ref);
    return ch ? { name: ch.name, color: ch.color || '#8e989f' } : { name: '?', color: '#555' };
  }

  // ------------------------------------------------------------------ drawing
  invalidate() { this.dirty = true; }
  startLoop() { if (this.raf) return; const loop = () => { this.raf = requestAnimationFrame(loop); this.frame(); }; this.raf = requestAnimationFrame(loop); }
  stopLoop() { if (this.raf) cancelAnimationFrame(this.raf); this.raf = 0; }

  frame() {
    const st = this.app.host.st;
    const live = st.playing && (this.app.transport.mode === 'song' || st.mode === 'perf');
    if (live) {
      const tick = this.app.transport.displayTick();
      const x = this.tx(tick);
      this.playhead.style.display = x >= 0 && x < this.W ? '' : 'none';
      this.playhead.style.transform = `translateX(${Math.round(x)}px)`;
      this.playhead.style.height = `${TOP + this.gridH}px`;
      if (this.perf) this.dirty = true;        // queued clips blink
    } else this.playhead.style.display = 'none';
    if (!this.dirty) return;
    this.dirty = false;
    this.draw();
  }

  draw() {
    if (!this.W) return;
    this.tmCache = this.tm;
    this.drawGrid(); this.drawNames(); this.drawRuler();
  }

  eachBar(t0, t1, cb) {
    const tm = this.tmCache;
    for (let i = 0; i < tm.segs.length; i++) {
      const s = tm.segs[i], end = i + 1 < tm.segs.length ? tm.segs[i + 1].t : Infinity;
      if (end <= t0) continue;
      if (s.t > t1) break;
      for (let k = Math.max(0, Math.floor((t0 - s.t) / s.barLen)); ; k++) {
        const t = s.t + k * s.barLen;
        if (t >= end || t > t1) break;
        cb(t, s.barOffset + k + 1, s);
      }
    }
  }

  drawGrid() {
    const ctx = this.grid.getContext('2d'), W = this.W, H = this.gridH, v = this.view, dpr = this.dpr, arr = this.arr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#25282b'; ctx.fillRect(0, 0, W, H);
    const t0 = this.xt(0), t1 = this.xt(W);
    const tr0 = Math.max(1, this.trackAt(0)), tr1 = Math.min(MAX_TRACK, this.trackAt(H));
    for (let t = tr0; t <= tr1; t++) {
      const y = this.ty(t), ov = arr.tracks[t] || {};
      ctx.fillStyle = ov.mute ? '#1f2124' : t % 2 ? '#2c3034' : '#2a2d31'; ctx.fillRect(0, y, W, v.rowH);
      ctx.fillStyle = 'rgba(0,0,0,.35)'; ctx.fillRect(0, y + v.rowH - 1, W, 1);
    }
    // vertical lines
    const sub = this.lineTicks();
    if (sub * v.px >= 5) {
      ctx.fillStyle = 'rgba(255,255,255,.035)';
      for (let t = Math.ceil(Math.max(0, t0) / sub) * sub; t <= t1; t += sub) ctx.fillRect(Math.round(this.tx(t)), 0, 1, H);
    }
    const tm = this.tmCache;
    if (tm.beatLenAt(0) * v.px >= 6) {
      ctx.fillStyle = 'rgba(255,255,255,.07)';
      for (let t = Math.ceil(Math.max(0, t0) / this.beatT) * this.beatT; t <= t1; t += this.beatT) ctx.fillRect(Math.round(this.tx(t)), 0, 1, H);
    }
    ctx.fillStyle = 'rgba(255,255,255,.2)';
    this.eachBar(Math.max(0, t0), t1, (t) => ctx.fillRect(Math.round(this.tx(t)), 0, 1, H));
    // loop region
    if (arr.loop) {
      ctx.fillStyle = 'rgba(255,176,46,.06)'; ctx.fillRect(this.tx(arr.loop.s), 0, (arr.loop.e - arr.loop.s) * v.px, H);
    }
    // clips
    ctx.font = '10px "Segoe UI", system-ui, sans-serif'; ctx.textBaseline = 'middle';
    const tick = this.app.host.st.tick;
    for (const c of arr.clips) {
      if (c.track < tr0 || c.track > tr1) continue;
      const x = this.tx(c.s), w = c.l * v.px;
      if (x + w < 0 || x > W) continue;
      this.drawClip(ctx, c, x, this.ty(c.track), Math.max(2, w), v.rowH, tick);
    }
    // overlays
    const o = this.overlay;
    if (o) {
      if (o.type === 'rect') {
        const x = Math.min(o.x0, o.x1), y = Math.min(o.y0, o.y1), w = Math.abs(o.x1 - o.x0), hh = Math.abs(o.y1 - o.y0);
        ctx.fillStyle = 'rgba(255,176,46,.14)'; ctx.fillRect(x, y, w, hh); ctx.strokeStyle = 'rgba(255,176,46,.9)'; ctx.lineWidth = 1; ctx.strokeRect(x + 0.5, y + 0.5, w, hh);
      } else if (o.type === 'line') {
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.setLineDash([4, 3]); ctx.beginPath(); ctx.moveTo(o.x0, o.y0); ctx.lineTo(o.x1, o.y1); ctx.stroke(); ctx.setLineDash([]);
      }
    }
    const hv = this.hover;
    if (hv && !this.dragging && (this.tool === 'draw' || this.tool === 'paint') && !hv.hit && !this.perf) {
      const len = this.sourceLength();
      ctx.strokeStyle = 'rgba(255,255,255,.55)'; ctx.lineWidth = 1;
      ctx.strokeRect(this.tx(hv.t) + 0.5, this.ty(hv.track) + 1.5, Math.max(3, len * v.px) - 1, v.rowH - 3);
    }
  }

  drawClip(ctx, c, x, y, w, hgt, tick) {
    const src = this.clipSource(c), sel = this.sel.has(c.id);
    const base = c.color || src.color;
    const entry = this.perfEntries.find((e) => e.clipId === c.id);
    const playing = entry && entry.start <= tick && (entry.stop == null || tick < entry.stop);
    const queued = entry && entry.start > tick;
    ctx.save();
    ctx.beginPath(); ctx.rect(x, y + 1, w - 1, hgt - 2); ctx.clip();
    ctx.globalAlpha = c.mute ? 0.4 : 0.92;
    ctx.fillStyle = c.mute ? '#6b7279' : base; ctx.fillRect(x, y + 1, w - 1, hgt - 2);
    ctx.globalAlpha = 1;
    // header
    ctx.fillStyle = 'rgba(0,0,0,.32)'; ctx.fillRect(x, y + 1, w - 1, HEAD_H);
    // body content
    const body = { x, y: y + 1 + HEAD_H, w: w - 1, h: hgt - 2 - HEAD_H };
    if (body.h > 6) {
      ctx.fillStyle = 'rgba(0,0,0,.18)'; ctx.fillRect(body.x, body.y, body.w, body.h);
      if (c.type === 'pattern') this.drawPatternBody(ctx, c, body);
      else if (c.type === 'audio') this.drawAudioBody(ctx, c, body);
      else this.drawAutomationBody(ctx, c, body);
    }
    // pattern cycle ticks in the header
    if (c.type === 'pattern') {
      const pat = this.project.patterns[c.ref];
      if (pat) {
        const plen = patternLength(this.project, pat);
        ctx.fillStyle = 'rgba(255,255,255,.28)';
        for (let t = Math.ceil(c.o / plen) * plen - c.o; t < c.l; t += plen) if (t > 0) ctx.fillRect(Math.round(x + t * this.view.px), y + 1, 1, HEAD_H);
      }
    }
    ctx.fillStyle = 'rgba(255,255,255,.92)';
    const label = (c.name || src.name) + (c.rev ? ' ◂' : '');
    if (w > 22) ctx.fillText(label, x + 5, y + 1 + HEAD_H / 2 + 0.5);
    if (w > 46 && !this.perf) { ctx.fillStyle = 'rgba(255,255,255,.55)'; ctx.fillText('▾', x + w - 14, y + 1 + HEAD_H / 2 + 0.5); }
    if (c.fi || c.fo) { // fade ramps (fi / fo are lengths in ticks)
      ctx.strokeStyle = 'rgba(255,255,255,.85)'; ctx.lineWidth = 1; ctx.beginPath();
      if (c.fi) { const fw = Math.min(w, c.fi * this.view.px); ctx.moveTo(x, y + hgt - 2); ctx.lineTo(x + fw, y + 1 + HEAD_H); }
      if (c.fo) { const fw = Math.min(w, c.fo * this.view.px); ctx.moveTo(x + w - fw, y + 1 + HEAD_H); ctx.lineTo(x + w - 1, y + hgt - 2); }
      ctx.stroke();
    }
    ctx.restore();
    if (c.mute) { ctx.fillStyle = 'rgba(0,0,0,.22)'; ctx.fillRect(x, y + 1, w - 1, hgt - 2); }
    if (sel) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.strokeRect(x + 0.5, y + 1.5, w - 2, hgt - 3); }
    else { ctx.strokeStyle = 'rgba(0,0,0,.55)'; ctx.lineWidth = 1; ctx.strokeRect(x + 0.5, y + 1.5, w - 2, hgt - 3); }
    if (playing) { ctx.strokeStyle = '#7fdc5c'; ctx.lineWidth = 2; ctx.strokeRect(x + 1, y + 2, w - 3, hgt - 4); }
    if (queued && Math.floor(performance.now() / 250) % 2) { ctx.strokeStyle = '#ffb02e'; ctx.lineWidth = 2; ctx.strokeRect(x + 1, y + 2, w - 3, hgt - 4); }
  }

  patternPreview(pat) {
    const ids = Object.keys(pat.notes);
    let n = 0, sig = 0;
    for (const k of ids) { const l = pat.notes[k]; n += l.length; if (l.length) sig += l[l.length - 1].id + l[0].s + l[l.length - 1].k; }
    const key = `${pat.id}:${n}:${sig}:${pat.len || 0}`;
    const hit = this.cache.get(pat.id);
    if (hit && hit.key === key) return hit;
    let kmin = 127, kmax = 0; const list = [];
    for (const k of ids) for (const nt of pat.notes[k]) { list.push(nt); if (nt.k < kmin) kmin = nt.k; if (nt.k > kmax) kmax = nt.k; }
    const out = { key, list, kmin, kmax: Math.max(kmax, kmin + 6), plen: patternLength(this.project, pat) };
    this.cache.set(pat.id, out);
    return out;
  }

  drawPatternBody(ctx, c, b) {
    const pat = this.project.patterns[c.ref];
    if (!pat) return;
    const pv = this.patternPreview(pat), v = this.view;
    if (!pv.list.length) return;
    ctx.fillStyle = 'rgba(255,255,255,.75)';
    const rows = pv.kmax - pv.kmin + 1, nh = Math.max(1.2, Math.min(4, b.h / rows));
    const firstCycle = Math.floor(c.o / pv.plen), lastCycle = Math.ceil((c.o + c.l) / pv.plen);
    for (let cyc = firstCycle; cyc < lastCycle; cyc++) {
      const base = c.s - c.o + cyc * pv.plen;
      for (const n of pv.list) {
        if (n.s >= pv.plen) continue;
        const ts = base + n.s;
        if (ts + n.l < c.s || ts >= c.s + c.l) continue;
        const x = this.tx(ts), w = Math.max(1, n.l * v.px);
        if (x + w < b.x || x > b.x + b.w) continue;
        ctx.fillRect(x, b.y + 1 + (1 - (n.k - pv.kmin) / rows) * (b.h - nh - 2), w, nh);
      }
    }
  }

  drawAudioBody(ctx, c, b) {
    const ch = this.store.channel(c.ref);
    const e = ch && ch.sample ? this.store.bank.get(c.use || ch.sample.id) : null;
    if (!e) { ctx.fillStyle = 'rgba(255,255,255,.4)'; ctx.fillText('no sample', b.x + 6, b.y + b.h / 2); return; }
    const sec = 60 / this.project.tempo / PPQ;
    const rate = e.rate * (c.pitch && !c.use ? Math.pow(2, c.pitch / 12) : 1);
    const x0 = Math.max(0, Math.floor(b.x)), x1 = Math.min(this.W, Math.ceil(b.x + b.w));
    ctx.fillStyle = 'rgba(255,255,255,.85)';
    const mid = b.y + b.h / 2, amp = b.h / 2 - 1;
    const chs = e.channels;
    for (let x = x0; x < x1; x++) {
      const ta = this.xt(x) - c.s, tb = this.xt(x + 1) - c.s;
      let fa = (c.o + (c.rev ? c.l - tb : ta)) * sec * rate, fb = (c.o + (c.rev ? c.l - ta : tb)) * sec * rate;
      if (fb < 0 || fa >= e.length) continue;
      fa = Math.max(0, Math.floor(fa)); fb = Math.min(e.length, Math.max(fa + 1, Math.ceil(fb)));
      const step = Math.max(1, (fb - fa) >> 5);
      let mn = 0, mx = 0;
      for (const cc of chs) for (let i = fa; i < fb; i += step) { const s = cc[i]; if (s < mn) mn = s; if (s > mx) mx = s; }
      ctx.fillRect(x, mid - mx * amp, 1, Math.max(1, (mx - mn) * amp));
    }
  }

  drawAutomationBody(ctx, c, b) {
    const ch = this.store.channel(c.ref);
    if (!ch || !ch.points.length) { ctx.fillStyle = 'rgba(255,255,255,.4)'; ctx.fillText('empty', b.x + 6, b.y + b.h / 2); return; }
    const len = ch.len || this.barT;
    const n = Math.max(2, Math.min(240, Math.floor(b.w / 2)));
    const vals = renderCurve(ch.points, len, 96);
    ctx.strokeStyle = 'rgba(255,255,255,.9)'; ctx.lineWidth = 1.3; ctx.beginPath();
    let first = true;
    for (let i = 0; i < n; i++) {
      const x = b.x + (i / (n - 1)) * b.w, ct = c.o + ((x - b.x) / this.view.px);
      const idx = clamp(Math.round(((ct % len) / len) * 95), 0, 95);
      const y = b.y + (1 - vals[idx]) * (b.h - 4) + 2;
      if (first) { ctx.moveTo(x, y); first = false; } else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  drawNames() {
    const ctx = this.names.getContext('2d'), H = this.gridH, v = this.view, dpr = this.dpr, arr = this.arr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#2f3438'; ctx.fillRect(0, 0, NAMES_W, H);
    ctx.font = '11px "Segoe UI", system-ui, sans-serif'; ctx.textBaseline = 'middle';
    const tr0 = Math.max(1, this.trackAt(0)), tr1 = Math.min(MAX_TRACK, this.trackAt(H));
    for (let t = tr0; t <= tr1; t++) {
      const y = this.ty(t), ov = arr.tracks[t] || {};
      ctx.fillStyle = t % 2 ? '#383d42' : '#353a3f'; ctx.fillRect(0, y, NAMES_W - 1, v.rowH - 1);
      ctx.fillStyle = ov.color || '#555d65'; ctx.fillRect(0, y, 4, v.rowH - 1);
      ctx.fillStyle = ov.mute ? '#6c747b' : '#d5dce0';
      ctx.fillText(ov.name || `Track ${t}`, 10, y + Math.min(14, v.rowH / 2));
      // mute / solo
      const by = y + v.rowH - 17;
      ctx.fillStyle = ov.mute ? '#ff7468' : '#1a1d20'; ctx.fillRect(NAMES_W - 44, by, 18, 14);
      ctx.fillStyle = ov.mute ? '#fff' : '#8e989f'; ctx.fillText('M', NAMES_W - 38, by + 7);
      ctx.fillStyle = ov.solo ? '#ffc04a' : '#1a1d20'; ctx.fillRect(NAMES_W - 23, by, 18, 14);
      ctx.fillStyle = ov.solo ? '#251a05' : '#8e989f'; ctx.fillText('S', NAMES_W - 17, by + 7);
    }
    ctx.fillStyle = '#000'; ctx.fillRect(NAMES_W - 1, 0, 1, H);
  }

  drawRuler() {
    const ctx = this.ruler.getContext('2d'), W = this.W, v = this.view, dpr = this.dpr, arr = this.arr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#2f3438'; ctx.fillRect(0, 0, W, TOP);
    ctx.fillStyle = '#2a2e32'; ctx.fillRect(0, 0, W, MARK_H);
    ctx.font = '10px "Segoe UI", system-ui, sans-serif'; ctx.textBaseline = 'middle';
    const t0 = Math.max(0, this.xt(0)), t1 = this.xt(W);
    // loop band
    if (arr.loop) { ctx.fillStyle = 'rgba(255,176,46,.35)'; ctx.fillRect(this.tx(arr.loop.s), MARK_H, (arr.loop.e - arr.loop.s) * v.px, RULER_H - 1); }
    if (arr.punch) { ctx.fillStyle = 'rgba(230,90,75,.45)'; ctx.fillRect(this.tx(arr.punch.in), MARK_H + RULER_H - 5, (arr.punch.out - arr.punch.in) * v.px, 4); }
    const tm = this.tmCache;
    if (this.beatT * v.px >= 8) { ctx.fillStyle = '#5f686f'; for (let t = Math.ceil(t0 / this.beatT) * this.beatT; t <= t1; t += this.beatT) ctx.fillRect(Math.round(this.tx(t)), TOP - 6, 1, 5); }
    let lastLabel = -100;
    this.eachBar(t0, t1, (t, bar) => {
      const x = Math.round(this.tx(t));
      ctx.fillStyle = '#8e989f'; ctx.fillRect(x, MARK_H, 1, RULER_H);
      if (x - lastLabel >= 26) { ctx.fillStyle = '#d5dce0'; ctx.fillText(String(bar), x + 4, MARK_H + 8); lastLabel = x; }
    });
    // markers
    for (const m of arr.markers) {
      const x = this.tx(m.t);
      if (x < -80 || x > W) continue;
      const label = m.type === 'timesig' ? `${m.num}/${m.den}` : m.type === 'patlen' ? `len ${(m.len / this.barT).toFixed(m.len % this.barT ? 2 : 0)} bar` : (m.name || 'Marker');
      const col = m.type === 'timesig' ? '#4aa8e0' : m.type === 'patlen' ? '#b968d6' : '#ffb02e';
      const w = ctx.measureText(label).width + 10;
      ctx.fillStyle = col; ctx.fillRect(x, 0, 2, MARK_H); ctx.fillRect(x, 1, w, MARK_H - 3);
      ctx.fillStyle = '#1b1d20'; ctx.fillText(label, x + 5, MARK_H / 2);
    }
    if (arr.start != null) { const x = this.tx(arr.start); ctx.fillStyle = '#7fdc5c'; ctx.beginPath(); ctx.moveTo(x, MARK_H + 2); ctx.lineTo(x + 9, MARK_H + 8); ctx.lineTo(x, MARK_H + 14); ctx.closePath(); ctx.fill(); }
    ctx.fillStyle = '#000'; ctx.fillRect(0, TOP - 1, W, 1);
    void tm;
  }

  // ------------------------------------------------------------------ hit testing
  clipAt(x, y) {
    const t = this.xt(x), track = this.trackAt(y);
    const clips = this.arr.clips;
    for (let i = clips.length - 1; i >= 0; i--) {
      const c = clips[i];
      if (c.track !== track || t < c.s || t >= c.s + c.l) continue;
      const w = c.l * this.view.px, left = this.tx(c.s), right = left + w;
      const edge = Math.min(EDGE, w / 3);
      const zone = x >= right - edge ? 'right' : x <= left + edge ? 'left' : 'body';
      const yy = y - this.ty(c.track);
      return { clip: c, zone, menu: yy < HEAD_H + 1 && x >= right - 16 && w > 46 };
    }
    return null;
  }

  sourceLength() {
    const s = this.source, p = this.project;
    if (s.type === 'audio') { const ch = this.store.channel(s.ref); const e = ch && ch.sample ? this.store.bank.get(ch.sample.id) : null; return defaultClipLength(p, 'audio', s.ref, e); }
    return defaultClipLength(p, s.type, s.ref ?? p.currentPattern);
  }

  cursorFor(hit) {
    switch (this.tool) {
      case 'draw': case 'select': case 'paint': return hit && hit.zone !== 'body' ? 'ew-resize' : hit ? 'grab' : this.tool === 'select' ? 'crosshair' : 'cell';
      case 'delete': return 'not-allowed';
      case 'slice': return 'crosshair';
      case 'zoom': return 'zoom-in';
      default: return 'pointer';
    }
  }

  // ------------------------------------------------------------------ pointer interaction
  bind() {
    const g = this.grid;
    g.addEventListener('pointerdown', (e) => this.gridDown(e));
    g.addEventListener('pointermove', (e) => this.gridHover(e));
    g.addEventListener('pointerleave', () => { this.hover = null; this.invalidate(); });
    g.addEventListener('contextmenu', (e) => e.preventDefault());
    g.addEventListener('wheel', (e) => this.wheel(e), { passive: false });
    g.addEventListener('dblclick', (e) => this.gridDouble(e));
    g.addEventListener('dragover', (e) => { const t = e.dataTransfer.types; if (t.includes('application/x-stepwise-clip') || t.includes('Files') || t.includes('application/x-stepwise-sample')) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } });
    g.addEventListener('drop', (e) => this.onDrop(e));
    this.names.addEventListener('pointerdown', (e) => this.namesDown(e));
    this.names.addEventListener('contextmenu', (e) => this.namesMenu(e));
    this.names.addEventListener('wheel', (e) => this.wheel(e), { passive: false });
    this.ruler.addEventListener('pointerdown', (e) => this.rulerDown(e));
    this.ruler.addEventListener('contextmenu', (e) => this.rulerMenu(e));
    this.ruler.addEventListener('wheel', (e) => this.wheel(e), { passive: false });
    const store = this.store;
    this.subs = [
      store.bus.on('change', ({ paths }) => {
        if (paths.some((p) => p[0] === 'currentPattern') && this.source.type === 'pattern') { this.source.ref = this.project.currentPattern; if (this.win.open) this.buildSide(); }
        if (paths.some((p) => p[0] === 'playlist' || p[0] === 'patterns' || p[0] === 'channels' || p[0] === 'timeSig')) {
          this.prune(); this.invalidate();
          if (this.win.open) { this.buildTabs(); this.buildSide(); }
        }
      }),
      store.bus.on('arrangement', () => { this.sel.clear(); this.buildTabs(); this.invalidate(); }),
      store.bus.on('project', () => { this.sel.clear(); this.cache.clear(); this.buildTabs(); this.buildSide(); this.layout(); }),
      store.bus.on('snap', () => this.invalidate()),
      store.bus.on('samples', () => this.invalidate()),
      this.app.host.bus.on('perf', (m) => { this.perfEntries = m.entries; this.invalidate(); }),
      this.app.host.bus.on('state', (st) => { if (st.mode !== 'perf' && this.perfEntries.length) { this.perfEntries = []; this.invalidate(); } }),
    ];
    this.zoomX.value = String((Math.log(this.view.px / 0.01) / Math.log(200)) * 100);
    this.zoomY.value = String(((this.view.rowH - 20) / 90) * 100);
  }

  prune() {
    if (!this.sel.size) return;
    const ids = new Set(this.arr.clips.map((c) => c.id));
    for (const id of [...this.sel]) if (!ids.has(id)) this.sel.delete(id);
  }

  local(e, cv = this.grid) { const r = cv.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
  newGesture() { return `gesture:pl:${++this.gesture}`; }
  setSel(ids) { this.sel = new Set(ids); this.invalidate(); }

  gridHover(e) {
    if (this.dragging) return;
    const { x, y } = this.local(e);
    const hit = this.clipAt(x, y);
    this.grid.style.cursor = hit && hit.menu ? 'pointer' : this.cursorFor(hit);
    this.hover = { t: this.floorT(this.xt(x), e), track: clamp(this.trackAt(y), 1, MAX_TRACK), hit };
    const tm = this.tmCache || this.tm, b = tm.bbt(Math.max(0, this.xt(x)));
    this.info.textContent = `Track ${this.hover.track}  ·  ${b.bar}:${b.beat}`;
    this.invalidate();
  }

  wheel(e) {
    e.preventDefault();
    if (e.ctrlKey) this.setZoomX(this.view.px * (e.deltaY < 0 ? 1.15 : 1 / 1.15), this.local(e).x);
    else if (e.altKey) this.setRowH(this.view.rowH * (e.deltaY < 0 ? 1.1 : 1 / 1.1), this.local(e).y);
    else if (e.shiftKey) { this.view.x0 += (e.deltaY + e.deltaX) / this.view.px * 0.6; this.clampView(); this.invalidate(); }
    else { this.view.y0 += e.deltaY * 0.6; this.view.x0 += e.deltaX / this.view.px * 0.6; this.clampView(); this.invalidate(); }
  }

  gridDouble(e) {
    const { x, y } = this.local(e), hit = this.clipAt(x, y);
    if (!hit) return;
    const c = hit.clip;
    if (c.type === 'pattern') { this.app.cmd.selectPattern(this.store, c.ref); this.app.openWindow('rack'); }
    else if (c.type === 'automation' && this.app.openAutomationEditor) this.app.openAutomationEditor(c.ref);
    else if (c.type === 'audio') this.app.openChannelEditor && this.app.openChannelEditor(c.ref);
  }

  gridDown(e) {
    const { x, y } = this.local(e);
    const hit = this.clipAt(x, y);
    const right = e.button === 2;
    if (e.button !== 0 && !right) return;
    const track = clamp(this.trackAt(y), 1, MAX_TRACK), t = this.xt(x);
    this.cursorT = Math.max(0, this.floorT(t, e));
    this.hover = null;
    if (this.perf) { this.perfDown(e, hit, track); return; }
    if (hit && hit.menu && !right) { this.clipMenu(e, hit.clip); return; }
    if (right) {
      if (hit && this.tool === 'select') { if (!this.sel.has(hit.clip.id)) this.setSel([hit.clip.id]); this.clipMenu(e, hit.clip); return; }
      this.eraseDrag(e, hit); return;
    }
    switch (this.tool) {
      case 'draw': case 'select': case 'paint':
        if (hit) { this.clipDrag(e, hit); return; }
        if (this.tool === 'select') { this.rubberSelect(e); return; }
        if (this.tool === 'paint') { this.paintDrag(e, track); return; }
        this.drawNew(e, track, t);
        return;
      case 'delete': this.eraseDrag(e, hit); return;
      case 'mute': this.muteDrag(e, hit); return;
      case 'slice': this.sliceDrag(e); return;
      case 'zoom': this.zoomDrag(e); return;
      case 'playback': this.playbackDrag(e); return;
      default:
    }
  }

  // ---- Performance mode: clicking launches, clicking a playing clip again stops its track
  perfDown(e, hit, track) {
    const tr = this.app.transport;
    if (e.button === 2) { tr.perfStop(track, this.quant); return; }
    if (!hit) { tr.perfStop(track, this.quant); return; }
    const entry = this.perfEntries.find((en) => en.clipId === hit.clip.id && (en.stop == null));
    if (entry) tr.perfStop(hit.clip.track, this.quant); else tr.perfLaunch(hit.clip.id, this.quant);
  }

  // ---- place
  placeClips(track, t, token) {
    const s = this.source, p = this.project, cmd = this.app.cmd;
    const ref = s.type === 'pattern' ? (s.ref ?? p.currentPattern) : s.ref;
    if (ref == null || (s.type !== 'pattern' && !this.store.channel(ref))) { this.app.toast('Pick a clip source on the left first'); return []; }
    if (s.type === 'pattern' && !p.patterns[ref]) return [];
    return cmd.addClips(this.store, [{ type: s.type, track, s: t, l: this.sourceLength(), ref }], 'Add clip', token);
  }

  drawNew(e, track, t) {
    const token = this.newGesture();
    const made = this.placeClips(track, this.floorT(t, e), token);
    if (!made.length) return;
    this.setSel(made.map((c) => c.id));
    this.clipDrag(e, { clip: made[0], zone: 'body' }, true, token);
  }

  // move / resize the selected clips by dragging one of them
  clipDrag(e, hit, fresh = false, gestureToken = null) {
    const cmd = this.app.cmd, store = this.store;
    const c0 = hit.clip;
    if (!this.sel.has(c0.id)) { if (e.shiftKey) this.setSel([...this.sel, c0.id]); else this.setSel([c0.id]); }
    else if (e.shiftKey && !fresh) { this.sel.delete(c0.id); this.invalidate(); return; }
    const ids = [...this.sel];
    const orig = new Map(this.selClips.map((c) => [c.id, { s: c.s, l: c.l, o: c.o, track: c.track }]));
    const o0 = orig.get(c0.id);
    const token = gestureToken || this.newGesture();
    const startX = e.clientX, startY = e.clientY, zone = hit.zone;
    const r = this.grid.getBoundingClientRect();
    const span = spanOf(this.selClips);
    let moved = false;
    let base = this.arr.clips.map((c) => ({ ...c }));       // the arrangement as it was before this drag
    this.dragging = true;
    const loopLenOf = (c) => { if (c.type !== 'pattern') return 0; const pat = this.project.patterns[c.ref]; return pat ? patternLength(this.project, pat) : 0; };
    drag(e, (dx, dy, ev) => {
      if (!moved && Math.abs(ev.clientX - startX) < 3 && Math.abs(ev.clientY - startY) < 3) return;
      const t = this.xt(ev.clientX - r.left);
      if (!moved && ev.ctrlKey && zone === 'body' && !fresh) {
        // Ctrl+drag: copies are created exactly on the originals and are what gets moved
        const olds = [...orig.values()];
        const clones = cmd.addClips(store, this.selClips.map((c) => ({ type: c.type, track: c.track, s: c.s, l: c.l, ref: c.ref, o: c.o, mute: c.mute, name: c.name, color: c.color, fi: c.fi, fo: c.fo, rev: c.rev, gain: c.gain, pitch: c.pitch, stretch: c.stretch, norm: c.norm, use: c.use })), 'Copy clips', token, { overlap: false });
        orig.clear(); clones.forEach((c, i) => orig.set(c.id, olds[i]));
        ids.length = 0; ids.push(...clones.map((c) => c.id));
        base = this.arr.clips.map((c) => ({ ...c }));
        this.setSel(ids);
      }
      moved = true;
      if (zone === 'right') {
        const end = Math.max(o0.s + 1, this.snapT(t, ev)), dl = end - (o0.s + o0.l);
        cmd.dragClips(store, base, ids, (c) => { const o = orig.get(c.id); c.l = Math.max(1, o.l + dl); }, 'Resize clips', token);
      } else if (zone === 'left') {
        const ns = Math.max(0, Math.min(o0.s + o0.l - 1, this.snapT(t, ev))), ds = ns - o0.s;
        cmd.dragClips(store, base, ids, (c) => { const o = orig.get(c.id); Object.assign(c, { s: o.s, l: o.l, o: o.o }); trimLeft(c, o.s + ds, loopLenOf(c)); }, 'Trim clips', token);
      } else {
        const grab = this.xt(startX - r.left) - o0.s;
        let ds = this.snapT(t - grab, ev) - o0.s;
        ds = Math.max(ds, -span.s);
        let dt = this.trackAt(ev.clientY - r.top) - o0.track;
        dt = clamp(dt, 1 - span.t0, MAX_TRACK - span.t1);
        cmd.dragClips(store, base, ids, (c) => { const o = orig.get(c.id); c.s = o.s + ds; c.track = o.track + dt; }, 'Move clips', token);
      }
    }, () => { this.dragging = false; this.invalidate(); });
  }

  eraseDrag(e, hit) {
    const cmd = this.app.cmd, token = this.newGesture(), removed = new Set();
    const r = this.grid.getBoundingClientRect();
    const kill = (h2) => { if (h2 && !removed.has(h2.clip.id)) { removed.add(h2.clip.id); this.sel.delete(h2.clip.id); cmd.deleteClips(this.store, [h2.clip.id], 'Delete clips', token); } };
    kill(hit);
    this.dragging = true;
    drag(e, (dx, dy, ev) => kill(this.clipAt(ev.clientX - r.left, ev.clientY - r.top)), () => { this.dragging = false; this.invalidate(); });
  }

  muteDrag(e, hit) {
    const cmd = this.app.cmd, r = this.grid.getBoundingClientRect(), token = this.newGesture();
    const first = hit ? !hit.clip.mute : true, done = new Set();
    const apply = (h2) => { if (!h2 || done.has(h2.clip.id)) return; done.add(h2.clip.id); cmd.updateClips(this.store, [h2.clip.id], (c) => { c.mute = first ? 1 : 0; }, first ? 'Mute clips' : 'Unmute clips', token, { overlap: false }); };
    apply(hit);
    this.dragging = true;
    drag(e, (dx, dy, ev) => apply(this.clipAt(ev.clientX - r.left, ev.clientY - r.top)), () => { this.dragging = false; this.invalidate(); });
  }

  rubberSelect(e) {
    const r = this.grid.getBoundingClientRect();
    const x0 = e.clientX - r.left, y0 = e.clientY - r.top;
    const base = e.shiftKey ? new Set(this.sel) : new Set();
    if (!e.shiftKey) this.setSel([]);
    this.dragging = true;
    drag(e, (dx, dy, ev) => {
      const x1 = clamp(ev.clientX - r.left, 0, this.W), y1 = clamp(ev.clientY - r.top, 0, this.gridH);
      this.overlay = { type: 'rect', x0, y0, x1, y1 };
      const ta = this.xt(Math.min(x0, x1)), tb = this.xt(Math.max(x0, x1));
      const ka = this.trackAt(Math.min(y0, y1)), kb = this.trackAt(Math.max(y0, y1));
      const ids = new Set(base);
      for (const c of this.arr.clips) if (c.track >= ka && c.track <= kb && c.s + c.l > ta && c.s < tb) ids.add(c.id);
      this.sel = ids; this.invalidate();
    }, () => { this.overlay = null; this.dragging = false; this.invalidate(); });
  }

  paintDrag(e, track) {
    const r = this.grid.getBoundingClientRect(), token = this.newGesture();
    const len = this.sourceLength(), t0 = this.floorT(this.xt(e.clientX - r.left), e);
    let count = 0; const made = [];
    const fill = (ev) => {
      const want = Math.max(1, Math.floor((this.xt(ev.clientX - r.left) - t0) / len) + 1);
      while (count < want && count < 256) { const m = this.placeClips(track, t0 + count * len, token); made.push(...m); count++; }
    };
    this.dragging = true;
    fill(e);
    drag(e, (dx, dy, ev) => fill(ev), () => { this.dragging = false; this.setSel(made.map((c) => c.id)); });
  }

  sliceDrag(e) {
    const r = this.grid.getBoundingClientRect();
    const x0 = e.clientX - r.left, y0 = e.clientY - r.top;
    this.dragging = true;
    drag(e, (dx, dy, ev) => { this.overlay = { type: 'line', x0, y0, x1: ev.clientX - r.left, y1: ev.clientY - r.top }; this.invalidate(); }, (ev) => {
      this.overlay = null; this.dragging = false;
      const x1 = ev.clientX - r.left, y1 = ev.clientY - r.top;
      const ka = this.trackAt(Math.min(y0, y1)), kb = this.trackAt(Math.max(y0, y1));
      const point = Math.abs(x1 - x0) < 2 && Math.abs(y1 - y0) < 2;
      const cuts = [];
      for (const c of this.arr.clips) {
        if (c.track < ka || c.track > kb) continue;
        const cy = this.ty(c.track) + this.view.rowH / 2;
        const cx = point || Math.abs(y1 - y0) < 1 ? x0 : clamp(x0 + ((cy - y0) / (y1 - y0)) * (x1 - x0), Math.min(x0, x1), Math.max(x0, x1));
        const ct = this.snapT(this.xt(cx), ev);
        if (ct > c.s && ct < c.s + c.l) cuts.push([c.id, ct]);
      }
      if (cuts.length) { const ids = this.app.cmd.sliceClips(this.store, cuts); this.setSel(ids); }
    });
  }

  zoomDrag(e) {
    const r = this.grid.getBoundingClientRect();
    const x0 = e.clientX - r.left, y0 = e.clientY - r.top;
    let moved = false;
    drag(e, (dx, dy, ev) => { if (Math.abs(dx) + Math.abs(dy) > 4) moved = true; this.overlay = { type: 'rect', x0, y0, x1: ev.clientX - r.left, y1: ev.clientY - r.top }; this.invalidate(); }, (ev) => {
      this.overlay = null;
      const x1 = ev.clientX - r.left, y1 = ev.clientY - r.top;
      if (!moved) { this.setZoomX(this.view.px * 1.6, x0); return; }
      const ta = this.xt(Math.min(x0, x1)), tb = this.xt(Math.max(x0, x1));
      this.view.px = clamp(this.W / Math.max(this.beatT, tb - ta), 0.01, 2); this.view.x0 = Math.max(0, ta);
      const ka = this.trackAt(Math.min(y0, y1)), kb = this.trackAt(Math.max(y0, y1));
      this.view.rowH = clamp(this.gridH / Math.max(2, kb - ka + 1), 20, 110); this.view.y0 = (ka - 1) * this.view.rowH;
      this.zoomX.value = String((Math.log(this.view.px / 0.01) / Math.log(200)) * 100); this.zoomY.value = String(((this.view.rowH - 20) / 90) * 100);
      this.prefs(); this.clampView(); this.invalidate();
    });
  }

  playbackDrag(e) {
    const r = this.grid.getBoundingClientRect(), tr = this.app.transport;
    const t = Math.max(0, this.snapT(this.xt(e.clientX - r.left), e));
    const was = tr.playing, mode = tr.mode;
    if (!was) { tr.mode = 'song'; tr.play(t); } else tr.seek(t);
    drag(e, (dx, dy, ev) => tr.seek(Math.max(0, this.snapT(this.xt(ev.clientX - r.left), ev))), () => { if (!was) { tr.stop(); tr.mode = mode; this.app.store.bus.emit('transport'); } });
  }

  // ---- drop from the source list / audio files
  async onDrop(e) {
    e.preventDefault();
    const { x, y } = this.local(e);
    const track = clamp(this.trackAt(y), 1, MAX_TRACK), t = Math.max(0, this.floorT(this.xt(x), e));
    const clipSrc = e.dataTransfer.getData('application/x-stepwise-clip');
    if (clipSrc) {
      const s = JSON.parse(clipSrc);
      const made = this.app.cmd.addClips(this.store, [{ type: s.type, track, s: t, l: s.type === 'pattern' ? defaultClipLength(this.project, 'pattern', s.ref) : this.lengthFor(s), ref: s.ref }], 'Add clip');
      this.setSel(made.map((c) => c.id));
      return;
    }
    const sample = e.dataTransfer.getData('application/x-stepwise-sample');
    if (sample) { const s = JSON.parse(sample); await this.app.bank.ensure(s.id); this.addAudioAt(s, track, t); return; }
    let tt = t, n = 0;
    for (const f of e.dataTransfer.files) {
      try {
        const s = await this.app.bank.decode(f.name, await f.arrayBuffer());
        tt = this.addAudioAt({ id: s.id, name: s.name }, track + n, t); n += 1;
      } catch (err) { this.app.toast(`Could not decode ${f.name}`); }
    }
    void tt;
  }

  lengthFor(s) {
    if (s.type === 'audio') { const ch = this.store.channel(s.ref); const en = ch && ch.sample ? this.store.bank.get(ch.sample.id) : null; return defaultClipLength(this.project, 'audio', s.ref, en); }
    return defaultClipLength(this.project, s.type, s.ref);
  }

  addAudioAt(sample, track, t) {
    const cmd = this.app.cmd;
    const ch = cmd.addAudioChannel(this.store, sample);
    const entry = this.store.bank.get(sample.id);
    const made = cmd.addClips(this.store, [{ type: 'audio', track, s: t, l: defaultClipLength(this.project, 'audio', ch.id, entry), ref: ch.id }], 'Add audio clip');
    this.setSel(made.map((c) => c.id));
    return t;
  }

  // ------------------------------------------------------------------ clip menu
  clipMenu(e, clip) {
    const cmd = this.app.cmd, store = this.store, ids = this.sel.has(clip.id) ? [...this.sel] : [clip.id];
    const cs = this.arr.clips.filter((c) => ids.includes(c.id));
    const all = (f) => cs.every(f);
    const upd = (fn, label) => cmd.updateClips(store, ids, fn, label, undefined, { overlap: false });
    const audio = cs.every((c) => c.type === 'audio');
    const items = [
      { label: 'Rename…', fn: async () => { const n = await promptText('Rename clip', 'Name (empty = source name)', clip.name || ''); if (n !== null) upd((c) => { if (n) c.name = n.slice(0, 40); else delete c.name; }, 'Rename clip'); } },
      { label: 'Colour…', fn: () => pickColor(e.clientX, e.clientY, clip.color, (col) => upd((c) => { if (col) c.color = col; else delete c.color; }, 'Clip colour')) },
      { label: all((c) => c.mute) ? 'Unmute' : 'Mute', fn: () => { const on = !all((c) => c.mute); upd((c) => { c.mute = on ? 1 : 0; }, 'Mute clips'); } },
      { sep: true },
    ];
    if (cs.every((c) => c.type === 'pattern')) {
      items.push({ label: 'Make unique', hint: 'Own copy of the pattern', fn: () => cmd.makeUnique(store, ids) },
        { label: 'Open pattern in the Channel rack', fn: () => { cmd.selectPattern(store, clip.ref); this.app.openWindow('rack'); } }, { sep: true });
    }
    if (audio) {
      items.push(
        { label: 'Fade in…', fn: () => this.fadeDialog(ids, 'fi', 'Fade in') },
        { label: 'Fade out…', fn: () => this.fadeDialog(ids, 'fo', 'Fade out') },
        { label: 'Reverse', checked: all((c) => c.rev), fn: () => { const on = !all((c) => c.rev); upd((c) => { if (on) c.rev = 1; else delete c.rev; }, 'Reverse clips'); } },
        { label: 'Normalize', checked: all((c) => c.norm), fn: () => { const on = !all((c) => c.norm); upd((c) => { if (on) c.norm = 1; else delete c.norm; }, 'Normalize clips'); } },
        { label: 'Gain…', fn: async () => { const v = await formDialog('Clip gain', [{ id: 'gain', label: 'Gain', type: 'range', min: -24, max: 12, step: 0.5, value: clip.gain || 0, unit: ' dB' }]); if (v) upd((c) => { if (v.gain) c.gain = v.gain; else delete c.gain; }, 'Clip gain'); } },
        { label: 'Pitch (resample)…', fn: async () => { const v = await formDialog('Clip pitch', [{ id: 'pitch', label: 'Pitch', type: 'range', min: -24, max: 24, step: 1, value: clip.pitch || 0, unit: ' st' }]); if (v) upd((c) => { if (v.pitch) c.pitch = v.pitch; else delete c.pitch; }, 'Clip pitch'); } },
        { label: 'Time-stretch…', fn: () => this.stretchDialog(clip) },
        { label: 'Reset time-stretch', disabled: !all((c) => c.use), fn: () => this.resetStretch(ids) },
        { label: 'Edit sample in the audio editor', disabled: ids.length !== 1 || !this.app.openAudioEditor, fn: () => { const ch = store.channel(clip.ref); if (ch && ch.sample) this.app.openAudioEditor({ sampleId: clip.use || ch.sample.id, chId: ch.id, name: ch.sample.name }); } },
        { sep: true });
    }
    if (cs.every((c) => c.type === 'automation')) {
      items.push({ label: 'Edit events…', disabled: !this.app.openAutomationEditor, fn: () => this.app.openAutomationEditor(clip.ref) }, { sep: true });
    }
    items.push({ label: 'Delete', key: 'Del', fn: () => { cmd.deleteClips(store, ids); this.setSel([]); } });
    showPopup(items, e.clientX, e.clientY);
  }

  async fadeDialog(ids, key, title) {
    const cur = this.arr.clips.find((c) => c.id === ids[0]);
    const v = await formDialog(title, [{ id: 'beats', label: 'Length', type: 'range', min: 0, max: 8, step: 0.0625, value: (cur[key] || 0) / PPQ, unit: ' beats' }]);
    if (!v) return;
    this.app.cmd.updateClips(this.store, ids, (c) => { const t = Math.round(v.beats * PPQ); if (t > 0) c[key] = t; else delete c[key]; }, title, undefined, { overlap: false });
  }

  async stretchDialog(clip) {
    const ch = this.store.channel(clip.ref);
    const entry = ch && ch.sample ? await this.app.bank.ensure(ch.sample.id) : null;
    if (!entry) { this.app.toast('The clip has no sample'); return; }
    const natural = (entry.length / entry.rate) * (this.project.tempo / 60) * PPQ;       // ticks at the project tempo
    const bars = Math.max(0.25, Math.round((natural / this.barT) * 4) / 4);
    const v = await formDialog('Time-stretch', [
      { id: 'mode', label: 'Set', type: 'select', value: 'bars', options: [['bars', 'Fit to a number of bars'], ['ratio', 'Length multiplier']] },
      { id: 'bars', label: 'Bars', type: 'number', min: 0.25, max: 64, step: 0.25, value: bars },
      { id: 'ratio', label: 'Multiplier', type: 'number', min: 0.1, max: 10, step: 0.01, value: clip.stretch || 1 },
      { id: 'semi', label: 'Pitch', type: 'range', min: -12, max: 12, step: 1, value: 0, unit: ' st' },
    ], { ok: 'Stretch' });
    if (!v) return;
    const ratio = v.mode === 'bars' ? (v.bars * this.barT) / natural : v.ratio;
    this.app.toast('Stretching…');
    await new Promise((r) => setTimeout(r, 20));
    const ok = await this.app.cmd.stretchClip(this.store, clip.id, clamp(ratio, 0.1, 10), v.semi);
    this.app.toast(ok ? 'Stretched' : 'Could not stretch this clip');
  }

  resetStretch(ids) {
    this.app.cmd.updateClips(this.store, ids, (c) => {
      const r = c.stretch || 1;
      c.l = Math.max(1, Math.round(c.l / r)); c.o = Math.round(c.o / r);
      delete c.use; delete c.stretch;
    }, 'Reset time-stretch');
  }

  // ------------------------------------------------------------------ track names
  trackOfY(e) { const { y } = this.local(e, this.names); return clamp(this.trackAt(y), 1, MAX_TRACK); }

  namesDown(e) {
    if (e.button !== 0) return;
    const { x, y } = this.local(e, this.names), t = clamp(this.trackAt(y), 1, MAX_TRACK);
    const ry = y - this.ty(t), ov = this.arr.tracks[t] || {};
    if (this.perf) { this.app.transport.perfStop(t, this.quant); return; }
    if (ry >= this.view.rowH - 17 && ry < this.view.rowH - 3) {
      if (x >= NAMES_W - 44 && x < NAMES_W - 26) { this.app.cmd.setPlaylistTrack(this.store, t, { mute: ov.mute ? 0 : 1 }, 'Mute track'); return; }
      if (x >= NAMES_W - 23 && x < NAMES_W - 5) { this.app.cmd.setPlaylistTrack(this.store, t, { solo: ov.solo ? 0 : 1 }, 'Solo track'); return; }
    }
    this.setSel(this.arr.clips.filter((c) => c.track === t).map((c) => c.id));
  }

  namesMenu(e) {
    e.preventDefault();
    const t = this.trackOfY(e), ov = this.arr.tracks[t] || {}, cmd = this.app.cmd, store = this.store;
    showPopup([
      { label: 'Rename…', fn: async () => { const n = await promptText('Rename track', 'Name', ov.name || `Track ${t}`); if (n !== null) cmd.setPlaylistTrack(store, t, { name: n.slice(0, 30) === `Track ${t}` ? '' : n.slice(0, 30) }, 'Rename track'); } },
      { label: 'Colour…', fn: () => pickColor(e.clientX, e.clientY, ov.color, (c) => cmd.setPlaylistTrack(store, t, { color: c || '' }, 'Track colour')) },
      { label: ov.mute ? 'Unmute' : 'Mute', fn: () => cmd.setPlaylistTrack(store, t, { mute: ov.mute ? 0 : 1 }, 'Mute track') },
      { label: ov.solo ? 'Unsolo' : 'Solo', fn: () => cmd.setPlaylistTrack(store, t, { solo: ov.solo ? 0 : 1 }, 'Solo track') },
      { sep: true },
      { label: 'Select all clips on the track', fn: () => this.setSel(this.arr.clips.filter((c) => c.track === t).map((c) => c.id)) },
      { label: 'Clear track', fn: () => { cmd.deleteClips(store, this.arr.clips.filter((c) => c.track === t).map((c) => c.id), 'Clear track'); this.setSel([]); } },
    ], e.clientX, e.clientY);
  }

  // ------------------------------------------------------------------ ruler: seek, loop, markers
  rulerDown(e) {
    if (e.button !== 0) return;
    const { x, y } = this.local(e, this.ruler);
    const cmd = this.app.cmd, store = this.store;
    // grab a marker flag
    if (y < MARK_H) {
      const hit = this.markerAt(x);
      if (hit) {
        const token = this.newGesture(), startT = hit.t, sx = e.clientX;
        drag(e, (dx, dy, ev) => { const t = Math.max(0, ev.altKey ? Math.round(startT + (ev.clientX - sx) / this.view.px) : Math.round((startT + (ev.clientX - sx) / this.view.px) / this.beatT) * this.beatT); cmd.updateMarker(store, hit.id, (m) => { m.t = t; }, 'Move marker', token); });
        return;
      }
    }
    if (e.shiftKey) {                       // shift-drag: loop region
      const t0 = Math.max(0, this.snapT(this.xt(x), e)), token = this.newGesture();
      drag(e, (dx, dy, ev) => { const t1 = Math.max(0, this.snapT(this.xt(ev.clientX - this.ruler.getBoundingClientRect().left), ev)); cmd.setLoop(store, { s: Math.min(t0, t1), e: Math.max(t0, t1) }, token); });
      return;
    }
    const seek = (ev) => { const t = Math.max(0, this.snapT(this.xt(this.local(ev, this.ruler).x), ev)); this.app.transport.seek(t); this.cursorT = t; this.invalidate(); };
    seek(e);
    drag(e, (dx, dy, ev) => seek(ev));
  }

  markerAt(x) {
    const ctx = this.ruler.getContext('2d');
    ctx.font = '10px "Segoe UI", system-ui, sans-serif';
    for (const m of [...this.arr.markers].reverse()) {
      const label = m.type === 'timesig' ? `${m.num}/${m.den}` : m.type === 'patlen' ? `len ${(m.len / this.barT).toFixed(2)} bar` : (m.name || 'Marker');
      const mx = this.tx(m.t), w = ctx.measureText(label).width + 10;
      if (x >= mx - 2 && x <= mx + w) return m;
    }
    return null;
  }

  rulerMenu(e) {
    e.preventDefault();
    const { x, y } = this.local(e, this.ruler);
    const t = Math.max(0, this.snapT(this.xt(x), e)), cmd = this.app.cmd, store = this.store, arr = this.arr;
    const hit = y < MARK_H ? this.markerAt(x) : null;
    const items = [];
    if (hit) {
      items.push({ label: hit.type === 'marker' ? 'Rename marker…' : 'Edit marker…', fn: () => this.editMarker(hit) }, { label: 'Delete marker', fn: () => cmd.removeMarker(store, hit.id) }, { sep: true });
    }
    items.push(
      { label: 'Add marker…', fn: async () => { const n = await promptText('Marker', 'Name', ''); if (n !== null) cmd.addMarker(store, { type: 'marker', t, name: n.slice(0, 40) }); } },
      { label: 'Add time signature…', fn: () => this.editMarker({ id: 0, type: 'timesig', t, num: this.project.timeSig.num, den: this.project.timeSig.den }, true) },
      { label: 'Add pattern length…', fn: () => this.editMarker({ id: 0, type: 'patlen', t, len: this.barT }, true) },
      { sep: true },
      { label: 'Set start marker here', fn: () => cmd.setStartMarker(store, t) },
      { label: 'Clear start marker', disabled: arr.start == null, fn: () => cmd.setStartMarker(store, null) },
      { sep: true },
      { label: 'Loop: set start here', fn: () => cmd.setLoop(store, { s: t, e: Math.max(t + this.barT, arr.loop ? arr.loop.e : t + this.barT * 4) }) },
      { label: 'Loop: set end here', fn: () => cmd.setLoop(store, { s: arr.loop ? Math.min(arr.loop.s, t - 1) : 0, e: t }) },
      { label: 'Loop: around selected clips', disabled: !this.sel.size, fn: () => { const sp = spanOf(this.selClips); cmd.setLoop(store, { s: sp.s, e: sp.e }); } },
      { label: 'Clear loop', disabled: !arr.loop, fn: () => cmd.setLoop(store, null) },
      { sep: true },
      { label: 'Punch: set in here', fn: () => cmd.setPunch(store, { in: t, out: Math.max(t + this.beatT, arr.punch ? arr.punch.out : t + this.barT) }) },
      { label: 'Punch: set out here', fn: () => cmd.setPunch(store, { in: arr.punch ? Math.min(arr.punch.in, t - 1) : 0, out: t }) },
      { label: 'Clear punch', disabled: !arr.punch, fn: () => cmd.setPunch(store, null) });
    showPopup(items, e.clientX, e.clientY);
  }

  async editMarker(m, isNew = false) {
    const cmd = this.app.cmd, store = this.store;
    if (m.type === 'marker') { const n = await promptText('Rename marker', 'Name', m.name || ''); if (n !== null) cmd.updateMarker(store, m.id, (x) => { x.name = n.slice(0, 40); }, 'Rename marker'); return; }
    if (m.type === 'timesig') {
      const v = await formDialog('Time signature', [{ id: 'num', label: 'Beats per bar', type: 'number', min: 1, max: 32, value: m.num }, { id: 'den', label: 'Beat unit', type: 'select', value: m.den, options: [1, 2, 4, 8, 16, 32].map((d) => [d, `1/${d}`]) }]);
      if (!v) return;
      if (isNew) cmd.addMarker(store, { type: 'timesig', t: m.t, num: v.num, den: v.den }); else cmd.updateMarker(store, m.id, (x) => { x.num = v.num; x.den = v.den; });
      return;
    }
    const v = await formDialog('Pattern length', [{ id: 'bars', label: 'Length (bars)', type: 'number', min: 0.0625, max: 64, step: 0.0625, value: +(m.len / this.barT).toFixed(4) }], { ok: 'Set' });
    if (!v) return;
    const len = Math.max(STEP, Math.round(v.bars * this.barT));
    if (isNew) cmd.addMarker(store, { type: 'patlen', t: m.t, len }); else cmd.updateMarker(store, m.id, (x) => { x.len = len; });
  }

  // ------------------------------------------------------------------ keyboard
  keyHook(e) {
    const w = this.win;
    if (!w.open || !w.el.classList.contains('active')) return false;
    if (e.target && ['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName)) return false;
    const key = e.key, lower = key.length === 1 ? key.toLowerCase() : key, ctrl = e.ctrlKey || e.metaKey, cmd = this.app.cmd;
    const ids = [...this.sel], g = this.snapTicks();
    if (ctrl) {
      if (lower === 'a') { this.setSel(this.arr.clips.map((c) => c.id)); return true; }
      if (lower === 'c') { this.copy(); return true; }
      if (lower === 'x') { this.copy(); this.deleteSel(); return true; }
      if (lower === 'v') { this.paste(); return true; }
      if (lower === 'b' || lower === 'd') { this.duplicate(); return true; }
      return false;
    }
    if (e.altKey) return false;
    if (key === 'Delete' || key === 'Backspace') { this.deleteSel(); return true; }
    if (key === 'Escape') { if (this.sel.size) { this.setSel([]); return true; } return false; }
    if (ids.length && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(key)) {
      const sp = spanOf(this.selClips);
      const ds = Math.max(key === 'ArrowLeft' ? -g : key === 'ArrowRight' ? g : 0, -sp.s);
      const dt = clamp(key === 'ArrowUp' ? -1 : key === 'ArrowDown' ? 1 : 0, 1 - sp.t0, MAX_TRACK - sp.t1);
      cmd.updateClips(this.store, ids, (c) => { c.s += ds; c.track += dt; }, 'Move clips', `gesture:pl-key:${key}`);
      return true;
    }
    if (!this.app.typingPiano && !e.shiftKey) {
      const map = { p: 'draw', b: 'paint', d: 'delete', t: 'mute', c: 'slice', e: 'select', z: 'zoom', y: 'playback' };
      if (map[lower]) { this.setTool(map[lower]); return true; }
    } else if (lower === 'p' && !e.shiftKey) { this.setTool('draw'); return true; }
    return false;
  }

  deleteSel() { if (!this.sel.size) return; this.app.cmd.deleteClips(this.store, [...this.sel]); this.setSel([]); }

  copy() {
    const cs = this.selClips;
    if (!cs.length) return;
    const sp = spanOf(cs);
    this.app.clipClipboard = cs.map((c) => ({ ...c, s: c.s - sp.s, track: c.track - sp.t0 }));
    this.app.toast(`Copied ${cs.length} clip${cs.length > 1 ? 's' : ''}`);
  }

  paste() {
    const clip = this.app.clipClipboard;
    if (!clip || !clip.length) return;
    const hv = this.hover;
    const track = hv ? hv.track : 1;
    const made = this.app.cmd.addClips(this.store, clip.map((c) => ({ ...c, id: undefined, s: c.s + this.cursorT, track: c.track + track })), 'Paste clips');
    this.setSel(made.map((c) => c.id));
  }

  duplicate() {
    const cs = this.selClips;
    if (!cs.length) return;
    const sp = spanOf(cs), g = this.barT;
    const span = Math.max(g, Math.ceil((sp.e - sp.s) / g) * g);
    const made = this.app.cmd.addClips(this.store, cs.map((c) => ({ ...c, id: undefined, s: c.s + span })), 'Duplicate clips');
    this.setSel(made.map((c) => c.id));
  }
}

export function createPlaylist(win, app) {
  const pl = new Playlist(win, app);
  app.playlist = pl;
  const hook = (e) => pl.keyHook(e);
  app.keyHooks.add(hook);
  return { el: pl.el, onResize: () => pl.onResize(), onShow: () => pl.onShow(), onHide: () => pl.onHide(), destroy: () => { app.keyHooks.delete(hook); pl.destroy(); } };
}
