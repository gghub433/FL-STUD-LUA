// Audio editor (in the spirit of Edison): waveform with selection and regions, zoom/scroll, cut/copy/paste,
// processing and effects on the selection, spectrogram, recording, and "send to" the project.
// The sample is edited in a private copy with its own undo history; nothing reaches the project until Send.
import { h, clear, drag, clamp } from './h.js';
import { showPopup, contextMenu } from './menu.js';
import { formDialog } from './forms.js';
import { promptText } from './dialog.js';
import * as E from '../core/audio-edit.js';
import { EFFECTS } from '../core/effects/index.js';
import { clampParam } from '../core/schema.js';
import { encodeWav, downloadBlob } from '../host/export/wav.js';

const RULER = 22;
const REGION_COLORS = ['#4aaedc', '#7fdc5c', '#e062a8', '#b968d6', '#4cc3a6', '#e8894a'];
const MAX_HISTORY = 40;
let clipboard = null;                       // { rate, channels } shared by all editor windows
let counter = 0;

export const fmtTime = (sec) => {
  if (!Number.isFinite(sec)) return '–';
  const m = Math.floor(sec / 60), s = sec - m * 60;
  return `${m}:${s.toFixed(3).padStart(6, '0')}`;
};
const fmtDb = (v) => (Number.isFinite(v) ? `${v.toFixed(1)} dB` : '−∞');

export function openAudioEditor(app, opts = {}) {
  const id = `audioedit:${++counter}`;
  app.wm.open(id, { title: 'Audio editor', dynamic: true, rect: { x: 130, y: 80, w: 980, h: 580 }, minW: 560, minH: 340, create: (win) => createAudioEditor(win, app, opts) });
  return id;
}

class AudioEditor {
  constructor(win, app, opts) {
    this.win = win; this.app = app; this.store = app.store;
    this.src = { chId: opts.chId ?? null, sampleId: opts.sampleId ?? null };
    this.name = opts.name || 'Untitled';
    this.buf = E.emptyBuf(app.host.sampleRate, 1, 0);
    this.hist = []; this.pos = -1; this.savedPos = -1;
    this.sel = null; this.cursor = 0;
    this.regions = [];
    this.view = { start: 0, spp: 100 };
    this.zeroSnap = false; this.loop = false; this.showSpec = false; this.fitted = true;
    this.peaks = null; this.rev = 0; this.abuf = null; this.abufRev = -1;
    this.playing = null; this.recording = false;
    this.dirty = true; this.specDirty = true; this.specTimer = 0;
    this.W = 800; this.H = 240;
    this.build();
    this.updateInfo(); this.updateTitle();
    this.raf = requestAnimationFrame(() => this.loopFrame());
    this.keyHook = (e) => this.key(e);
    app.keyHooks.add(this.keyHook);
    this.ro = new ResizeObserver(() => this.layout());
    this.ro.observe(this.wrap);
    if (opts.buf) this.setInitial(opts.buf, opts.name);
    else if (opts.sampleId) this.loadSample(opts.sampleId, opts.name);
  }

  // ------------------------------------------------------------------ buffer and history
  setInitial(buf, name) {
    if (name) this.name = name;
    this.buf = buf; this.hist = [buf]; this.pos = 0; this.savedPos = 0;
    this.sel = null; this.cursor = 0; this.regions = [];
    this.bufChanged(); this.fitAll();
  }

  async loadSample(id, name) {
    const e = await this.app.bank.ensure(id);
    if (!e) { this.app.toast('That sample is not available'); return; }
    this.setInitial({ rate: e.rate, channels: e.channels.map((c) => c.slice()) }, name || e.name);
  }

  get frames() { return E.frames(this.buf); }

  commit(buf, label, sel = undefined, regions = undefined) {
    this.stopPlayback();
    this.hist = this.hist.slice(0, this.pos + 1);
    this.hist.push(buf);
    if (this.hist.length > MAX_HISTORY) { this.hist.shift(); this.savedPos--; }
    this.pos = this.hist.length - 1;
    this.buf = buf;
    if (sel !== undefined) this.sel = sel;
    if (regions !== undefined) this.regions = regions;
    this.cursor = clamp(this.cursor, 0, this.frames);
    this.lastLabel = label;
    this.bufChanged();
  }

  undo() { if (this.pos > 0) { this.stopPlayback(); this.pos--; this.buf = this.hist[this.pos]; this.afterHistory(); } }
  redo() { if (this.pos < this.hist.length - 1) { this.stopPlayback(); this.pos++; this.buf = this.hist[this.pos]; this.afterHistory(); } }
  afterHistory() {
    const n = this.frames;
    if (this.sel) { this.sel = { a: clamp(this.sel.a, 0, n), b: clamp(this.sel.b, 0, n) }; if (this.sel.b <= this.sel.a) this.sel = null; }
    this.cursor = clamp(this.cursor, 0, n);
    this.regions = this.regions.filter((r) => r.a < n).map((r) => ({ ...r, b: Math.min(r.b, n) }));
    this.bufChanged();
  }

  bufChanged() {
    this.rev++;
    this.peaks = this.frames ? new E.Peaks(this.buf.channels) : null;
    this.dirty = true; this.specDirty = true;
    this.view.start = clamp(this.view.start, 0, Math.max(0, this.frames - 1));
    if (this.fitted) this.view = { start: 0, spp: this.maxSpp() };            // a view that shows everything keeps showing everything
    this.updateTitle(); this.updateInfo();
  }

  updateTitle() { this.win.setTitle(`${this.pos !== this.savedPos ? '• ' : ''}${this.name}`, 'Audio editor'); }

  // ------------------------------------------------------------------ geometry
  xOf(frame) { return (frame - this.view.start) / this.view.spp; }
  frameAt(x) { return this.view.start + x * this.view.spp; }
  visibleEnd() { return this.view.start + this.W * this.view.spp; }
  minSpp() { return 0.05; }
  maxSpp() { return Math.max(1, this.frames / Math.max(1, this.W)); }

  fitAll() { this.fitted = true; this.view = { start: 0, spp: this.maxSpp() }; this.dirty = true; this.specDirty = true; this.updateScroll(); }
  fitSel() { if (!this.sel) return this.fitAll(); this.fitted = false; this.view = { start: this.sel.a, spp: Math.max(this.minSpp(), (this.sel.b - this.sel.a) / this.W) }; this.dirty = true; this.specDirty = true; this.updateScroll(); }

