// Piano roll: canvas note editor for the selected channel in the current pattern.
// Tools: Draw / Paint / Paint repeat / Delete / Mute / Slice / Select / Zoom / Playback.
import { h, drag, clamp, clear } from './h.js';
import { contextMenu, showPopup } from './menu.js';
import { PPQ, STEP, KEY_MAX, keyName, isBlackKey } from '../core/constants.js';
import { patternLength, barTicks, COLORS } from '../core/project.js';
import { SCALES, CHORDS, SCALE_BY_ID, inScale, snapToScale, chordKeys, diatonicChord, identifyChord } from '../core/scales.js';
import { NOTE_NAMES } from '../core/constants.js';
import { icon } from './icons.js';
import { toolsMenu, openTool } from './piano-roll-tools.js';

const KEYS_W = 64, RULER_H = 22, MINI_H = 28, EDGE = 6;
export const NOTE_COLORS = ['', ...COLORS.slice(0, 15)];

export const LANES = {
  vel: { name: 'Velocity', min: 1, max: 127, def: null, get: (n) => n.v, set: (n, v) => { n.v = v; } },
  pan: { name: 'Panning', min: -64, max: 64, def: 0, get: (n) => n.pan || 0, set: (n, v) => { if (v) n.pan = v; else delete n.pan; } },
  rel: { name: 'Release', min: 0, max: 127, def: 64, get: (n) => (n.rel === undefined ? 64 : n.rel), set: (n, v) => { if (v === 64) delete n.rel; else n.rel = v; } },
  fine: { name: 'Fine pitch', min: -120, max: 120, def: 0, get: (n) => n.fine || 0, set: (n, v) => { if (v) n.fine = v; else delete n.fine; } },
  mx: { name: 'Mod X', min: 0, max: 255, def: 128, get: (n) => (n.mx === undefined ? 128 : n.mx), set: (n, v) => { if (v === 128) delete n.mx; else n.mx = v; } },
  my: { name: 'Mod Y', min: 0, max: 255, def: 128, get: (n) => (n.my === undefined ? 128 : n.my), set: (n, v) => { if (v === 128) delete n.my; else n.my = v; } },
};

const TOOLS = [
  ['draw', 'P', 'Draw — click to add a note, drag to move, drag an edge to resize, right-click deletes', 'pencil'],
  ['paint', 'B', 'Paint — drag to paint a run of notes, one per grid cell', 'brush'],
  ['paintrepeat', '', 'Paint repeat — drag to repeat the note length back to back', 'repeat'],
  ['delete', 'D', 'Delete — click or drag over notes to remove them', 'trash'],
  ['mute', 'T', 'Mute — click or drag to mute / unmute notes', 'mute'],
  ['slice', 'C', 'Slice — drag a line across notes to cut them', 'slice'],
  ['select', 'E', 'Select — drag a rectangle to select notes (Shift adds)', 'select'],
  ['zoom', 'Z', 'Zoom — drag a rectangle to zoom in, right-click to zoom out', 'zoom'],
  ['playback', 'Y', 'Playback — hold the mouse to play the pattern from that point', 'play'],
];

const STORE_KEY = 'stepwise.roll';
function loadPrefs() { try { return JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch (_) { return {}; } }
function savePrefs(o) { try { localStorage.setItem(STORE_KEY, JSON.stringify(o)); } catch (_) { /* private mode */ } }

export class PianoRoll {
  constructor(win, app) {
    this.win = win; this.app = app;
    const pr = loadPrefs();
    this.tool = 'draw';
    this.sel = new Set();
    this.view = { px: pr.px || 0.5, rowH: pr.rowH || 14, x0: 0, y0: 0 };
    this.scale = { root: pr.root || 0, id: pr.scale || 'chromatic', show: pr.show !== false, lock: !!pr.lock };
    this.ghost = pr.ghost !== false;
    this.chord = { on: false, id: pr.chord || 'maj', inv: 0 };
    this.stamp = null;                 // { keys:[relative semis], label } armed stamp
    this.lane = 'vel';
    this.laneH = 90;
    this.propsOpen = !!pr.props;
    this.lastLen = STEP;
    this.cursorT = 0;
    this.gesture = 0;
    this.hover = null;
    this.dirty = true;
    this.pressedKeys = new Set();
    this.build();
    this.centerOn(60);
    this.bind();
    this.ro = new ResizeObserver(() => this.layout());     // header wrapping or window resizes change the canvas area
    this.ro.observe(this.centerWrap);
  }

  get store() { return this.app.store; }
  get chId() { return this.store.selected; }
  get channel() { return this.store.channel(this.store.selected); }
  get pat() { return this.store.pattern; }
  get notes() { const c = this.channel; return c ? (this.pat.notes[c.id] || []) : []; }
  get isSound() { const c = this.channel; return !!c && c.type !== 'automation' && c.type !== 'layer' && c.type !== 'audio'; }
  get beatT() { return Math.round((PPQ * 4) / this.store.project.timeSig.den); }
  get barT() { return barTicks(this.store.project.timeSig); }
  get patLen() { return patternLength(this.store.project, this.pat); }
  get selNotes() { return this.notes.filter((n) => this.sel.has(n.id)); }

  // ------------------------------------------------------------------ layout
  build() {
    const app = this.app;
    this.toolBtns = {};
    const tools = h('div.seg');
    for (const [id, key, hint, ic] of TOOLS) {
      const b = h('div.btn', { dataset: { tool: id }, hint: `${hint}${key ? ` (${key})` : ''}`, onclick: () => this.setTool(id) }, icon(ic, 14));
      this.toolBtns[id] = b; tools.append(b);
    }
    this.snapInfo = h('span.dim', '');
    this.scaleRoot = h('select.select', { hint: 'Scale root', onchange: () => { this.scale.root = +this.scaleRoot.value; this.prefs(); this.invalidate(); } }, NOTE_NAMES.map((n, i) => h('option', { value: i }, n)));
    this.scaleSel = h('select.select', { hint: 'Scale — highlights the notes of the scale in the grid', onchange: () => { this.scale.id = this.scaleSel.value; this.prefs(); this.invalidate(); } }, SCALES.map((s) => h('option', { value: s.id }, s.name)));
    this.scaleRoot.value = String(this.scale.root); this.scaleSel.value = this.scale.id;
    this.lockBtn = h('div.btn.sm', { hint: 'Lock to scale — drawn and moved notes snap into the scale', onclick: () => { this.scale.lock = !this.scale.lock; this.prefs(); this.refreshBtns(); } }, 'Lock');
    this.hiBtn = h('div.btn.sm', { hint: 'Highlight scale keys in the grid', onclick: () => { this.scale.show = !this.scale.show; this.prefs(); this.refreshBtns(); this.invalidate(); } }, 'Show');
    this.ghostBtn = h('div.btn.sm', { hint: 'Ghost notes — show the other channels of this pattern faintly behind the notes', onclick: () => { this.ghost = !this.ghost; this.prefs(); this.refreshBtns(); this.invalidate(); } }, 'Ghost');
    this.chordBtn = h('div.btn.sm', { hint: 'Chord tool — every note you draw becomes the chosen chord', onclick: () => { this.chord.on = !this.chord.on; if (this.chord.on) this.stamp = null; this.refreshBtns(); } }, 'Chord');
    this.chordSel = h('select.select', { hint: 'Chord type for the chord tool', onchange: () => { this.chord.id = this.chordSel.value; this.prefs(); } }, CHORDS.map((c) => h('option', { value: c.id }, c.name)));
    this.chordSel.value = this.chord.id;
    this.invSel = h('select.select', { hint: 'Chord inversion', onchange: () => { this.chord.inv = +this.invSel.value; } }, [-2, -1, 0, 1, 2].map((i) => h('option', { value: i }, i === 0 ? 'Root pos.' : i > 0 ? `Inv +${i}` : `Inv ${i}`)));
    this.invSel.value = '0';
    this.stampBtn = h('div.btn.sm', { hint: 'Stamp — pick a chord or scale shape, then click in the grid to place it', onclick: (e) => this.stampMenu(e.currentTarget) }, 'Stamp ▾');
    this.slideBtn = h('div.btn.sm', { hint: 'Slide — selected notes glide from the previous note instead of retriggering (portamento)', onclick: () => this.toggleSlide() }, 'Slide');
    this.typingBtn = h('div.btn.sm', { hint: 'Typing keyboard to piano keyboard. Off: letter keys select tools (P B D T C E Z Y)', onclick: () => { app.typingPiano = !app.typingPiano; this.refreshBtns(); } }, '⌨');
    this.toolsBtn = h('div.btn.sm', { hint: 'Tools — quantize, chop, glue, flip, randomize, limit, strum, arpeggiate, articulate, claw machine, riff machine…', onclick: (e) => { const r = e.currentTarget.getBoundingClientRect(); showPopup(toolsMenu(this), r.left, r.bottom, r); } }, icon('wrench', 13), 'Tools ▾');
    this.propsBtn = h('div.btn.sm', { hint: 'Note properties panel', onclick: () => { this.propsOpen = !this.propsOpen; this.prefs(); this.refreshBtns(); this.layout(); } }, 'Props');
    this.zoomX = h('input', { type: 'range', min: 0, max: 100, style: { width: '70px', accentColor: 'var(--accent)' }, hint: 'Horizontal zoom (Ctrl + wheel)' });
    this.zoomY = h('input', { type: 'range', min: 0, max: 100, style: { width: '56px', accentColor: 'var(--accent)' }, hint: 'Vertical zoom (Alt + wheel)' });
    this.zoomX.addEventListener('input', () => this.setZoomX(this.sliderToPx(+this.zoomX.value)));
    this.zoomY.addEventListener('input', () => this.setZoomY(6 + (+this.zoomY.value / 100) * 26));
    this.head = h('div.rack-head.pr-head', tools, this.snapInfo, h('div.pr-sep'),
      h('span.dim', 'Scale'), this.scaleRoot, this.scaleSel, this.hiBtn, this.lockBtn, h('div.pr-sep'),
      this.chordBtn, this.chordSel, this.invSel, this.stampBtn, h('div.pr-sep'),
      this.slideBtn, this.ghostBtn, this.toolsBtn, h('div.grow'), this.typingBtn, this.propsBtn, h('span.dim', '⇔'), this.zoomX, h('span.dim', '⇕'), this.zoomY);

    this.keys = h('canvas.pr-keys', { hint: 'Piano keys — click to audition' });
    this.ruler = h('canvas.pr-ruler', { hint: 'Click to set the play position. Drag the orange marker to change the pattern length' });
    this.grid = h('canvas.pr-grid');
    this.laneCv = h('canvas.pr-lane');
    this.mini = h('canvas.pr-mini', { hint: 'Overview — drag to scroll' });
    this.laneSel = h('select.select', { hint: 'Event editor — choose the note property shown below' }, Object.entries(LANES).map(([k, l]) => h('option', { value: k }, l.name)));
    this.laneSel.addEventListener('change', () => { this.lane = this.laneSel.value; this.invalidate(); });
    this.laneBar = h('div.pr-lanebar', h('span.dim', 'Event editor'), this.laneSel,
      h('div.btn.sm', { hint: 'Reset the property of the selected notes to its default', onclick: () => this.resetLane() }, 'Reset'),
      h('span.dim', { class: 'pr-lanehelp' }, 'Drag across the bars to paint values'));
    this.playhead = h('div.pr-playhead');
    this.empty = h('div.pr-empty', 'Select a channel with an instrument in the Channel rack to edit its notes.');
    this.hscroll = h('input.pr-hscroll', { type: 'range', min: 0, max: 1000, value: 0, hint: 'Scroll' });
    this.centerWrap = h('div.pr-center', this.ruler, this.grid, this.laneBar, this.laneCv, this.mini, this.playhead, this.empty);
    this.keysWrap = h('div.pr-keyswrap', this.keys);
    this.propsEl = h('div.pr-props');
    this.main = h('div.pr-main', this.keysWrap, this.centerWrap, this.propsEl);
    this.el = h('div.rack.pr', this.head, this.main);
    this.refreshBtns();
    this.buildProps();
  }

  prefs() {
    const o = loadPrefs();
    Object.assign(o, { px: this.view.px, rowH: this.view.rowH, root: this.scale.root, scale: this.scale.id, show: this.scale.show, lock: this.scale.lock, ghost: this.ghost, chord: this.chord.id, props: this.propsOpen });
    savePrefs(o);
  }

  refreshBtns() {
    for (const [id, b] of Object.entries(this.toolBtns)) b.classList.toggle('on', id === this.tool);
    this.lockBtn.classList.toggle('on', this.scale.lock);
    this.hiBtn.classList.toggle('on', this.scale.show);
    this.ghostBtn.classList.toggle('on', this.ghost);
    this.chordBtn.classList.toggle('on', this.chord.on);
    this.stampBtn.classList.toggle('on', !!this.stamp);
    this.typingBtn.classList.toggle('on', !!this.app.typingPiano);
    this.propsBtn.classList.toggle('on', this.propsOpen);
    this.propsEl.style.display = this.propsOpen ? '' : 'none';
    this.slideBtn.classList.toggle('on', this.selNotes.length > 0 && this.selNotes.every((n) => n.slide));
    this.grid.style.cursor = this.cursorFor(null);
  }

  setTool(id) { this.tool = id; this.stamp = null; this.refreshBtns(); this.invalidate(); }

  // canvas sizes from the container; called by the window manager on resize
  layout() {
    const W = this.centerWrap.clientWidth, H = this.centerWrap.clientHeight;
    if (!W || !H) return;
    const dpr = window.devicePixelRatio || 1;
    this.dpr = dpr;
    this.gridH = Math.max(40, H - RULER_H - this.laneH - 22 - MINI_H);
    const set = (cv, w, hh, top) => {
      cv.style.width = `${w}px`; cv.style.height = `${hh}px`; cv.style.top = `${top}px`;
      cv.width = Math.round(w * dpr); cv.height = Math.round(hh * dpr);
    };
    this.W = W;
    set(this.ruler, W, RULER_H, 0);
    set(this.grid, W, this.gridH, RULER_H);
    this.laneBar.style.top = `${RULER_H + this.gridH}px`;
    set(this.laneCv, W, this.laneH, RULER_H + this.gridH + 22);
    set(this.mini, W, MINI_H, RULER_H + this.gridH + 22 + this.laneH);
    this.keys.style.width = `${KEYS_W}px`; this.keys.style.height = `${this.gridH}px`; this.keys.style.top = `${RULER_H}px`;
    this.keys.width = Math.round(KEYS_W * dpr); this.keys.height = Math.round(this.gridH * dpr);
    this.clampView();
    this.invalidate();
  }

  onResize() { this.layout(); }
  onShow() { this.layout(); this.startLoop(); this.syncSelection(); }
  onHide() { this.stopLoop(); }
  destroy() { this.stopLoop(); if (this.ro) this.ro.disconnect(); for (const off of this.subs || []) off(); }

  // ------------------------------------------------------------------ view helpers
  tx(t) { return (t - this.view.x0) * this.view.px; }
  xt(x) { return x / this.view.px + this.view.x0; }
  ky(k) { return (KEY_MAX - k) * this.view.rowH - this.view.y0; }
  yk(y) { return KEY_MAX - Math.floor((y + this.view.y0) / this.view.rowH); }
  maxX0() { return Math.max(0, this.contentEnd() - (this.W - 20) / this.view.px * 0.5); }
  contentEnd() { return Math.max(this.patLen, ...this.notes.map((n) => n.s + n.l), 0) + this.barT * 2; }

  clampView() {
    const v = this.view;
    v.px = clamp(v.px, 0.04, 6); v.rowH = clamp(v.rowH, 6, 32);
    const totalH = (KEY_MAX + 1) * v.rowH;
    v.y0 = clamp(v.y0, 0, Math.max(0, totalH - (this.gridH || 300)));
    v.x0 = clamp(v.x0, 0, Math.max(this.barT * 64, this.contentEnd()));
  }

  centerOn(key) { this.view.y0 = (KEY_MAX - key) * this.view.rowH - (this.gridH || 300) / 2; this.clampView(); }
  sliderToPx(s) { return 0.04 * Math.pow(6 / 0.04, s / 100); }
  pxToSlider(px) { return (Math.log(px / 0.04) / Math.log(6 / 0.04)) * 100; }

  setZoomX(px, anchorX = this.W / 2) {
    const t = this.xt(anchorX);
    this.view.px = clamp(px, 0.04, 6);
    this.view.x0 = Math.max(0, t - anchorX / this.view.px);
    this.zoomX.value = String(this.pxToSlider(this.view.px));
    this.prefs(); this.clampView(); this.invalidate();
  }

  setZoomY(rowH, anchorY = (this.gridH || 300) / 2) {
    const k = (anchorY + this.view.y0) / this.view.rowH;
    this.view.rowH = clamp(rowH, 6, 32);
    this.view.y0 = k * this.view.rowH - anchorY;
    this.zoomY.value = String(((this.view.rowH - 6) / 26) * 100);
    this.prefs(); this.clampView(); this.invalidate();
  }

  snapTicks() { return this.app.snapTicks({ cell: STEP, line: this.lineTicks() }); }

  // the finest grid line spaced at least ~14px apart (the "Line" snap mode)
  lineTicks() {
    const cands = [this.barT * 4, this.barT * 2, this.barT, this.beatT, this.beatT / 2, STEP, STEP / 2, STEP / 4].map(Math.round);
    let best = cands[0];
    for (const c of cands) if (c * this.view.px >= 14) best = c;
    return Math.max(1, best);
  }

  snapT(t, ev) {
    if (ev && ev.altKey) return Math.round(t);
    const g = this.snapTicks();
    return Math.round(t / g) * g;
  }

  floorT(t, ev) {
    if (ev && ev.altKey) return Math.floor(t);
    const g = this.snapTicks();
    return Math.floor(t / g) * g;
  }

  // ------------------------------------------------------------------ drawing
  invalidate() { this.dirty = true; }

  startLoop() {
    if (this.raf) return;
    const loop = () => {
      this.raf = requestAnimationFrame(loop);
      this.frame();
    };
    this.raf = requestAnimationFrame(loop);
  }

  stopLoop() { if (this.raf) cancelAnimationFrame(this.raf); this.raf = 0; }

  frame() {
    const app = this.app, st = app.host.st;
    // typing-to-piano keys light up the keyboard
    const sig = [...app.held.values()].map((x) => x.note).join(',');
    if (sig !== this.heldSig) { this.heldSig = sig; this.dirty = true; }
    // play position
    let px = -1;
    if (st.playing || st.paused) {
      const tick = app.transport.displayTick();
      if (app.transport.mode === 'pat') px = tick % this.patLen;
      else {
        const clip = this.store.arrangement.clips.find((c) => c.type === 'pattern' && c.ref === this.pat.id && tick >= c.s && tick < c.s + c.l);
        if (clip) px = ((tick - clip.s + (clip.o || 0)) % this.patLen);
      }
    }
    if (px >= 0) {
      const x = this.tx(px);
      this.playhead.style.display = x >= 0 && x < this.W ? '' : 'none';
      this.playhead.style.transform = `translateX(${Math.round(x)}px)`;
      this.playhead.style.height = `${RULER_H + this.gridH + 22 + this.laneH}px`;
    } else this.playhead.style.display = 'none';
    if (!this.dirty) return;
    this.dirty = false;
    this.draw();
  }

  draw() {
    if (!this.W) return;
    this.empty.style.display = this.isSound ? 'none' : '';
    this.drawGrid(); this.drawKeys(); this.drawRuler(); this.drawLane(); this.drawMini();
  }

  noteColor(n, ch) { return n.c ? NOTE_COLORS[n.c] || ch.color : ch.color || '#e0b84a'; }

  drawGrid() {
    const cv = this.grid, ctx = cv.getContext('2d'), W = this.W, H = this.gridH, v = this.view, dpr = this.dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#25282b'; ctx.fillRect(0, 0, W, H);
    const kTop = clamp(this.yk(0), 0, KEY_MAX), kBot = clamp(this.yk(H), 0, KEY_MAX);
    const sc = this.scale, hl = sc.show && sc.id !== 'chromatic';
    for (let k = kTop; k >= kBot; k--) {
      const y = this.ky(k);
      let bg = isBlackKey(k) ? '#2b2f33' : '#343a3f';
      if (hl) {
        const ins = inScale(k, sc.root, sc.id), root = ((k - sc.root) % 12 + 12) % 12 === 0;
        bg = root ? '#4a4132' : ins ? (isBlackKey(k) ? '#3a3a35' : '#403f39') : '#23262a';
      }
      ctx.fillStyle = bg; ctx.fillRect(0, y, W, v.rowH);
      ctx.fillStyle = k % 12 === 0 ? 'rgba(255,255,255,.18)' : 'rgba(0,0,0,.28)';
      ctx.fillRect(0, y + v.rowH - 1, W, 1);
    }
    // vertical lines
    const g = this.snapTicks(), bar = this.barT, beat = this.beatT;
    const t0 = Math.max(0, Math.floor(v.x0)), t1 = this.xt(W);
    const sub = Math.max(1, Math.min(g, this.lineTicks()));
    const drawLines = (step, color) => {
      if (step * v.px < 5) return;
      ctx.fillStyle = color;
      for (let t = Math.ceil(t0 / step) * step; t <= t1; t += step) ctx.fillRect(Math.round(this.tx(t)), 0, 1, H);
    };
    drawLines(sub, 'rgba(255,255,255,.045)');
    drawLines(beat, 'rgba(255,255,255,.10)');
    drawLines(bar, 'rgba(255,255,255,.22)');
    // beyond the pattern end
    const endX = this.tx(this.patLen);
    if (endX < W) { ctx.fillStyle = 'rgba(0,0,0,.38)'; ctx.fillRect(Math.max(0, endX), 0, W - Math.max(0, endX), H); }
    ctx.fillStyle = 'rgba(255,176,46,.55)'; ctx.fillRect(Math.round(endX), 0, 1, H);

    const ch = this.channel;
    if (!ch || !this.isSound) return;
    // ghost notes of the other channels
    if (this.ghost) {
      ctx.globalAlpha = 0.2;
      for (const other of this.store.project.channels) {
        if (other.id === ch.id) continue;
        const list = this.pat.notes[other.id];
        if (!list) continue;
        ctx.fillStyle = other.color || '#888';
        for (const n of list) {
          const x = this.tx(n.s), w = Math.max(2, n.l * v.px);
          if (x + w < 0 || x > W) continue;
          const y = this.ky(n.k);
          if (y + v.rowH < 0 || y > H) continue;
          ctx.fillRect(x, y + 1, w - 1, v.rowH - 2);
        }
      }
      ctx.globalAlpha = 1;
    }
    // notes
    const notes = this.notes;
    const showLabel = v.rowH >= 11;
    ctx.font = '10px "Segoe UI", system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    let prev = null;
    for (const n of notes) {
      const x = this.tx(n.s), w = Math.max(3, n.l * v.px);
      if (x + w >= 0 && x <= W) {
        const y = this.ky(n.k);
        if (y + v.rowH >= 0 && y <= H) {
          const col = this.noteColor(n, ch), sel = this.sel.has(n.id);
          ctx.globalAlpha = n.mute ? 0.35 : 0.5 + 0.5 * (n.v / 127);
          ctx.fillStyle = n.mute ? '#8a9199' : col;
          if (n.slide) {
            ctx.beginPath();
            ctx.moveTo(x + Math.min(6, w / 2), y + 1); ctx.lineTo(x + w - 1, y + 1); ctx.lineTo(x + w - 1, y + v.rowH - 1); ctx.lineTo(x, y + v.rowH - 1);
            ctx.closePath(); ctx.fill();
          } else ctx.fillRect(x, y + 1, w - 1, v.rowH - 2);
          ctx.globalAlpha = 1;
          // top highlight + velocity bar at the start
          ctx.fillStyle = 'rgba(255,255,255,.28)'; ctx.fillRect(x, y + 1, w - 1, 1);
          ctx.fillStyle = 'rgba(0,0,0,.35)'; ctx.fillRect(x + w - 2, y + 1, 1, v.rowH - 2);
          if (sel) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.strokeRect(x + 0.5, y + 1.5, w - 2, v.rowH - 3); }
          if (showLabel && w > 26) {
            ctx.fillStyle = 'rgba(0,0,0,.75)';
            ctx.fillText(keyName(n.k), x + 4, y + v.rowH / 2 + 0.5);
          }
        }
      }
      if (n.slide && prev) {   // connector from the previous note
        const px = this.tx(prev.s + prev.l), py = this.ky(prev.k) + v.rowH / 2, nx = this.tx(n.s), ny = this.ky(n.k) + v.rowH / 2;
        ctx.strokeStyle = 'rgba(255,255,255,.55)'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(nx, ny); ctx.stroke();
      }
      prev = n;
    }
    // overlays
    const o = this.overlay;
    if (o) {
      if (o.type === 'rect') {
        const x = Math.min(o.x0, o.x1), y = Math.min(o.y0, o.y1), w = Math.abs(o.x1 - o.x0), hh = Math.abs(o.y1 - o.y0);
        ctx.fillStyle = 'rgba(255,176,46,.14)'; ctx.fillRect(x, y, w, hh);
        ctx.strokeStyle = 'rgba(255,176,46,.9)'; ctx.lineWidth = 1; ctx.strokeRect(x + 0.5, y + 0.5, w, hh);
      } else if (o.type === 'line') {
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.setLineDash([4, 3]); ctx.beginPath(); ctx.moveTo(o.x0, o.y0); ctx.lineTo(o.x1, o.y1); ctx.stroke(); ctx.setLineDash([]);
      }
    }
    // placement preview
    const hv = this.hover;
    if (hv && (this.tool === 'draw' || this.tool === 'paint' || this.tool === 'paintrepeat') && !this.dragging) {
      const keys = this.stamp ? this.stamp.keys.map((s) => hv.k + s) : this.chord.on ? chordKeys(hv.k, this.chord.id, { inversion: this.chord.inv }) : [hv.k];
      const len = this.tool === 'paint' ? this.snapTicks() : this.lastLen;
      ctx.strokeStyle = 'rgba(255,255,255,.55)'; ctx.lineWidth = 1;
      for (const k of keys) ctx.strokeRect(this.tx(hv.t) + 0.5, this.ky(k) + 1.5, Math.max(3, len * v.px) - 2, v.rowH - 3);
    }
  }

  drawKeys() {
    const ctx = this.keys.getContext('2d'), H = this.gridH, v = this.view, dpr = this.dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#1b1d20'; ctx.fillRect(0, 0, KEYS_W, H);
    const kTop = clamp(this.yk(0), 0, KEY_MAX), kBot = clamp(this.yk(H), 0, KEY_MAX);
    const held = new Set([...this.app.held.values()].map((x) => x.note));
    const sc = this.scale, hl = sc.show && sc.id !== 'chromatic';
    ctx.font = '9px "Segoe UI", system-ui, sans-serif'; ctx.textBaseline = 'middle';
    for (let k = kTop; k >= kBot; k--) {
      const y = this.ky(k), pressed = this.pressedKeys.has(k) || held.has(k), black = isBlackKey(k);
      ctx.fillStyle = pressed ? '#ffb02e' : '#d9dde0'; ctx.fillRect(0, y, KEYS_W, v.rowH);
      if (black) { ctx.fillStyle = pressed ? '#e09a1f' : '#2a2d31'; ctx.fillRect(0, y + 0.5, KEYS_W * 0.62, v.rowH - 1); }
      ctx.fillStyle = '#7d848a'; ctx.fillRect(black ? KEYS_W * 0.62 : 0, y + v.rowH - 1, black ? KEYS_W * 0.38 : KEYS_W, 1);
      if (!black && (k % 12 === 0 || v.rowH >= 17)) { ctx.fillStyle = '#3a3f44'; ctx.fillText(keyName(k), KEYS_W - 22, y + v.rowH / 2); }
      if (hl && inScale(k, sc.root, sc.id)) { ctx.fillStyle = ((k - sc.root) % 12 + 12) % 12 === 0 ? '#e0861a' : '#8f9aa3'; ctx.beginPath(); ctx.arc(KEYS_W - 6, y + v.rowH / 2, 2, 0, 6.283); ctx.fill(); }
    }
    ctx.fillStyle = '#000'; ctx.fillRect(KEYS_W - 1, 0, 1, H);
  }

  drawRuler() {
    const ctx = this.ruler.getContext('2d'), W = this.W, v = this.view, dpr = this.dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#2f3438'; ctx.fillRect(0, 0, W, RULER_H);
    const bar = this.barT, beat = this.beatT;
    const t0 = Math.max(0, v.x0), t1 = this.xt(W);
    ctx.font = '10px "Segoe UI", system-ui, sans-serif'; ctx.textBaseline = 'middle';
    for (let t = Math.floor(t0 / beat) * beat; t <= t1; t += beat) {
      const x = Math.round(this.tx(t)), isBar = t % bar === 0;
      ctx.fillStyle = isBar ? '#8e989f' : '#5f686f';
      ctx.fillRect(x, isBar ? 0 : RULER_H - 7, 1, isBar ? RULER_H : 7);
      if (isBar && (bar * v.px >= 28)) { ctx.fillStyle = '#d5dce0'; ctx.fillText(String(t / bar + 1), x + 4, 8); }
      else if (!isBar && beat * v.px >= 26) { ctx.fillStyle = '#7d868d'; ctx.fillText(`${Math.floor((t % bar) / beat) + 1}`, x + 3, RULER_H - 6); }
    }
    // pattern length marker
    const ex = this.tx(this.patLen);
    ctx.fillStyle = '#ffb02e';
    ctx.beginPath(); ctx.moveTo(ex - 7, 0); ctx.lineTo(ex, 0); ctx.lineTo(ex, 11); ctx.closePath(); ctx.fill();
    ctx.fillRect(ex, 0, 1, RULER_H);
    ctx.fillStyle = '#000'; ctx.fillRect(0, RULER_H - 1, W, 1);
  }

  drawLane() {
    const ctx = this.laneCv.getContext('2d'), W = this.W, H = this.laneH, dpr = this.dpr, v = this.view;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#212427'; ctx.fillRect(0, 0, W, H);
    const bar = this.barT, beat = this.beatT;
    const t0 = Math.max(0, v.x0), t1 = this.xt(W);
    for (let t = Math.floor(t0 / beat) * beat; t <= t1; t += beat) { ctx.fillStyle = t % bar === 0 ? 'rgba(255,255,255,.16)' : 'rgba(255,255,255,.06)'; ctx.fillRect(Math.round(this.tx(t)), 0, 1, H); }
    const L = LANES[this.lane];
    const bip = L.min < 0, zeroY = bip ? H / 2 : H - 2;
    ctx.fillStyle = 'rgba(255,255,255,.12)'; ctx.fillRect(0, Math.round(bip ? H / 2 : (L.def === null ? H : this.valY(L, L.def))), W, 1);
    const ch = this.channel;
    if (!ch || !this.isSound) return;
    for (const n of this.notes) {
      const x = Math.round(this.tx(n.s));
      if (x < -8 || x > W + 8) continue;
      const val = L.get(n), y = this.valY(L, val), sel = this.sel.has(n.id);
      const col = this.noteColor(n, ch);
      ctx.fillStyle = sel ? '#fff' : col;
      ctx.globalAlpha = sel ? 0.95 : 0.8;
      ctx.fillRect(x, Math.min(y, zeroY), 2, Math.abs(zeroY - y) + 1);
      ctx.beginPath(); ctx.arc(x + 1, y, 3.2, 0, 6.283); ctx.fill();
      ctx.globalAlpha = 1;
    }
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, 1);
  }

  valY(L, val) { const H = this.laneH; return 6 + (1 - (val - L.min) / (L.max - L.min)) * (H - 12); }
  yVal(L, y) { const H = this.laneH; return Math.round(L.min + (1 - clamp((y - 6) / (H - 12), 0, 1)) * (L.max - L.min)); }

  drawMini() {
    const ctx = this.mini.getContext('2d'), W = this.W, H = MINI_H, dpr = this.dpr, v = this.view;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#1a1c1f'; ctx.fillRect(0, 0, W, H);
    const total = this.contentEnd();
    const sx = (W - 4) / total;
    const ch = this.channel;
    if (ch && this.isSound) {
      ctx.fillStyle = 'rgba(255,255,255,.7)';
      for (const n of this.notes) ctx.fillRect(2 + n.s * sx, 2 + ((KEY_MAX - n.k) / KEY_MAX) * (H - 6), Math.max(1.5, n.l * sx), 2);
    }
    ctx.fillStyle = 'rgba(255,176,46,.55)'; ctx.fillRect(2 + this.patLen * sx, 0, 1, H);
    const vx = 2 + v.x0 * sx, vw = Math.max(8, (this.W / v.px) * sx);
    const ky0 = (v.y0 / ((KEY_MAX + 1) * v.rowH)) * (H - 4), kh = (this.gridH / ((KEY_MAX + 1) * v.rowH)) * (H - 4);
    ctx.strokeStyle = '#ffb02e'; ctx.lineWidth = 1; ctx.strokeRect(vx + 0.5, 1 + ky0 + 0.5, vw, Math.max(4, kh));
    ctx.fillStyle = 'rgba(255,176,46,.10)'; ctx.fillRect(vx, 1 + ky0, vw, Math.max(4, kh));
  }

  // ------------------------------------------------------------------ hit testing
  noteAt(x, y) {
    const v = this.view;
    const t = this.xt(x), k = this.yk(y);
    const notes = this.notes;
    let found = null;
    for (let i = notes.length - 1; i >= 0; i--) {
      const n = notes[i];
      if (n.k !== k || t < n.s - 1 / v.px || t > n.s + n.l + 1 / v.px) continue;
      found = n; break;
    }
    if (!found) return null;
    const left = this.tx(found.s), right = this.tx(found.s + found.l);
    const w = right - left;
    const edge = Math.min(EDGE, w / 3);
    const zone = x >= right - edge ? 'right' : x <= left + edge && w > 12 ? 'left' : 'body';
    return { note: found, zone };
  }

  cursorFor(hit) {
    switch (this.tool) {
      case 'draw': case 'select': case 'paint': case 'paintrepeat':
        if (hit && (hit.zone === 'left' || hit.zone === 'right')) return 'ew-resize';
        return hit ? 'grab' : this.tool === 'select' ? 'crosshair' : 'cell';
      case 'delete': return 'not-allowed';
      case 'slice': return 'crosshair';
      case 'zoom': return 'zoom-in';
      case 'playback': return 'pointer';
      default: return 'default';
    }
  }

  // ------------------------------------------------------------------ editing helpers
  constrainKey(k) {
    k = clamp(k, 0, KEY_MAX);
    return this.scale.lock && this.scale.id !== 'chromatic' ? clamp(snapToScale(k, this.scale.root, this.scale.id), 0, KEY_MAX) : k;
  }

  audition(key, vel = 100) { if (this.channel) this.app.preview(this.channel.id, key, vel); }

  setSel(ids) { this.sel = new Set(ids); this.syncSelection(); this.invalidate(); }

  // scroll so that the selection (or the given notes) is inside the viewport
  reveal(notes = this.selNotes) {
    if (!notes.length || !this.W) return;
    const v = this.view;
    let s = Infinity, e = -Infinity, lo = Infinity, hi = -Infinity;
    for (const n of notes) { s = Math.min(s, n.s); e = Math.max(e, n.s + n.l); lo = Math.min(lo, n.k); hi = Math.max(hi, n.k); }
    const viewT0 = v.x0, viewT1 = this.xt(this.W);
    if (s < viewT0 || e > viewT1) v.x0 = Math.max(0, s - this.beatT);
    const kTop = this.yk(0), kBot = this.yk(this.gridH);
    if (hi > kTop - 1 || lo < kBot + 1) this.centerOn((lo + hi) / 2);
    this.clampView(); this.invalidate();
  }

  syncSelection() { this.refreshBtns(); this.updateProps(); this.updateTitle(); }

  updateTitle() { const c = this.channel; this.win.setTitle('Piano roll', c ? `${c.name}  ·  ${this.pat.name}` : ''); }

  newGesture() { return `gesture:roll:${++this.gesture}`; }

  toggleSlide() {
    const ns = this.selNotes;
    if (!ns.length) return;
    const on = !ns.every((n) => n.slide);
    this.app.cmd.updateNotes(this.store, this.chId, [...this.sel], (n) => { if (on) n.slide = 1; else delete n.slide; }, on ? 'Slide notes' : 'Unslide notes');
  }

  deleteSelected() {
    if (!this.sel.size) return;
    this.app.cmd.deleteNotes(this.store, this.chId, [...this.sel]);
    this.sel.clear(); this.syncSelection();
  }

  // create the note(s) a click places: a single note, the chord, or the armed stamp
  placeAt(t, k, len, vel = 100, token = this.newGesture()) {
    const keys = this.stamp ? this.stamp.keys.map((s) => k + s) : this.chord.on ? chordKeys(k, this.chord.id, { inversion: this.chord.inv }) : [k];
    const partials = keys.filter((x) => x >= 0 && x <= KEY_MAX).map((x) => ({ s: Math.max(0, t), l: len, k: this.constrainKey(x), v: vel }));
    return this.app.cmd.addNotes(this.store, this.chId, partials, partials.length > 1 ? 'Add chord' : 'Add note', token);
  }

  // ------------------------------------------------------------------ pointer interaction
  bind() {
    const g = this.grid;
    g.addEventListener('pointerdown', (e) => this.gridDown(e));
    g.addEventListener('pointermove', (e) => this.gridHover(e));
    g.addEventListener('pointerleave', () => { this.hover = null; this.invalidate(); });
    g.addEventListener('contextmenu', (e) => e.preventDefault());
    g.addEventListener('wheel', (e) => this.wheel(e), { passive: false });
    g.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('application/x-stepwise-score') && this.isSound) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } });
    g.addEventListener('drop', (e) => {
      const v = e.dataTransfer.getData('application/x-stepwise-score');
      if (!v || !this.isSound) return;
      e.preventDefault(); e.stopPropagation();
      const { x } = this.local(e);
      const made = this.app.pasteScore(JSON.parse(v), this.chId, Math.max(0, this.floorT(this.xt(x), e)));
      this.setSel(made.map((n) => n.id));
    });
    this.keys.addEventListener('pointerdown', (e) => this.keysDown(e));
    this.keys.addEventListener('wheel', (e) => this.wheel(e), { passive: false });
    this.ruler.addEventListener('pointerdown', (e) => this.rulerDown(e));
    this.ruler.addEventListener('wheel', (e) => this.wheel(e), { passive: false });
    this.laneCv.addEventListener('pointerdown', (e) => this.laneDown(e));
    this.laneCv.addEventListener('wheel', (e) => this.wheel(e), { passive: false });
    this.mini.addEventListener('pointerdown', (e) => this.miniDown(e));
    const store = this.store;
    this.subs = [
      store.bus.on('change', ({ paths }) => {
        if (paths.some((p) => p[0] === 'patterns' || p[0] === 'channels' || p[0] === 'timeSig')) { this.prune(); this.invalidate(); this.updateProps(); }
      }),
      store.bus.on('selection', () => { this.sel.clear(); this.stamp = null; this.syncSelection(); this.invalidate(); }),
      store.bus.on('project', () => { this.sel.clear(); this.syncSelection(); this.layout(); }),
      store.bus.on('snap', () => this.invalidate()),
      store.bus.on('transport', () => this.invalidate()),
    ];
    this.zoomX.value = String(this.pxToSlider(this.view.px));
    this.zoomY.value = String(((this.view.rowH - 6) / 26) * 100);
  }

  prune() {
    if (!this.sel.size) return;
    const ids = new Set(this.notes.map((n) => n.id));
    let changed = false;
    for (const id of [...this.sel]) if (!ids.has(id)) { this.sel.delete(id); changed = true; }
    if (changed) this.refreshBtns();
  }

  local(e, cv = this.grid) { const r = cv.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }

  gridHover(e) {
    if (this.dragging) return;
    const { x, y } = this.local(e);
    const hit = this.noteAt(x, y);
    this.grid.style.cursor = this.cursorFor(hit);
    const t = this.floorT(this.xt(x), e), k = this.yk(y);
    this.hover = { t, k, hit };
    this.snapInfo.textContent = `${keyName(clamp(k, 0, KEY_MAX))}  ·  ${Math.floor(t / this.barT) + 1}:${Math.floor((t % this.barT) / this.beatT) + 1}`;
    this.invalidate();
  }

  wheel(e) {
    e.preventDefault();
    const d = e.deltaY;
    if (e.ctrlKey) {
      const { x } = this.local(e, this.grid);
      this.setZoomX(this.view.px * (d < 0 ? 1.15 : 1 / 1.15), x);
    } else if (e.altKey) {
      const { y } = this.local(e, this.grid);
      this.setZoomY(this.view.rowH * (d < 0 ? 1.1 : 1 / 1.1), y);
    } else if (e.shiftKey) {
      this.view.x0 += (d + e.deltaX) / this.view.px * 0.6; this.clampView(); this.invalidate();
    } else {
      this.view.y0 += d * 0.6; this.view.x0 += e.deltaX / this.view.px * 0.6; this.clampView(); this.invalidate();
    }
  }

  keysDown(e) {
    if (e.button !== 0 || !this.channel) return;
    const ch = this.channel.id;
    const keyAt = (ev) => clamp(this.yk(this.local(ev, this.keys).y), 0, KEY_MAX);
    let cur = keyAt(e);
    const host = this.app.host;
    host.resume();
    const on = (k) => { this.pressedKeys.add(k); host.send({ t: 'noteOn', ch, key: k, vel: 0.8 }); };
    const off = (k) => { this.pressedKeys.delete(k); host.send({ t: 'noteOff', ch, key: k }); };
    on(cur); this.invalidate();
    drag(e, (dx, dy, ev) => { const k = keyAt(ev); if (k !== cur) { off(cur); cur = k; on(cur); this.invalidate(); } }, () => { off(cur); this.invalidate(); });
  }

  rulerDown(e) {
    if (e.button !== 0) return;
    const { x } = this.local(e, this.ruler);
    // grab the pattern length marker
    if (Math.abs(x - this.tx(this.patLen)) < 9) {
      const startLen = this.patLen, startX = e.clientX;
      const token = this.newGesture();
      drag(e, (dx, dy, ev) => {
        const bt = this.beatT;
        let len = Math.max(bt, Math.round((startLen + dx / this.view.px) / (ev.altKey ? 1 : bt)) * (ev.altKey ? 1 : bt));
        if (!ev.altKey && len > this.barT) len = Math.round(len / this.barT) * this.barT || this.barT;
        this.store.edit('Pattern length', (p) => { this.pat.len = len; }, [['patterns', this.pat.id]], { coalesce: token });
        void startX;
      });
      return;
    }
    const seek = (ev) => { const t = Math.max(0, this.snapT(this.xt(this.local(ev, this.ruler).x), ev)); this.app.transport.seek(t); this.cursorT = t; this.invalidate(); };
    seek(e);
    drag(e, (dx, dy, ev) => seek(ev));
  }

  miniDown(e) {
    const move = (ev) => {
      const { x } = this.local(ev, this.mini);
      const total = this.contentEnd(), sx = (this.W - 4) / total;
      this.view.x0 = Math.max(0, (x - 2) / sx - this.W / this.view.px / 2);
      this.clampView(); this.invalidate();
    };
    move(e);
    drag(e, (dx, dy, ev) => move(ev));
  }

  gridDown(e) {
    this.grid.focus && this.grid.focus();
    if (!this.isSound) return;
    const { x, y } = this.local(e);
    const hit = this.noteAt(x, y);
    const t = this.xt(x), k = clamp(this.yk(y), 0, KEY_MAX);
    this.cursorT = Math.max(0, this.floorT(t, e));
    const right = e.button === 2;
    if (e.button !== 0 && !right) return;
    this.hover = null;
    if (right) { this.eraseDrag(e, hit); return; }
    switch (this.tool) {
      case 'draw': case 'select': case 'paint': case 'paintrepeat':
        if (hit) { this.noteDrag(e, hit); return; }
        if (this.tool === 'select') { this.rubberSelect(e); return; }
        if (this.tool === 'paint') { this.paintDrag(e); return; }
        if (this.tool === 'paintrepeat') { this.repeatDrag(e); return; }
        this.drawNew(e, t, k);
        return;
      case 'delete': this.eraseDrag(e, hit, true); return;
      case 'mute': this.muteDrag(e, hit); return;
      case 'slice': this.sliceDrag(e); return;
      case 'zoom': this.zoomDrag(e); return;
      case 'playback': this.playbackDrag(e); return;
      default:
    }
  }

  // click on empty space with the draw tool: place a note, then dragging moves it
  drawNew(e, t, k) {
    const ts = this.floorT(t, e), token = this.newGesture();
    const made = this.placeAt(ts, k, this.lastLen, 100, token);
    this.setSel(made.map((n) => n.id));
    this.audition(made[0].k, made[0].v);
    this.noteDrag(e, { note: made[0], zone: 'body' }, true, token);
  }

  // move / resize the selection by dragging one of its notes
  noteDrag(e, hit, fresh = false, gestureToken = null) {
    const cmd = this.app.cmd, store = this.store, chId = this.chId;
    const n0 = hit.note;
    if (!this.sel.has(n0.id)) { if (e.shiftKey) this.setSel([...this.sel, n0.id]); else this.setSel([n0.id]); }
    else if (e.shiftKey && !fresh) { this.sel.delete(n0.id); this.setSel([...this.sel]); return; }
    if (!fresh && !e.shiftKey) this.audition(n0.k, n0.v);
    const ids = [...this.sel];
    const orig = new Map(this.selNotes.map((n) => [n.id, { s: n.s, l: n.l, k: n.k }]));
    const o0 = orig.get(n0.id);
    const token = gestureToken || this.newGesture();
    const startX = e.clientX, startY = e.clientY;
    const zone = hit.zone;
    let moved = false, lastKey = n0.k, copied = false;
    const minS = Math.min(...[...orig.values()].map((o) => o.s));
    this.dragging = true;
    const r = this.grid.getBoundingClientRect();
    drag(e, (dx, dy, ev) => {
      const t = this.xt(ev.clientX - r.left);
      if (!moved && Math.abs(ev.clientX - startX) < 3 && Math.abs(ev.clientY - startY) < 3) return;
      if (!moved && ev.ctrlKey && zone === 'body' && !fresh) {
        // Ctrl+drag duplicates: the copies are what gets moved
        const clones = cmd.addNotes(store, chId, this.selNotes.map((n) => ({ ...n, id: undefined })), 'Copy notes', token);
        const map = new Map();
        const olds = [...orig.entries()];
        clones.forEach((c, i) => { map.set(c.id, olds[i][1]); });
        orig.clear(); for (const [id, o] of map) orig.set(id, o);
        ids.length = 0; ids.push(...clones.map((c) => c.id));
        this.setSel(ids); copied = true;
      }
      moved = true;
      if (zone === 'right') {
        const end = Math.max(o0.s + 1, this.snapT(t, ev));
        const dl = end - (o0.s + o0.l);
        cmd.updateNotes(store, chId, ids, (n) => { const o = orig.get(n.id); n.l = Math.max(1, o.l + dl); }, 'Resize notes', token);
        this.lastLen = Math.max(1, o0.l + dl);
      } else if (zone === 'left') {
        const ns = Math.min(o0.s + o0.l - 1, Math.max(0, this.snapT(t, ev)));
        const ds = ns - o0.s;
        cmd.updateNotes(store, chId, ids, (n) => { const o = orig.get(n.id); const s2 = Math.max(0, Math.min(o.s + o.l - 1, o.s + ds)); n.l = o.s + o.l - s2; n.s = s2; }, 'Resize notes', token);
      } else {
        const grabT = this.xt(startX - r.left) - o0.s;               // where inside the note we grabbed it
        let ns = this.snapT(t - grabT, ev);
        ns = Math.max(0, ns);
        let ds = ns - o0.s;
        ds = Math.max(ds, -minS);
        const k = this.yk(ev.clientY - r.top);
        const kMin = Math.min(...[...orig.values()].map((o) => o.k)), kMax = Math.max(...[...orig.values()].map((o) => o.k));
        let dk = clamp(k, 0, KEY_MAX) - o0.k;
        dk = clamp(dk, -kMin, KEY_MAX - kMax);
        cmd.updateNotes(store, chId, ids, (n) => {
          const o = orig.get(n.id);
          n.s = o.s + ds;
          n.k = this.constrainKey(o.k + dk);
        }, 'Move notes', token);
        const nk = this.notes.find((n) => n.id === n0.id);
        if (nk && nk.k !== lastKey) { lastKey = nk.k; this.audition(nk.k, nk.v); }
        if (fresh) { /* a fresh note keeps its length */ }
      }
    }, () => {
      this.dragging = false;
      if (!moved && fresh === false && zone === 'body' && !e.shiftKey && this.tool !== 'select') { /* plain click: selection only */ }
      if (moved && zone !== 'body') this.lastLen = Math.max(1, (this.notes.find((n) => n.id === n0.id) || { l: this.lastLen }).l);
      void copied;
      this.invalidate(); this.updateProps();
    });
  }

  eraseDrag(e, hit, leftButton = false) {
    const cmd = this.app.cmd, chId = this.chId;
    const removed = new Set(), token = this.newGesture();
    const r = this.grid.getBoundingClientRect();
    const kill = (ev) => {
      const h2 = this.noteAt(ev.clientX - r.left, ev.clientY - r.top);
      if (h2 && !removed.has(h2.note.id)) { removed.add(h2.note.id); this.sel.delete(h2.note.id); cmd.deleteNotes(this.store, chId, [h2.note.id], 'Delete notes', token); }
    };
    // all deletions of one drag are a single undo step (the store coalesces by key below)
    if (hit) { removed.add(hit.note.id); this.sel.delete(hit.note.id); cmd.deleteNotes(this.store, chId, [hit.note.id], 'Delete notes', token); }
    this.dragging = true;
    drag(e, (dx, dy, ev) => kill(ev), () => { this.dragging = false; this.syncSelection(); this.invalidate(); void leftButton; });
  }

  muteDrag(e, hit) {
    const cmd = this.app.cmd, chId = this.chId, r = this.grid.getBoundingClientRect();
    const first = hit ? !hit.note.mute : true;
    const done = new Set();
    const apply = (h2) => {
      if (!h2 || done.has(h2.note.id)) return;
      done.add(h2.note.id);
      cmd.updateNotes(this.store, chId, [h2.note.id], (n) => { if (first) n.mute = 1; else delete n.mute; }, first ? 'Mute notes' : 'Unmute notes', this.muteToken);
    };
    this.muteToken = this.newGesture();
    apply(hit);
    this.dragging = true;
    drag(e, (dx, dy, ev) => apply(this.noteAt(ev.clientX - r.left, ev.clientY - r.top)), () => { this.dragging = false; this.invalidate(); });
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
      const ka = this.yk(Math.max(y0, y1)), kb = this.yk(Math.min(y0, y1));
      const ids = new Set(base);
      for (const n of this.notes) if (n.k >= ka && n.k <= kb && n.s + n.l > ta && n.s < tb) ids.add(n.id);
      this.sel = ids; this.invalidate();
    }, () => { this.overlay = null; this.dragging = false; this.syncSelection(); this.invalidate(); });
  }

  paintDrag(e) {
    const r = this.grid.getBoundingClientRect();
    const g = this.snapTicks();
    const placed = new Set();
    const token = this.newGesture();
    const made = [];
    const paint = (ev) => {
      const t = this.floorT(this.xt(ev.clientX - r.left), ev), k = clamp(this.yk(ev.clientY - r.top), 0, KEY_MAX);
      const key = `${t}:${k}`;
      if (placed.has(key) || this.notes.some((n) => n.k === k && n.s <= t && n.s + n.l > t)) return;
      placed.add(key);
      const m = this.placeAtGesture(t, k, g, token);
      made.push(...m);
      if (m.length) this.audition(m[0].k);
    };
    this.dragging = true;
    paint(e);
    drag(e, (dx, dy, ev) => paint(ev), () => { this.dragging = false; this.setSel(made.map((n) => n.id)); });
  }

  placeAtGesture(t, k, len, token) {
    const keys = this.stamp ? this.stamp.keys.map((s) => k + s) : this.chord.on ? chordKeys(k, this.chord.id, { inversion: this.chord.inv }) : [k];
    const partials = keys.filter((x) => x >= 0 && x <= KEY_MAX).map((x) => ({ s: Math.max(0, t), l: len, k: this.constrainKey(x), v: 100 }));
    return this.app.cmd.addNotes(this.store, this.chId, partials, 'Paint notes', token);
  }

  repeatDrag(e) {
    const r = this.grid.getBoundingClientRect();
    const len = this.lastLen, token = this.newGesture();
    const t0 = this.floorT(this.xt(e.clientX - r.left), e), k = clamp(this.yk(e.clientY - r.top), 0, KEY_MAX);
    let count = 0;
    const made = [];
    const fill = (ev) => {
      const t = this.xt(ev.clientX - r.left);
      const want = Math.max(1, Math.floor((t - t0) / len) + 1);
      while (count < want && count < 512) {
        const m = this.placeAtGesture(t0 + count * len, k, len, token);
        made.push(...m);
        if (count === 0 && m.length) this.audition(m[0].k);
        count++;
      }
    };
    this.dragging = true;
    fill(e);
    drag(e, (dx, dy, ev) => fill(ev), () => { this.dragging = false; this.setSel(made.map((n) => n.id)); });
  }

  // cut every note crossed by the stroke at the snapped tick of the crossing
  sliceDrag(e) {
    const r = this.grid.getBoundingClientRect();
    const x0 = e.clientX - r.left, y0 = e.clientY - r.top;
    this.dragging = true;
    drag(e, (dx, dy, ev) => { this.overlay = { type: 'line', x0, y0, x1: ev.clientX - r.left, y1: ev.clientY - r.top }; this.invalidate(); }, (ev) => {
      this.overlay = null; this.dragging = false;
      const x1 = ev.clientX - r.left, y1 = ev.clientY - r.top;
      const ka = this.yk(Math.max(y0, y1)), kb = this.yk(Math.min(y0, y1));
      const lineX = (k) => (Math.abs(y1 - y0) < 1 ? x0 : x0 + ((this.ky(k) + this.view.rowH / 2 - y0) / (y1 - y0)) * (x1 - x0));
      const cuts = [];
      for (const n of this.notes) {
        if (n.k < ka || n.k > kb) continue;
        const cx = Math.abs(x1 - x0) < 1 && Math.abs(y1 - y0) < 1 ? x0 : clamp(lineX(n.k), Math.min(x0, x1), Math.max(x0, x1));
        const ct = this.snapT(this.xt(cx), ev);
        if (ct > n.s + 1 && ct < n.s + n.l - 1) cuts.push([n.id, ct]);
      }
      if (!cuts.length) return;
      const map = new Map(cuts);
      this.app.cmd.replaceNotes(this.store, this.chId, [...map.keys()], (sel, newId) => {
        const out = [];
        for (const n of sel) {
          const ct = map.get(n.id), len = n.l;
          n.l = ct - n.s; out.push(n);
          out.push({ ...n, id: newId(), s: ct, l: n.s + len - ct, slide: 0 });
        }
        return out;
      }, 'Slice notes');
    });
  }

  zoomDrag(e) {
    const r = this.grid.getBoundingClientRect();
    const x0 = e.clientX - r.left, y0 = e.clientY - r.top;
    let moved = false;
    drag(e, (dx, dy, ev) => {
      if (Math.abs(dx) + Math.abs(dy) > 4) moved = true;
      this.overlay = { type: 'rect', x0, y0, x1: ev.clientX - r.left, y1: ev.clientY - r.top }; this.invalidate();
    }, (ev) => {
      this.overlay = null;
      const x1 = ev.clientX - r.left, y1 = ev.clientY - r.top;
      if (!moved) { this.setZoomX(this.view.px * 1.6, x0); this.setZoomY(this.view.rowH * 1.25, y0); return; }
      const ta = this.xt(Math.min(x0, x1)), tb = this.xt(Math.max(x0, x1));
      const ka = this.yk(Math.max(y0, y1)), kb = this.yk(Math.min(y0, y1));
      this.view.px = clamp(this.W / Math.max(24, tb - ta), 0.04, 6);
      this.view.x0 = Math.max(0, ta);
      this.view.rowH = clamp(this.gridH / Math.max(4, kb - ka + 1), 6, 32);
      this.view.y0 = (KEY_MAX - kb) * this.view.rowH;
      this.zoomX.value = String(this.pxToSlider(this.view.px)); this.zoomY.value = String(((this.view.rowH - 6) / 26) * 100);
      this.prefs(); this.clampView(); this.invalidate();
    });
  }

  // hold the mouse: the pattern plays from the clicked position (and stops on release)
  playbackDrag(e) {
    const r = this.grid.getBoundingClientRect();
    const t = Math.max(0, this.snapT(this.xt(e.clientX - r.left), e));
    const tr = this.app.transport;
    const wasPlaying = tr.playing;
    const prevMode = tr.mode;
    if (!wasPlaying) { tr.mode = 'pat'; tr.play(t); } else tr.seek(t);
    drag(e, (dx, dy, ev) => { tr.seek(Math.max(0, this.snapT(this.xt(ev.clientX - r.left), ev))); }, () => { if (!wasPlaying) { tr.stop(); tr.mode = prevMode; } });
  }

  // ------------------------------------------------------------------ event editor lane
  laneDown(e) {
    if (e.button !== 0 || !this.isSound) return;
    const r = this.laneCv.getBoundingClientRect();
    const L = LANES[this.lane];
    const cmd = this.app.cmd, chId = this.chId;
    const nearest = (ev) => {
      const t = this.xt(ev.clientX - r.left);
      let best = null, bd = 9 / this.view.px;
      for (const n of this.notes) { const d = Math.abs(n.s - t); if (d <= bd) { bd = d; best = n; } }
      return best;
    };
    const token = this.newGesture();
    const first = nearest(e);
    if (first && this.sel.has(first.id) && this.sel.size > 1) {
      // dragging a bar of the selection moves the whole selection by the same amount
      const ids = [...this.sel];
      const orig = new Map(this.selNotes.map((n) => [n.id, L.get(n)]));
      const startV = this.yVal(L, e.clientY - r.top);
      drag(e, (dx, dy, ev) => {
        const dv = this.yVal(L, ev.clientY - r.top) - startV;
        cmd.updateNotes(this.store, chId, ids, (n) => { L.set(n, clamp(orig.get(n.id) + dv, L.min, L.max)); }, `Edit ${L.name}`, token);
      });
      return;
    }
    const apply = (ev) => {
      const n = nearest(ev);
      if (!n) return;
      const v = this.yVal(L, ev.clientY - r.top);
      cmd.updateNotes(this.store, chId, [n.id], (m) => L.set(m, clamp(v, L.min, L.max)), `Edit ${L.name}`, token);
    };
    apply(e);
    drag(e, (dx, dy, ev) => apply(ev));
  }

  resetLane() {
    const L = LANES[this.lane];
    const ids = this.sel.size ? [...this.sel] : this.notes.map((n) => n.id);
    if (!ids.length) return;
    this.app.cmd.updateNotes(this.store, this.chId, ids, (n) => L.set(n, L.def === null ? 100 : L.def), `Reset ${L.name}`);
  }

  // ------------------------------------------------------------------ stamp / chords
  stampMenu(anchor) {
    const sc = this.scale;
    const chordItems = CHORDS.slice(0, 16).map((c) => ({ label: c.name, fn: () => this.armStamp({ keys: chordKeys(0, c.id), label: c.name }) }));
    const diatonic = SCALE_BY_ID.get(sc.id) && sc.id !== 'chromatic' ? SCALE_BY_ID.get(sc.id).iv.map((_, deg) => {
      const keys = diatonicChord(sc.root, sc.id, deg, 3, 60).map((k) => k - 60);
      return { label: `Degree ${deg + 1}: ${identifyChord(keys.map((k) => k + 60)) || 'triad'}`, fn: () => this.armStamp({ keys: keys.map((k) => k - keys[0]), label: `Degree ${deg + 1}`, anchorDeg: deg }) };
    }) : [{ label: 'Pick a scale first', disabled: true }];
    const runs = [
      { label: 'Scale run up (1 octave)', fn: () => this.armStamp({ keys: (SCALE_BY_ID.get(sc.id === 'chromatic' ? 'major' : sc.id).iv).concat([12]), label: 'Scale run', run: true }) },
    ];
    const r = anchor.getBoundingClientRect();
    showPopup([{ title: 'Chords' }, ...chordItems, { sep: true }, { title: 'Diatonic chords in the scale' }, ...diatonic, { sep: true }, ...runs, { sep: true }, { label: 'Disarm stamp', fn: () => { this.stamp = null; this.refreshBtns(); } }], r.left, r.bottom, r);
  }

  armStamp(s) { this.stamp = s; this.chord.on = false; this.refreshBtns(); this.app.toast(`Stamp: ${s.label}. Click in the grid to place it`); }

  // ------------------------------------------------------------------ note properties panel
  buildProps() {
    const el = this.propsEl;
    clear(el);
    const mk = (id, label, min, max) => {
      const inp = h('input.field', { type: 'number', min, max, style: { width: '68px' }, dataset: { prop: id } });
      inp.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') inp.blur(); });
      inp.addEventListener('change', () => this.applyProp(id, inp.value));
      this.propInputs[id] = inp;
      return h('div.pr-prop', h('span', label), inp);
    };
    this.propInputs = {};
    const keyInp = h('input.field', { type: 'text', style: { width: '68px' }, dataset: { prop: 'k' } });
    keyInp.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') keyInp.blur(); });
    keyInp.addEventListener('change', () => this.applyProp('k', keyInp.value));
    this.propInputs.k = keyInp;
    this.propTitle = h('div.mx-title', { style: { margin: 0 } }, 'Note properties');
    this.propChord = h('div.dim', { style: { padding: '2px 8px' } }, '');
    const sw = h('div.pr-swatches');
    NOTE_COLORS.forEach((c, i) => sw.append(h('i', { style: { background: c || '#555d65' }, hint: i ? 'Note colour' : 'Channel colour', onclick: () => this.applyProp('c', i) })));
    el.append(this.propTitle, this.propChord,
      h('div.pr-prop', h('span', 'Key'), keyInp),
      mk('s', 'Start (ticks)', 0, 1e7), mk('l', 'Length (ticks)', 1, 1e7), mk('v', 'Velocity', 1, 127), mk('pan', 'Pan', -64, 64),
      mk('rel', 'Release', 0, 127), mk('fine', 'Fine pitch', -120, 120), mk('mx', 'Mod X', 0, 255), mk('my', 'Mod Y', 0, 255),
      h('div.mx-title', 'Colour'), sw,
      h('div.row', { style: { padding: '8px' } },
        h('div.btn.sm', { onclick: () => this.toggleSlide(), hint: 'Slide / portamento' }, 'Slide'),
        h('div.btn.sm', { hint: 'Mute the selected notes', onclick: () => { const ns = this.selNotes; if (!ns.length) return; const on = !ns.every((n) => n.mute); this.app.cmd.updateNotes(this.store, this.chId, [...this.sel], (n) => { if (on) n.mute = 1; else delete n.mute; }, 'Mute notes'); } }, 'Mute')));
    this.updateProps();
  }

  updateProps() {
    if (!this.propInputs) return;
    const ns = this.selNotes;
    this.propTitle.textContent = ns.length ? `Note properties (${ns.length} selected)` : 'Note properties';
    const same = (f) => (ns.length && ns.every((n) => f(n) === f(ns[0])) ? f(ns[0]) : '');
    const set = (id, v) => { const i = this.propInputs[id]; if (document.activeElement !== i) i.value = v === '' ? '' : String(v); i.placeholder = ns.length ? (v === '' ? '—' : '') : ''; i.disabled = !ns.length; };
    set('k', ns.length ? (same((n) => n.k) === '' ? '' : keyName(same((n) => n.k))) : '');
    set('s', same((n) => n.s)); set('l', same((n) => n.l)); set('v', same((n) => n.v));
    for (const id of ['pan', 'rel', 'fine', 'mx', 'my']) set(id, same((n) => LANES[id].get(n)));
    this.propChord.textContent = ns.length > 1 ? (identifyChord(ns.map((n) => n.k)) || '') : '';
  }

  parseKey(s) {
    const m = /^([A-Ga-g])([#b]?)(-?\d+)$/.exec(String(s).trim());
    if (m) {
      const base = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[m[1].toUpperCase()] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0);
      return clamp(base + 12 * (+m[3]), 0, KEY_MAX);
    }
    const n = Number(s);
    return Number.isFinite(n) ? clamp(Math.round(n), 0, KEY_MAX) : null;
  }

  applyProp(id, raw) {
    if (!this.sel.size) return;
    let val;
    if (id === 'k') { val = this.parseKey(raw); if (val === null) { this.updateProps(); return; } } else val = Math.round(Number(raw));
    if (!Number.isFinite(val)) { this.updateProps(); return; }
    const ids = [...this.sel];
    this.app.cmd.updateNotes(this.store, this.chId, ids, (n) => {
      if (id === 'k') n.k = val;
      else if (id === 's') n.s = Math.max(0, val);
      else if (id === 'l') n.l = Math.max(1, val);
      else if (id === 'v') n.v = clamp(val, 1, 127);
      else if (id === 'c') { if (val) n.c = val; else delete n.c; }
      else { const L = LANES[id]; L.set(n, clamp(val, L.min, L.max)); }
    }, 'Edit note properties');
  }

  // ------------------------------------------------------------------ keyboard
  // Called by app.keyHook while the piano roll window has focus; returns true when the key was used.
  keyHook(e) {
    const w = this.win;
    if (!w.open || !w.el.classList.contains('active')) return false;
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA')) return false;
    const key = e.key, lower = key.length === 1 ? key.toLowerCase() : key;
    const ctrl = e.ctrlKey || e.metaKey;
    const cmd = this.app.cmd;
    if (!this.isSound) return false;
    const ids = [...this.sel];
    const g = this.snapTicks();
    if (ctrl) {
      if (lower === 'a') { this.setSel(this.notes.map((n) => n.id)); return true; }
      if (lower === 'c') { this.copy(); return true; }
      if (lower === 'x') { this.copy(); this.deleteSelected(); return true; }
      if (lower === 'v') { this.paste(); return true; }
      if (lower === 'b' || lower === 'd') { this.duplicateSel(); return true; }
      if (lower === 'q') { openTool(this, 'quickQuantize'); return true; }
      if (lower === 'g') { openTool(this, 'glue'); return true; }
      if (lower === 'i') { this.setSel(this.notes.filter((n) => !this.sel.has(n.id)).map((n) => n.id)); return true; }
      if (key === 'ArrowRight' && ids.length) { cmd.updateNotes(this.store, this.chId, ids, (n) => { n.l += g; }, 'Resize notes'); return true; }
      if (key === 'ArrowLeft' && ids.length) { cmd.updateNotes(this.store, this.chId, ids, (n) => { n.l = Math.max(1, n.l - g); }, 'Resize notes'); return true; }
      return false;
    }
    if (e.altKey) { if (lower === 'q') { openTool(this, 'quantize'); return true; } return false; }
    if (key === 'Delete' || key === 'Backspace') { this.deleteSelected(); return true; }
    if (key === 'Escape') { if (this.stamp) { this.stamp = null; this.refreshBtns(); return true; } if (this.sel.size) { this.setSel([]); return true; } return false; }
    if (ids.length && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(key)) {
      const dt = key === 'ArrowLeft' ? -g : key === 'ArrowRight' ? g : 0;
      const dk = key === 'ArrowUp' ? (e.shiftKey ? 12 : 1) : key === 'ArrowDown' ? (e.shiftKey ? -12 : -1) : 0;
      const minS = Math.min(...this.selNotes.map((n) => n.s));
      const kMin = Math.min(...this.selNotes.map((n) => n.k)), kMax = Math.max(...this.selNotes.map((n) => n.k));
      const ds = Math.max(dt, -minS), dk2 = clamp(dk, -kMin, KEY_MAX - kMax);
      cmd.updateNotes(this.store, this.chId, ids, (n) => { n.s += ds; n.k += dk2; }, 'Move notes', `roll-key:${key}`);
      if (dk2) this.audition(this.selNotes[0].k);
      this.reveal();
      return true;
    }
    if (!this.app.typingPiano) {
      const map = { p: 'draw', b: 'paint', d: 'delete', t: 'mute', c: 'slice', e: 'select', z: 'zoom', y: 'playback' };
      if (map[lower] && !e.shiftKey) { this.setTool(map[lower]); return true; }
    } else if (lower === 'p' && !e.shiftKey) { this.setTool('draw'); return true; }
    return false;
  }

  copy() {
    const ns = this.selNotes;
    if (!ns.length) return;
    const s0 = Math.min(...ns.map((n) => n.s));
    this.app.noteClipboard = ns.map((n) => ({ ...n, s: n.s - s0 }));
    this.app.toast(`Copied ${ns.length} note${ns.length > 1 ? 's' : ''}`);
  }

  paste() {
    const clip = this.app.noteClipboard;
    if (!clip || !clip.length) return;
    const t = this.cursorT;
    const made = this.app.cmd.pasteNotes(this.store, this.chId, clip, t);
    this.setSel(made.map((n) => n.id));
  }

  duplicateSel() {
    const ns = this.selNotes;
    if (!ns.length) return;
    const b0 = Math.min(...ns.map((n) => n.s)), b1 = Math.max(...ns.map((n) => n.s + n.l));
    const g = this.snapTicks();
    const span = Math.max(g, Math.ceil((b1 - b0) / g) * g);
    const made = this.app.cmd.pasteNotes(this.store, this.chId, ns, span, 0, 'Duplicate notes');
    this.setSel(made.map((n) => n.id));
  }
}

export function createPianoRoll(win, app) {
  const pr = new PianoRoll(win, app);
  app.pianoRoll = pr;
  const hook = (e) => pr.keyHook(e);
  app.keyHooks.add(hook);
  return { el: pr.el, onResize: () => pr.onResize(), onShow: () => pr.onShow(), onHide: () => pr.onHide(), destroy: () => { app.keyHooks.delete(hook); pr.destroy(); } };
}