  zoom(factor, anchorX = this.W / 2) {
    const f = this.frameAt(anchorX), spp = clamp(this.view.spp / factor, this.minSpp(), this.maxSpp());
    this.fitted = spp >= this.maxSpp() - 1e-9;
    this.view.spp = spp; this.view.start = f - anchorX * spp;
    this.clampView(); this.dirty = true; this.specDirty = true; this.updateScroll();
  }
  clampView() {
    const span = this.W * this.view.spp;
    this.view.start = clamp(this.view.start, 0, Math.max(0, this.frames - span));
    if (span >= this.frames) this.view.start = 0;
  }
  scrollBy(px) { this.fitted = false; this.view.start += px * this.view.spp; this.clampView(); this.dirty = true; this.specDirty = true; this.updateScroll(); }

  // ------------------------------------------------------------------ DOM
  build() {
    const btn = (label, hint, fn, cls = '') => h('div.btn' + cls, { hint, onclick: fn }, label);
    const menuBtn = (label, hint, items) => h('div.btn', { hint, onclick: (e) => { const r = e.currentTarget.getBoundingClientRect(); showPopup(items(), r.left, r.bottom, r); } }, `${label} ▾`);
    this.playBtn = btn('▶', 'Play the selection (or from the cursor). Space', () => this.togglePlay());
    this.loopBtn = btn('⟲', 'Loop the selection while playing', () => { this.loop = !this.loop; this.loopBtn.classList.toggle('on', this.loop); this.restart(); }, '.sm');
    this.recBtn = btn('●', 'Record from the audio input into the cursor position (or over the selection). Click again to stop', () => this.toggleRecord(), '.rec');
    this.zeroBtn = btn('Z', 'Snap selection edges to zero crossings (avoids clicks when cutting)', () => { this.zeroSnap = !this.zeroSnap; this.zeroBtn.classList.toggle('on', this.zeroSnap); }, '.sm');
    this.specBtn = btn('Spectrogram', 'Show a spectrogram of the visible part below the waveform', () => { this.showSpec = !this.showSpec; this.specBtn.classList.toggle('on', this.showSpec); this.specWrap.style.display = this.showSpec ? '' : 'none'; this.layout(); this.specDirty = true; }, '.sm');
    this.selInfo = h('span.lcd', { style: { cursor: 'default', fontSize: '11px', minWidth: '280px' } }, '');
    this.head = h('div.rack-head.ae-tools',
      this.playBtn, this.loopBtn, this.recBtn, h('span.dim', '|'),
      menuBtn('Edit', 'Cut, copy, paste, delete, trim, select', () => this.editItems()),
      menuBtn('Process', 'Normalize, fades, reverse, stretch and more on the selection', () => this.processItems()),
      menuBtn('Effects', 'Run any mixer effect over the selection', () => this.effectItems()),
      menuBtn('Regions', 'Markers inside the sample: detect, add, slice', () => this.regionItems()),
      menuBtn('Send', 'Put the result into the project, the Browser or a file', () => this.sendItems()),
      h('div.grow'), this.zeroBtn,
      btn('−', 'Zoom out', () => this.zoom(0.5), '.sm'), btn('＋', 'Zoom in', () => this.zoom(2), '.sm'),
      btn('Sel', 'Zoom to the selection', () => this.fitSel(), '.sm'), btn('All', 'Show the whole sample', () => this.fitAll(), '.sm'), this.specBtn);
    this.canvas = h('canvas.ae-wave', { width: 800, height: 240, tabindex: 0, style: { display: 'block', width: '100%', height: '100%', background: '#0e1012', outline: 0 } });
    this.wrap = h('div.ae-wrap', { style: { flex: 1, minHeight: '120px', position: 'relative' } }, this.canvas);
    this.scroll = h('div.ae-scroll', { style: { height: '14px', flex: 'none', background: '#15181a', position: 'relative', borderTop: '1px solid #000' } }, this.thumb = h('div.ae-thumb', { style: { position: 'absolute', top: '2px', height: '10px', background: '#4b545b', borderRadius: '3px', minWidth: '12px' } }));
    this.spec = h('canvas', { width: 800, height: 150, style: { display: 'block', width: '100%', height: '150px', background: '#000' } });
    this.specWrap = h('div', { style: { display: 'none', flex: 'none' } }, this.spec);
    this.status = h('div.ae-status', { style: { flex: 'none', padding: '3px 10px', background: 'var(--bg2)', borderTop: '1px solid var(--line)', fontSize: '11px', color: '#9aa4ad', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, '');
    this.el = h('div.rack', this.head, this.wrap, this.scroll, this.specWrap, h('div.rack-head', { style: { padding: '2px 8px' } }, this.selInfo, h('div.grow')), this.status);
    this.canvas.addEventListener('pointerdown', (e) => this.down(e));
    this.canvas.addEventListener('wheel', (e) => this.wheel(e), { passive: false });
    this.canvas.addEventListener('dblclick', (e) => this.dbl(e));
    this.canvas.addEventListener('contextmenu', (e) => { e.preventDefault(); this.ctxMenu(e); });
    this.canvas.addEventListener('pointermove', (e) => this.hover(e));
    this.thumb.addEventListener('pointerdown', (e) => this.thumbDown(e));
    this.scroll.addEventListener('pointerdown', (e) => { if (e.target === this.scroll) { const r = this.scroll.getBoundingClientRect(); this.view.start = ((e.clientX - r.left) / r.width) * this.frames - (this.W * this.view.spp) / 2; this.clampView(); this.dirty = true; this.specDirty = true; this.updateScroll(); } });
  }

  layout() {
    const r = this.wrap.getBoundingClientRect();
    const W = Math.max(200, Math.floor(r.width)), H = Math.max(80, Math.floor(r.height));
    if (W !== this.W || H !== this.H) {
      const keep = this.view.spp >= this.maxSpp() - 1e-9;
      this.W = W; this.H = H; this.canvas.width = W; this.canvas.height = H;
      if (keep) this.view.spp = this.maxSpp(); else this.view.spp = clamp(this.view.spp, this.minSpp(), this.maxSpp());
      this.clampView(); this.dirty = true; this.specDirty = true; this.updateScroll();
    }
    if (this.showSpec) { const w = Math.max(200, Math.floor(this.specWrap.getBoundingClientRect().width)); if (this.spec.width !== w) { this.spec.width = w; this.specDirty = true; } }
  }

  updateScroll() {
    const n = Math.max(1, this.frames), span = Math.min(n, this.W * this.view.spp), r = this.scroll.clientWidth || this.W;
    this.thumb.style.left = `${(this.view.start / n) * r}px`; this.thumb.style.width = `${Math.max(12, (span / n) * r)}px`;
  }

  thumbDown(e) {
    e.stopPropagation();
    const s0 = this.view.start, r = this.scroll.clientWidth || this.W;
    drag(e, (dx) => { this.view.start = s0 + (dx / r) * this.frames; this.clampView(); this.dirty = true; this.specDirty = true; this.updateScroll(); });
  }

  // ------------------------------------------------------------------ interaction
  snapFrame(f, dir = 0) { f = clamp(Math.round(f), 0, this.frames); return this.zeroSnap && this.frames ? E.findZeroCrossing(this.buf, f) : f; }

  edgeAt(x) {
    if (!this.sel) return null;
    const xa = this.xOf(this.sel.a), xb = this.xOf(this.sel.b);
    if (Math.abs(x - xa) <= 5) return 'a';
    if (Math.abs(x - xb) <= 5) return 'b';
    return null;
  }

  hover(e) {
    const r = this.canvas.getBoundingClientRect();
    this.canvas.style.cursor = this.edgeAt(e.clientX - r.left) ? 'ew-resize' : 'text';
  }

  down(e) {
    this.canvas.focus();
    const r = this.canvas.getBoundingClientRect(), x0 = e.clientX - r.left;
    if (e.button === 1) { e.preventDefault(); const s0 = this.view.start; drag(e, (dx) => { this.view.start = s0 - dx * this.view.spp; this.clampView(); this.dirty = true; this.specDirty = true; this.updateScroll(); }); return; }
    if (e.button !== 0 || !this.frames) return;
    const edge = this.edgeAt(x0);
    if (edge) {
      const fixed = edge === 'a' ? this.sel.b : this.sel.a;
      drag(e, (dx, dy, ev) => { this.setSel(fixed, this.frameAt(ev.clientX - r.left)); }, () => this.finishSel());
      return;
    }
    const f0 = this.frameAt(x0);
    if (e.shiftKey && (this.sel || this.cursor !== null)) {
      const anchor = this.sel ? (Math.abs(f0 - this.sel.a) < Math.abs(f0 - this.sel.b) ? this.sel.b : this.sel.a) : this.cursor;
      this.setSel(anchor, f0); drag(e, (dx, dy, ev) => this.setSel(anchor, this.frameAt(ev.clientX - r.left)), () => this.finishSel()); return;
    }
    let moved = false;
    this.cursor = clamp(Math.round(f0), 0, this.frames); this.sel = null; this.dirty = true; this.updateInfo();
    drag(e, (dx, dy, ev) => {
      if (!moved && Math.abs(dx) < 3) return;
      moved = true;
      const f = this.frameAt(ev.clientX - r.left);
      this.setSel(f0, f);
      // dragging past the edges scrolls
      const x = ev.clientX - r.left;
      if (x < 0) this.scrollBy(x / 4); else if (x > this.W) this.scrollBy((x - this.W) / 4);
    }, () => { if (moved) this.finishSel(); else this.restart(); });
  }

  setSel(a, b) {
    a = clamp(Math.round(a), 0, this.frames); b = clamp(Math.round(b), 0, this.frames);
    if (a === b) { this.sel = null; this.cursor = a; } else this.sel = { a: Math.min(a, b), b: Math.max(a, b) };
    this.dirty = true; this.updateInfo();
  }
  finishSel() {
    if (this.sel && this.zeroSnap) this.sel = { a: this.snapFrame(this.sel.a), b: this.snapFrame(this.sel.b) };
    if (this.sel && this.sel.b <= this.sel.a) this.sel = null;
    if (this.sel) this.cursor = this.sel.a;
    this.dirty = true; this.specDirty = true; this.updateInfo();
  }

  dbl(e) {
    const r = this.canvas.getBoundingClientRect(), f = this.frameAt(e.clientX - r.left);
    const reg = this.regions.find((q) => f >= q.a && f < q.b);
    if (reg && !this.sel) { this.sel = { a: reg.a, b: reg.b }; this.cursor = reg.a; } else this.selectAll();
    this.dirty = true; this.updateInfo();
  }

  wheel(e) {
    e.preventDefault();
    const r = this.canvas.getBoundingClientRect();
    if (e.shiftKey) this.scrollBy(e.deltaY > 0 ? 80 : -80);
    else this.zoom(e.deltaY < 0 ? 1.25 : 0.8, e.clientX - r.left);
  }

  selectAll() { if (this.frames) { this.sel = { a: 0, b: this.frames }; this.cursor = 0; this.dirty = true; this.updateInfo(); } }
  // the range an operation works on: the selection, otherwise everything
  target() { return this.sel ? [this.sel.a, this.sel.b] : [0, this.frames]; }

  key(e) {
    if (!this.win.open || !this.win.el.classList.contains('active')) return false;
    if (e.target && ['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName)) return false;
    const mod = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
    if (mod && k === 'z' && !e.shiftKey) { this.undo(); return true; }
    if (mod && (k === 'y' || (k === 'z' && e.shiftKey))) { this.redo(); return true; }
    if (mod && k === 'x') { this.cut(); return true; }
    if (mod && k === 'c') { this.copy(); return true; }
    if (mod && k === 'v') { this.paste(); return true; }
    if (mod && k === 'a') { this.selectAll(); return true; }
    if (mod) return false;
    if (e.key === ' ') { this.togglePlay(); return true; }
    if (e.key === 'Delete' || e.key === 'Backspace') { this.deleteSel(); return true; }
    if (e.key === 'Home') { this.cursor = 0; this.view.start = 0; this.dirty = true; this.updateScroll(); return true; }
    if (e.key === 'End') { this.cursor = this.frames; this.dirty = true; return true; }
    if (e.key === '+' || e.key === '=') { this.zoom(2); return true; }
    if (e.key === '-') { this.zoom(0.5); return true; }
    return false;
  }

  // ------------------------------------------------------------------ editing
  needSel(msg = 'Select a part of the sample first') { if (!this.sel) { this.app.toast(msg); return false; } return true; }

  copy() { if (!this.needSel('Select what to copy')) return; clipboard = E.slice(this.buf, this.sel.a, this.sel.b); this.app.toast(`Copied ${fmtTime(E.seconds(clipboard))}`); }
  cut() { if (!this.needSel('Select what to cut')) return; clipboard = E.slice(this.buf, this.sel.a, this.sel.b); const a = this.sel.a; this.commit(E.deleteRange(this.buf, a, this.sel.b), 'Cut', null, this.shiftRegions(a, this.sel.b)); this.cursor = a; this.dirty = true; this.updateInfo(); }
  deleteSel() { if (!this.needSel('Select what to delete')) return; const { a, b } = this.sel; this.commit(E.deleteRange(this.buf, a, b), 'Delete', null, this.shiftRegions(a, b)); this.cursor = a; this.dirty = true; this.updateInfo(); }
  paste(mode = 'insert', clip = clipboard) {
    if (!clip) { this.app.toast('The clipboard is empty'); return; }
    const empty = this.frames === 0;
    if (empty) { this.buf = E.emptyBuf(clip.rate, clip.channels.length, 0); this.hist[this.pos] = this.buf; }     // an empty editor takes the format of what is pasted
    const a = this.sel ? this.sel.a : this.cursor;
    const nb = this.sel && mode === 'insert' ? E.replaceRange(this.buf, this.sel.a, this.sel.b, clip) : E.insert(this.buf, a, clip, mode);
    const added = E.frames(E.conform(clip, this.buf.rate, this.buf.channels.length));
    this.commit(nb, 'Paste', { a, b: Math.min(E.frames(nb), a + added) });
    if (empty) this.fitAll();
    this.cursor = a; this.dirty = true; this.updateInfo();
  }
  shiftRegions(a, b) { const d = b - a; return this.regions.map((r) => ({ ...r, a: r.a >= b ? r.a - d : Math.min(r.a, a), b: r.b >= b ? r.b - d : Math.min(r.b, a) })).filter((r) => r.b > r.a); }
  trimToSel() { if (!this.needSel('Select the part to keep')) return; const { a, b } = this.sel; this.commit(E.trim(this.buf, a, b), 'Trim', null, this.regions.map((r) => ({ ...r, a: Math.max(0, r.a - a), b: Math.min(b - a, r.b - a) })).filter((r) => r.b > r.a)); this.cursor = 0; this.fitAll(); this.updateInfo(); }

  op(label, fn, { keepSel = true } = {}) {
    if (!this.frames) { this.app.toast('The sample is empty'); return; }
    const [a, b] = this.target();
    const sel = this.sel;
    this.commit(fn(this.buf, a, b), label, keepSel ? sel : null);
    this.dirty = true; this.updateInfo();
  }

  editItems() {
    const has = !!this.sel;
    return [
      { label: 'Undo', key: 'Ctrl+Z', disabled: this.pos <= 0, fn: () => this.undo() },
      { label: 'Redo', key: 'Ctrl+Y', disabled: this.pos >= this.hist.length - 1, fn: () => this.redo() },
      { sep: true },
      { label: 'Cut', key: 'Ctrl+X', disabled: !has, fn: () => this.cut() },
      { label: 'Copy', key: 'Ctrl+C', disabled: !has, fn: () => this.copy() },
      { label: 'Paste (insert)', key: 'Ctrl+V', disabled: !clipboard, fn: () => this.paste('insert') },
      { label: 'Paste (mix with the audio underneath)', disabled: !clipboard, fn: () => this.paste('mix') },
      { label: 'Paste (overwrite)', disabled: !clipboard, fn: () => this.paste('overwrite') },
      { label: 'Delete', key: 'Del', disabled: !has, fn: () => this.deleteSel() },
      { label: 'Trim to selection', disabled: !has, fn: () => this.trimToSel() },
      { sep: true },
      { label: 'Select all', key: 'Ctrl+A', fn: () => this.selectAll() },
      { label: 'Select nothing', fn: () => { this.sel = null; this.dirty = true; this.updateInfo(); } },
      { label: 'Revert to the original', disabled: this.pos === 0 && this.hist.length === 1, fn: () => { this.stopPlayback(); this.pos = 0; this.buf = this.hist[0]; this.hist = [this.hist[0]]; this.savedPos = 0; this.afterHistory(); } },
    ];
  }

  async withForm(title, fields, fn, opts) { const v = await formDialog(title, fields, opts); if (v) fn(v); }

  processItems() {
    const scope = this.sel ? 'selection' : 'whole sample';
    return [
      { title: `Applies to the ${scope}` },
      { label: 'Normalize…', fn: () => this.withForm('Normalize', [{ id: 'peak', label: 'Peak level', type: 'range', min: -24, max: 0, step: 0.1, value: 0, unit: ' dB' }], (v) => this.op('Normalize', (b, x, y) => E.normalize(b, x, y, v.peak))) },
      { label: 'Gain…', fn: () => this.withForm('Gain', [{ id: 'db', label: 'Gain', type: 'range', min: -36, max: 24, step: 0.1, value: 0, unit: ' dB' }], (v) => this.op('Gain', (b, x, y) => E.gain(b, x, y, v.db))) },
      { label: 'Fade in', submenu: ['linear', 'exp', 'log', 'scurve'].map((s) => ({ label: { linear: 'Linear', exp: 'Slow start', log: 'Fast start', scurve: 'S-curve' }[s], fn: () => this.op('Fade in', (b, x, y) => E.fade(b, x, y, 'in', s)) })) },
      { label: 'Fade out', submenu: ['linear', 'exp', 'log', 'scurve'].map((s) => ({ label: { linear: 'Linear', exp: 'Slow start', log: 'Fast start', scurve: 'S-curve' }[s], fn: () => this.op('Fade out', (b, x, y) => E.fade(b, x, y, 'out', s)) })) },
      { label: 'Reverse', fn: () => this.op('Reverse', E.reverse) },
      { label: 'Invert polarity', fn: () => this.op('Invert', E.invert) },
      { label: 'Remove DC offset', fn: () => this.op('Remove DC', E.dcRemove) },
      { label: 'Silence', fn: () => this.op('Silence', E.silence) },
      { sep: true },
      { label: 'Trim silence at the ends…', fn: () => this.withForm('Trim silence', [{ id: 'th', label: 'Threshold', type: 'range', min: -90, max: -20, step: 1, value: -60, unit: ' dB' }], (v) => { const r = E.audibleRange(this.buf, v.th); if (!r) { this.app.toast('Nothing above that level'); return; } this.commit(E.slice(this.buf, r[0], r[1]), 'Trim silence', null, []); this.cursor = 0; this.fitAll(); this.updateInfo(); }) },
      { label: 'Insert silence…', fn: () => this.withForm('Insert silence', [{ id: 'ms', label: 'Length', type: 'number', min: 1, max: 600000, step: 1, value: 500, unit: ' ms' }], (v) => { const at = this.sel ? this.sel.a : this.cursor; this.commit(E.insertSilence(this.buf, at, (v.ms / 1000) * this.buf.rate), 'Insert silence', null); this.dirty = true; this.updateInfo(); }) },
      { sep: true },
      { label: 'Time-stretch / pitch-shift…', fn: () => this.stretchDialog() },
      { label: 'Detect tempo', fn: () => this.detectTempo() },
      { label: 'Stretch to the project tempo…', fn: () => this.fitTempoDialog() },
      { label: 'Resample…', fn: () => this.withForm('Change the sample rate', [{ id: 'rate', label: 'New rate', type: 'select', value: this.buf.rate, options: [8000, 11025, 16000, 22050, 32000, 44100, 48000, 88200, 96000].map((r) => [r, `${r} Hz`]) }], (v) => { if (v.rate === this.buf.rate) return; this.commit(E.resample(this.buf, v.rate), 'Resample', null, []); this.cursor = 0; this.fitAll(); this.updateInfo(); }) },
      { label: 'Seamless loop (cross-fade)…', disabled: !this.sel, fn: () => this.withForm('Loop cross-fade', [{ id: 'ms', label: 'Cross-fade', type: 'range', min: 5, max: 1000, step: 5, value: 80, unit: ' ms' }], (v) => this.op('Loop cross-fade', (b, x, y) => E.loopCrossfade(b, x, y, (v.ms / 1000) * b.rate))) },
      { sep: true },
      { label: 'Make mono', disabled: this.buf.channels.length === 1, fn: () => { this.commit(E.toMono(this.buf), 'Make mono'); this.updateInfo(); } },
      { label: 'Make stereo', disabled: this.buf.channels.length === 2, fn: () => { this.commit(E.toStereo(this.buf), 'Make stereo'); this.updateInfo(); } },
      { label: 'Swap left and right', disabled: this.buf.channels.length === 1, fn: () => { this.commit(E.swapChannels(this.buf), 'Swap channels'); } },
    ];
  }

  async detectTempo() {
    if (!this.frames) return null;
    const { detectTempo } = await import('../core/tempo-detect.js');
    const [a, b] = this.target();
    const r = detectTempo(this.buf.channels.map((c) => c.subarray(a, b)), this.buf.rate);
    this.tempo = r.bpm || null;
    this.app.toast(r.bpm ? `Tempo: ${r.bpm} BPM${r.beats ? ` (${r.beats} beats)` : ''}${r.confidence < 0.3 ? ', not sure' : ''}. Half/double: ${Math.round(r.bpm * 50) / 100} / ${Math.round(r.bpm * 200) / 100}` : 'No steady beat found');
    this.updateInfo();
    return r;
  }

  async fitTempoDialog() {
    if (!this.frames) return;
    const { detectTempo, nearestOctave } = await import('../core/tempo-detect.js');
    const T = this.app.store.project.tempo;
    const [a, b] = this.target();
    const r = detectTempo(this.buf.channels.map((c) => c.subarray(a, b)), this.buf.rate);
    const guess = r.bpm ? Math.round(nearestOctave(r.bpm, T) * 100) / 100 : T;
    this.withForm('Stretch to the project tempo', [
      { id: 'bpm', label: 'Tempo of the audio', type: 'number', min: 20, max: 400, step: 0.01, value: guess, hint: r.bpm ? `Detected ${r.bpm} BPM` : 'No steady beat found: type the tempo' },
    ], (v) => {
      const ratio = v.bpm / T;
      if (Math.abs(ratio - 1) < 1e-4) return;
      const out = E.stretchRange(this.buf, a, b, { ratio, semitones: 0 });
      this.commit(out, `Stretch ${v.bpm} → ${T} BPM`, this.sel ? { a, b: Math.min(E.frames(out), a + Math.round((b - a) * ratio)) } : null, []);
      if (!this.sel) this.fitAll();
      this.updateInfo();
    }, { ok: `Stretch to ${T} BPM` });
  }

  stretchDialog() {
    if (!this.frames) return;
    const [a, b] = this.target(), len = (b - a) / this.buf.rate;
    this.withForm('Time-stretch / pitch-shift', [
      { id: 'pct', label: 'Length', type: 'range', min: 25, max: 400, step: 1, value: 100, unit: ' %', hint: 'New length in percent of the current length (200 % = twice as long and half the speed)' },
      { id: 'st', label: 'Pitch', type: 'range', min: -24, max: 24, step: 1, value: 0, unit: ' st' },
    ], (v) => {
      if (v.pct === 100 && v.st === 0) return;
      const r = E.stretchRange(this.buf, a, b, { ratio: v.pct / 100, semitones: v.st });
      const nb = a + Math.round((b - a) * (v.pct / 100));
      this.commit(r, 'Stretch / pitch', this.sel ? { a, b: Math.min(E.frames(r), nb) } : null, []);
      if (!this.sel) this.fitAll();
      this.updateInfo();
    }, { ok: `Apply to ${fmtTime(len)}` });
  }

  effectItems() {
    const cats = {};
    for (const [id, m] of Object.entries(EFFECTS)) (cats[m.meta.category || 'Other'] = cats[m.meta.category || 'Other'] || []).push({ label: m.meta.name, fn: () => this.effectDialog(id) });
    return [{ title: `Applies to the ${this.sel ? 'selection' : 'whole sample'}` }, ...Object.entries(cats).map(([c, list]) => ({ label: c, submenu: list }))];
  }

  effectDialog(type) {
    if (!this.frames) { this.app.toast('The sample is empty'); return; }
    const mod = EFFECTS[type];
    const fields = mod.schema.map((d) => {
      if (d.options) return { id: d.id, label: d.name, type: 'select', value: d.def, options: d.options.map((o, i) => [i, o]) };
      if (d.bool) return { id: d.id, label: d.name, type: 'check', value: !!d.def };
      return { id: d.id, label: d.name, type: 'range', min: d.min, max: d.max, step: d.int ? 1 : Math.max((d.max - d.min) / 400, 1e-4), value: d.def, unit: d.unit ? ` ${d.unit}` : '' };
    });
    fields.push({ id: '_tail', label: 'Tail (let it ring out)', type: 'range', min: 0, max: 10, step: 0.1, value: ['reverb', 'delay', 'convolver'].includes(type) ? 2 : 0, unit: ' s' });
    this.withForm(mod.meta.name, fields, (v) => {
      const params = {};
      for (const d of mod.schema) params[d.id] = clampParam(d, typeof v[d.id] === 'boolean' ? (v[d.id] ? 1 : 0) : v[d.id]);
      const [a, b] = this.target();
      const out = E.applyEffect(this.buf, a, b, type, params, { tail: v._tail, tempo: this.store.project.tempo });
      const added = E.frames(out) - this.frames;
      this.commit(out, mod.meta.name, this.sel ? { a, b: b + added } : null, this.regions);
      this.dirty = true; this.updateInfo();
    }, { ok: 'Apply', width: 430, scroll: true });
  }

  regionItems() {
    return [
      { label: 'Add region from the selection', disabled: !this.sel, fn: () => { this.regions = [...this.regions, { a: this.sel.a, b: this.sel.b, name: `Region ${this.regions.length + 1}` }].sort((p, q) => p.a - q.a); this.dirty = true; this.updateInfo(); } },
      { label: 'Detect regions at the hits…', fn: () => this.withForm('Detect regions', [{ id: 'sens', label: 'Sensitivity', type: 'range', min: 0, max: 1, step: 0.05, value: 0.5 }, { id: 'gap', label: 'Minimum gap', type: 'range', min: 20, max: 500, step: 5, value: 70, unit: ' ms' }], (v) => {
        const regs = E.detectRegions(this.buf, { sensitivity: v.sens, minGapMs: v.gap });
        this.regions = regs.map((r, i) => ({ ...r, name: `Region ${i + 1}` })); this.dirty = true; this.app.toast(`${regs.length} regions`); this.updateInfo();
      }) },
      { label: 'Split into equal parts…', fn: () => this.withForm('Equal regions', [{ id: 'n', label: 'Parts', type: 'number', min: 2, max: 64, step: 1, value: 8 }], (v) => { const n = this.frames; this.regions = Array.from({ length: v.n }, (_, i) => ({ a: Math.round((i * n) / v.n), b: Math.round(((i + 1) * n) / v.n), name: `Region ${i + 1}` })); this.dirty = true; this.updateInfo(); }) },
      { label: 'Select the region at the cursor', disabled: !this.regions.length, fn: () => { const r = this.regions.find((q) => this.cursor >= q.a && this.cursor < q.b); if (r) { this.sel = { a: r.a, b: r.b }; this.dirty = true; this.updateInfo(); } } },
      { sep: true },
      { label: 'Clear all regions', disabled: !this.regions.length, fn: () => { this.regions = []; this.dirty = true; this.updateInfo(); } },
    ];
  }

  ctxMenu(e) {
    const r = this.canvas.getBoundingClientRect(), f = this.frameAt(e.clientX - r.left);
    const reg = this.regions.find((q) => f >= q.a && f < q.b);
    const items = [...this.editItems().slice(3, 10)];
    if (reg) items.push({ sep: true }, { title: reg.name },
      { label: 'Select this region', fn: () => { this.sel = { a: reg.a, b: reg.b }; this.dirty = true; this.updateInfo(); } },
      { label: 'Rename…', fn: async () => { const n = await promptText('Rename region', 'Name', reg.name); if (n) { reg.name = n.slice(0, 24); this.dirty = true; } } },
      { label: 'Delete region', fn: () => { this.regions = this.regions.filter((q) => q !== reg); this.dirty = true; this.updateInfo(); } });
    contextMenu(e, items);
  }

  // ------------------------------------------------------------------ playback (a private preview, it does not go through the mixer)
  audioBuffer() {
    if (this.abuf && this.abufRev === this.rev) return this.abuf;
    const ctx = this.app.host.ctx, ab = ctx.createBuffer(this.buf.channels.length, Math.max(1, this.frames), clamp(this.buf.rate, 8000, 96000));
    this.buf.channels.forEach((c, i) => { if (c.length) ab.copyToChannel(c, i); });
    this.abuf = ab; this.abufRev = this.rev;
    return ab;
  }

  togglePlay() {
    if (this.playing) { this.stopPlayback(); return; }
    if (!this.frames) return;
    const ctx = this.app.host.ctx;
    if (ctx.state === 'suspended') ctx.resume();
    const a = this.sel ? this.sel.a : this.cursor >= this.frames ? 0 : this.cursor, b = this.sel ? this.sel.b : this.frames;
    const src = ctx.createBufferSource();
    src.buffer = this.audioBuffer(); src.connect(ctx.destination);
    const rate = this.audioBuffer().sampleRate, k = rate / this.buf.rate;
    if (this.loop && this.sel) { src.loop = true; src.loopStart = (a * k) / rate; src.loopEnd = (b * k) / rate; src.start(0, (a * k) / rate); } else src.start(0, (a * k) / rate, ((b - a) * k) / rate);
    const p = { src, t0: ctx.currentTime, a, b, loop: src.loop };
    src.onended = () => { if (this.playing === p) { this.playing = null; this.playBtn.textContent = '▶'; this.dirty = true; } };
    this.playing = p; this.playBtn.textContent = '■';
  }

  restart() { if (this.playing) { this.stopPlayback(); this.togglePlay(); } }

  stopPlayback() {
    if (!this.playing) return;
    const p = this.playing; this.playing = null;
    try { p.src.onended = null; p.src.stop(); } catch (_) { /* already finished */ }
    this.playBtn.textContent = '▶'; this.dirty = true;
  }

  playhead() {
    const p = this.playing;
    if (!p) return null;
    const dt = (this.app.host.ctx.currentTime - p.t0) * this.buf.rate;
    return p.loop ? p.a + (dt % Math.max(1, p.b - p.a)) : p.a + dt;
  }

  // ------------------------------------------------------------------ recording
  async toggleRecord() {
    const rec = this.app.audioRec && this.app.audioRec.recorder;
    if (!rec) { this.app.toast('Recording is not available'); return; }
    if (this.recording) {
      this.recording = false; this.recBtn.classList.remove('on');
      const take = await rec.stop();
      if (!take || !take.channels[0].length) return;
      const clip = { rate: take.rate, channels: take.channels.length === 2 && take.channels[1].some((v, i) => v !== take.channels[0][i]) ? take.channels : [take.channels[0]] };
      if (!this.frames) { this.setInitial(clip, 'Recording'); this.name = `Recording ${new Date().toLocaleTimeString()}`; this.updateTitle(); return; }
      this.paste('insert', clip);
      return;
    }
    if (this.app.audioRec.recording) { this.app.toast('The transport is already recording'); return; }
    this.stopPlayback();
    try { await rec.start({}); this.recording = true; this.recBtn.classList.add('on'); this.app.toast('Recording… click ● again to stop'); }
    catch (err) { this.app.toast(err && err.name === 'NotAllowedError' ? 'Microphone permission was denied' : `Could not open the audio input: ${err.message || err}`); }
  }

  // ------------------------------------------------------------------ send
  entry(name = this.name) {
    const pcm = this.buf.channels.map((c) => c.slice());
    return this.app.bank.addPCM(name, this.buf.rate, pcm);
  }

  sendItems() {
    const app = this.app, cmd = app.cmd, store = this.store;
    const ok = this.frames > 0;
    const nm = () => (this.name.replace(/^• /, '') || 'Edited sample');
    const chSource = this.src.chId !== null && store.channel(this.src.chId);
    return [
      { label: chSource ? `Replace the sample of "${chSource.name}"` : 'Replace the sample of the source channel', disabled: !ok || !chSource, fn: () => { const e = this.entry(`${nm()} (edited)`); cmd.setChannelSample(store, this.src.chId, { id: e.id, name: e.name }); this.markSaved(); app.toast('Sample replaced'); } },
      { label: 'New sampler channel', disabled: !ok, fn: () => { const e = this.entry(); const ch = cmd.addChannel(store, 'sampler', { name: e.name, sample: { id: e.id, name: e.name } }); app.openChannelEditor && app.openChannelEditor(ch.id); this.markSaved(); } },
      { label: 'New audio clip source (draw it in the Playlist)', disabled: !ok, fn: () => { const e = this.entry(); cmd.addAudioChannel(store, { id: e.id, name: e.name }); this.markSaved(); app.toast(`Added audio clip source "${e.name}"`); } },
      { label: 'Slicer channel from the regions', disabled: !ok || !this.regions.length, fn: () => { const e = this.entry(); const ch = cmd.addChannel(store, 'slicer', { name: e.name, sample: { id: e.id, name: e.name }, slices: this.regions.map((r) => r.a) }); app.openChannelEditor && app.openChannelEditor(ch.id); this.markSaved(); } },
      { sep: true },
      { label: 'Save to the Browser (Recorded)', disabled: !ok, fn: async () => { const e = this.entry(); if (app.library) await app.library.save('recorded', e.name, { id: e.id }); this.markSaved(); app.toast(`Saved "${e.name}" in Browser → Recorded`); } },
      { label: 'Export as WAV…', submenu: [16, 24, 32].map((bits) => ({ label: `${bits}-bit${bits === 32 ? ' float' : ''}`, disabled: !ok, fn: () => this.exportWav(bits) })) },
    ];
  }

  exportWav(bits) {
    const l = this.buf.channels[0], r = this.buf.channels[1] || l;
    const bytes = encodeWav(l, r, this.buf.rate, { bits, channels: this.buf.channels.length });
    (this.app.exportSink || downloadBlob)(bytes, `${this.name.replace(/^• /, '').replace(/[^\w\- ]+/g, '_')}.wav`, 'audio/wav');
  }

  markSaved() { this.savedPos = this.pos; this.updateTitle(); }

  // ------------------------------------------------------------------ painting
  updateInfo() {
    const b = this.buf, n = this.frames;
    const [a, z] = this.target();
    const st = n ? E.stats(b, a, z) : null;
    this.selInfo.textContent = this.sel
      ? `Sel ${fmtTime(this.sel.a / b.rate)} → ${fmtTime(this.sel.b / b.rate)}  ·  ${fmtTime((this.sel.b - this.sel.a) / b.rate)}`
      : `Cursor ${fmtTime(this.cursor / b.rate)}  ·  Length ${fmtTime(n / b.rate)}`;
    this.status.textContent = n
      ? `${b.rate} Hz · ${b.channels.length === 2 ? 'stereo' : 'mono'} · ${n} frames · ${this.sel ? 'selection' : 'whole'}: peak ${fmtDb(st.peakDb)} · RMS ${fmtDb(st.rmsDb)} · DC ${st.dc.toFixed(4)}${this.tempo ? ` · ${this.tempo} BPM` : ''} · ${this.regions.length} regions · undo steps ${this.pos}`
      : 'Empty. Record with ●, paste from the clipboard, or send a sample here from the Browser, the Sampler or the Playlist';
    this.dirty = true;
  }

  loopFrame() {
    if (!this.win.open && !this.win.el.isConnected) return;
    if (this.dirty || this.playing || this.recording) { this.paint(); this.dirty = false; }
    if (this.showSpec && this.specDirty && !this.specTimer) this.specTimer = setTimeout(() => { this.specTimer = 0; this.paintSpec(); }, 90);
    this.raf = requestAnimationFrame(() => this.loopFrame());
  }

  rulerStep() {
    const target = 90 * this.view.spp / this.buf.rate;           // seconds between labels for ~90 px
    const steps = [0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
    return steps.find((s) => s >= target) || 600;
  }

  paint() {
    const c = this.canvas.getContext('2d'), W = this.canvas.width, H = this.canvas.height;
    c.fillStyle = '#0e1012'; c.fillRect(0, 0, W, H);
    c.fillStyle = '#1a1e21'; c.fillRect(0, 0, W, RULER);
    c.font = '10px sans-serif';
    const rate = this.buf.rate, step = this.rulerStep();
    const t0 = Math.floor(this.frameAt(0) / rate / step) * step;
    c.fillStyle = '#7d8890'; c.strokeStyle = '#2c3338';
    for (let t = t0; t * rate < this.visibleEnd() + 1; t += step) {
      const x = Math.round(this.xOf(t * rate)) + 0.5;
      if (x < 0) continue;
      c.beginPath(); c.moveTo(x, RULER - 6); c.lineTo(x, H); c.stroke();
      c.fillText(fmtTime(t).replace(/\.000$/, ''), x + 3, 12);
    }
    const lanes = this.buf.channels.length, laneH = (H - RULER) / lanes;
    if (!this.frames) { c.fillStyle = '#5b666e'; c.font = '12px sans-serif'; c.fillText('Empty — record (●), paste (Ctrl+V) or send a sample here', 20, RULER + 40); return; }
    // regions
    this.regions.forEach((r, i) => {
      const xa = this.xOf(r.a), xb = this.xOf(r.b);
      if (xb < 0 || xa > W) return;
      c.fillStyle = REGION_COLORS[i % REGION_COLORS.length] + '22'; c.fillRect(xa, RULER, xb - xa, H - RULER);
      c.fillStyle = REGION_COLORS[i % REGION_COLORS.length]; c.fillRect(xa, RULER, 1, H - RULER); c.fillRect(xa, RULER - 2, Math.min(xb - xa, 70), 2);
      c.font = '10px sans-serif'; c.fillText(r.name || '', Math.max(xa, 0) + 3, RULER + 11);
    });
    // waveform
    for (let k = 0; k < lanes; k++) {
      const y0 = RULER + k * laneH, mid = y0 + laneH / 2, amp = laneH / 2 - 3;
      c.fillStyle = '#1b2024'; c.fillRect(0, Math.round(mid), W, 1);
      if (k) { c.fillStyle = '#000'; c.fillRect(0, Math.round(y0), W, 1); }
      c.fillStyle = '#ffb02e'; c.strokeStyle = '#ffb02e';
      if (this.view.spp >= 1) {
        const col = this.peaks.columns(k, this.view.start, this.visibleEnd(), W);
        for (let x = 0; x < W; x++) { const mn = col[x * 2], mx = col[x * 2 + 1]; c.fillRect(x, mid - mx * amp, 1, Math.max(1, (mx - mn) * amp)); }
      } else {
        const d = this.buf.channels[k], i0 = Math.max(0, Math.floor(this.view.start) - 1), i1 = Math.min(d.length, Math.ceil(this.visibleEnd()) + 1);
        c.beginPath();
        for (let i = i0; i < i1; i++) { const x = this.xOf(i), y = mid - d[i] * amp; if (i === i0) c.moveTo(x, y); else c.lineTo(x, y); }
        c.stroke();
        if (this.view.spp < 0.25) for (let i = i0; i < i1; i++) c.fillRect(this.xOf(i) - 2, mid - d[i] * amp - 2, 4, 4);
      }
    }
    // selection, cursor, play head
    if (this.sel) {
      const xa = this.xOf(this.sel.a), xb = this.xOf(this.sel.b);
      c.fillStyle = 'rgba(255,176,46,.22)'; c.fillRect(xa, RULER, xb - xa, H - RULER);
      c.fillStyle = '#ffb02e'; c.fillRect(Math.round(xa), RULER, 1, H - RULER); c.fillRect(Math.round(xb) - 1, RULER, 1, H - RULER);
    } else {
      const x = Math.round(this.xOf(this.cursor)) + 0.5;
      c.strokeStyle = '#fff'; c.beginPath(); c.moveTo(x, RULER); c.lineTo(x, H); c.stroke();
    }
    const ph = this.playhead();
    if (ph !== null) { const x = Math.round(this.xOf(ph)) + 0.5; c.strokeStyle = '#7fdc5c'; c.beginPath(); c.moveTo(x, 0); c.lineTo(x, H); c.stroke(); }
    if (this.recording) { c.fillStyle = '#e35d5d'; c.beginPath(); c.arc(W - 16, RULER + 14, 6, 0, 7); c.fill(); }
  }

  paintSpec() {
    if (!this.showSpec || !this.frames) return;
    this.specDirty = false;
    const cv = this.spec, c = cv.getContext('2d'), W = cv.width, H = cv.height;
    const a = Math.max(0, Math.floor(this.view.start)), b = Math.min(this.frames, Math.ceil(this.visibleEnd()));
    if (b - a < 64) { c.fillStyle = '#000'; c.fillRect(0, 0, W, H); return; }
    const cols = Math.min(W, 600), sp = E.spectrogram(this.buf, a, b, { size: 1024, columns: cols });
    const img = c.createImageData(cols, H), nyq = this.buf.rate / 2, lo = 40;
    for (let y = 0; y < H; y++) {
      const f = lo * Math.pow(nyq / lo, 1 - y / (H - 1)), bin = Math.min(sp.bins - 1, Math.round((f / nyq) * sp.bins));
      for (let x = 0; x < cols; x++) {
        const t = clamp((sp.data[x * sp.bins + bin] + 100) / 90, 0, 1), o = (y * cols + x) * 4;
        img.data[o] = Math.round(255 * clamp(t * 2.2 - 0.3, 0, 1)); img.data[o + 1] = Math.round(255 * clamp(t * 1.6 - 0.6, 0, 1)); img.data[o + 2] = Math.round(255 * clamp(t < 0.5 ? t * 1.6 : 1.2 - t, 0, 1)); img.data[o + 3] = 255;
      }
    }
    const tmp = document.createElement('canvas'); tmp.width = cols; tmp.height = H; tmp.getContext('2d').putImageData(img, 0, 0);
    c.imageSmoothingEnabled = true; c.drawImage(tmp, 0, 0, W, H);
    c.fillStyle = 'rgba(255,255,255,.7)'; c.font = '10px sans-serif';
    for (const f of [100, 1000, 5000, 10000]) { if (f >= nyq) continue; const y = Math.round((1 - Math.log(f / lo) / Math.log(nyq / lo)) * (H - 1)); c.fillRect(0, y, 6, 1); c.fillText(f >= 1000 ? `${f / 1000}k` : String(f), 9, y + 3); }
  }

  destroy() {
    this.stopPlayback();
    cancelAnimationFrame(this.raf); clearTimeout(this.specTimer);
    this.ro.disconnect();
    this.app.keyHooks.delete(this.keyHook);
    if (this.recording) { this.app.audioRec.recorder.stop().catch(() => {}); this.recording = false; }
    if (this.app.audioEditors) delete this.app.audioEditors[this.win.id];
  }
}

function createAudioEditor(win, app, opts) {
  const ed = new AudioEditor(win, app, opts);
  (app.audioEditors || (app.audioEditors = {}))[win.id] = ed;
  return { el: ed.el, onResize: () => ed.layout(), onShow: () => requestAnimationFrame(() => { ed.layout(); if (ed.frames) ed.fitAll(); }), destroy: () => ed.destroy() };
}
