// Floating windows inside the workspace: move, 8-way resize, minimize, maximize, edge/neighbour
// snapping, "dock" presets, z-order, persisted layout.
import { h, drag, clamp } from './h.js';
import { contextMenu } from './menu.js';

const SNAP = 10;
const LS_KEY = 'stepwise.layout.v1';

class Win {
  constructor(wm, id, spec) {
    this.wm = wm; this.id = id; this.spec = spec;
    this.open = false;
    this.min = false; this.max = false; this.restoreRect = null;
    this.comp = null;
    this.titleText = h('span.t', spec.title);
    this.subText = h('span.sub', '');
    this.bodyEl = h('div.win-body');
    this.titleEl = h('div.win-title', { dataset: { win: id } },
      this.titleText,
      h('span.win-btn', { hint: 'Minimize', onclick: (e) => { e.stopPropagation(); this.toggleMin(); } }, '–'),
      h('span.win-btn', { hint: 'Maximize', onclick: (e) => { e.stopPropagation(); this.toggleMax(); } }, '▢'),
      h('span.win-btn.close', { hint: 'Close', onclick: (e) => { e.stopPropagation(); this.close(); } }, '✕'));
    this.titleText.append(this.subText);
    this.el = h('div.win', { dataset: { id } }, this.titleEl, this.bodyEl);
    for (const d of ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']) {
      const rz = h('div.rz.' + d);
      rz.addEventListener('pointerdown', (e) => this.startResize(e, d));
      this.el.append(rz);
    }
    this.el.addEventListener('pointerdown', () => wm.focus(id), true);
    this.titleEl.addEventListener('pointerdown', (e) => { if (e.button === 0 && !e.target.closest('.win-btn')) this.startMove(e); });
    this.titleEl.addEventListener('dblclick', (e) => { if (!e.target.closest('.win-btn')) this.toggleMax(); });
    this.titleEl.addEventListener('contextmenu', (e) => contextMenu(e, this.menuItems()));
    const r = spec.rect || { x: 40, y: 40, w: 420, h: 300 };
    this.setRect(r.x, r.y, r.w, r.h);
  }

  menuItems() {
    const W = this.wm.container.clientWidth, H = this.wm.container.clientHeight;
    return [
      { label: this.min ? 'Restore' : 'Minimize', fn: () => this.toggleMin() },
      { label: this.max ? 'Restore size' : 'Maximize', fn: () => this.toggleMax() },
      { sep: true },
      { label: 'Dock left half', fn: () => this.dock(0, 0, W / 2, H) },
      { label: 'Dock right half', fn: () => this.dock(W / 2, 0, W / 2, H) },
      { label: 'Dock top half', fn: () => this.dock(0, 0, W, H / 2) },
      { label: 'Dock bottom half', fn: () => this.dock(0, H / 2, W, H / 2) },
      { label: 'Default size & position', fn: () => { const r = this.spec.rect; this.dock(r.x, r.y, r.w, r.h); } },
      { sep: true },
      { label: 'Close', fn: () => this.close() },
    ];
  }

  get rect() { return { x: this.x, y: this.y, w: this.w, h: this.h }; }

  setRect(x, y, w, h_) {
    const c = this.wm.container;
    const W = c.clientWidth || 1200, H = c.clientHeight || 700;
    w = clamp(w, this.spec.minW || 200, Math.max(this.spec.minW || 200, W));
    h_ = clamp(h_, this.spec.minH || 80, Math.max(this.spec.minH || 80, H));
    x = clamp(x, 40 - w, Math.max(0, W - 40));
    y = clamp(y, 0, Math.max(0, H - 24));
    this.x = x; this.y = y; this.w = w; this.h = h_;
    Object.assign(this.el.style, { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: this.min ? 'auto' : `${h_}px` });
    this.resized();
  }

  resized() {
    if (this.comp && this.comp.onResize && !this.min) this.comp.onResize(this.w, this.h - 23);
    this.wm.saveSoon();
  }

  dock(x, y, w, h_) {
    this.max = false; this.min = false; this.el.classList.remove('minimized');
    this.setRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h_));
  }

  startMove(e) {
    if (this.max) return;
    e.preventDefault();
    this.wm.focus(this.id);
    const sx = this.x, sy = this.y;
    drag(e, (dx, dy) => {
      let nx = sx + dx, ny = sy + dy;
      ({ x: nx, y: ny } = this.wm.snapMove(this, nx, ny));
      this.setRect(nx, ny, this.w, this.h);
    }, () => this.wm.clearGuides());
  }

  startResize(e, dir) {
    if (this.max || this.min || e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    this.wm.focus(this.id);
    const r0 = this.rect;
    const minW = this.spec.minW || 200, minH = this.spec.minH || 80;
    drag(e, (dx, dy) => {
      let { x, y, w, h: hh } = r0;
      if (dir.includes('e')) w = Math.max(minW, r0.w + dx);
      if (dir.includes('s')) hh = Math.max(minH, r0.h + dy);
      if (dir.includes('w')) { w = Math.max(minW, r0.w - dx); x = r0.x + r0.w - w; }
      if (dir.includes('n')) { hh = Math.max(minH, r0.h - dy); y = r0.y + r0.h - hh; }
      const s = this.wm.snapResize(this, x, y, w, hh, dir);
      this.setRect(s.x, s.y, s.w, s.h);
    }, () => this.wm.clearGuides());
  }

  toggleMin() {
    this.min = !this.min;
    this.el.classList.toggle('minimized', this.min);
    this.el.style.height = this.min ? 'auto' : `${this.h}px`;
    if (!this.min) this.resized();
    this.wm.saveSoon();
  }

  toggleMax() {
    if (this.min) this.toggleMin();
    const c = this.wm.container;
    if (!this.max) { this.restoreRect = this.rect; this.max = true; this.setRect(0, 0, c.clientWidth, c.clientHeight); }
    else { this.max = false; const r = this.restoreRect || this.spec.rect; this.setRect(r.x, r.y, r.w, r.h); }
    this.wm.saveSoon();
  }

  setTitle(t, sub = '') { this.titleText.firstChild.nodeValue = t; this.subText.textContent = sub ? ` ${sub}` : ''; }

  close() { this.wm.close(this.id); }
}

export class WindowManager {
  constructor(container, bus, app) {
    this.container = container;
    this.bus = bus;
    this.app = app;
    this.specs = new Map();
    this.wins = new Map();
    this.z = 10;
    this.guides = [];
    this.saved = {};
    this.saveTimer = null;
    try { this.saved = JSON.parse(localStorage.getItem(LS_KEY) || '{}'); } catch (_) { this.saved = {}; }
    window.addEventListener('resize', () => this.refit());
  }

  register(id, spec) { this.specs.set(id, spec); }

  has(id) { return this.specs.has(id); }
  isOpen(id) { const w = this.wins.get(id); return !!(w && w.open); }
  get(id) { return this.wins.get(id) || null; }

  open(id, spec) {
    if (spec && !this.specs.has(id)) this.register(id, spec);
    const sp = this.specs.get(id);
    if (!sp) return null;
    let w = this.wins.get(id);
    if (!w) {
      const s = { ...sp };
      const saved = this.saved[id];
      if (saved && !sp.dynamic) s.rect = { x: saved.x, y: saved.y, w: saved.w, h: saved.h };
      else if (sp.dynamic) s.rect = this.cascade(sp.rect);
      w = new Win(this, id, s);
      this.wins.set(id, w);
      this.container.append(w.el);
      w.comp = sp.create(w, this.app) || {};
      if (w.comp.el && !w.comp.el.parentNode) w.bodyEl.append(w.comp.el);
      if (saved && saved.min && !sp.dynamic) w.toggleMin();
    }
    w.open = true;
    w.el.style.display = '';
    this.focus(id);
    if (w.comp.onShow) w.comp.onShow();
    w.resized();
    this.bus.emit('window', { id, open: true });
    this.saveSoon();
    return w;
  }

  cascade(rect) {
    const n = this.wins.size % 8;
    return { x: (rect?.x ?? 120) + n * 24, y: (rect?.y ?? 80) + n * 24, w: rect?.w ?? 460, h: rect?.h ?? 320 };
  }

  close(id) {
    const w = this.wins.get(id);
    if (!w) return;
    w.open = false;
    w.el.style.display = 'none';
    if (w.comp && w.comp.onHide) w.comp.onHide();
    if (w.spec.dynamic) { // dynamic windows (plugin editors) are destroyed
      if (w.comp && w.comp.destroy) w.comp.destroy();
      w.el.remove();
      this.wins.delete(id);
    }
    this.bus.emit('window', { id, open: false });
    this.saveSoon();
  }

  toggle(id) { if (this.isOpen(id)) { const w = this.wins.get(id); if (w.el.classList.contains('active')) this.close(id); else this.focus(id); } else this.open(id); }

  focus(id) {
    const w = this.wins.get(id);
    if (!w) return;
    for (const o of this.wins.values()) o.el.classList.toggle('active', o === w);
    w.el.style.zIndex = ++this.z;
    this.bus.emit('focus', id);
  }

  refit() {
    for (const w of this.wins.values()) {
      if (w.max) w.setRect(0, 0, this.container.clientWidth, this.container.clientHeight);
      else w.setRect(w.x, w.y, w.w, w.h);
    }
  }

  // ---- snapping --------------------------------------------------------------------
  edges(except) {
    const c = this.container;
    const xs = [0, c.clientWidth], ys = [0, c.clientHeight];
    for (const w of this.wins.values()) {
      if (w === except || !w.open || w.min) continue;
      xs.push(w.x, w.x + w.w); ys.push(w.y, w.y + w.h);
    }
    return { xs, ys };
  }

  snapMove(win, x, y) {
    const { xs, ys } = this.edges(win);
    let bx = null, by = null, dxBest = SNAP + 1, dyBest = SNAP + 1;
    for (const e of xs) {
      for (const [edge, off] of [[x, 0], [x + win.w, win.w]]) {
        const d = Math.abs(edge - e);
        if (d < dxBest) { dxBest = d; bx = e - off; this.guide('v', e); }
      }
    }
    for (const e of ys) {
      for (const [edge, off] of [[y, 0], [y + win.h, win.h]]) {
        const d = Math.abs(edge - e);
        if (d < dyBest) { dyBest = d; by = e - off; this.guide('h', e); }
      }
    }
    if (dxBest > SNAP) bx = null;
    if (dyBest > SNAP) by = null;
    if (bx === null && by === null) this.clearGuides();
    return { x: bx === null ? x : bx, y: by === null ? y : by };
  }

  snapResize(win, x, y, w, hh, dir) {
    const { xs, ys } = this.edges(win);
    const near = (v, list) => { let b = null, bd = SNAP + 1; for (const e of list) { const d = Math.abs(v - e); if (d < bd) { bd = d; b = e; } } return b; };
    if (dir.includes('e')) { const s = near(x + w, xs); if (s !== null) w = s - x; }
    if (dir.includes('s')) { const s = near(y + hh, ys); if (s !== null) hh = s - y; }
    if (dir.includes('w')) { const s = near(x, xs); if (s !== null) { w += x - s; x = s; } }
    if (dir.includes('n')) { const s = near(y, ys); if (s !== null) { hh += y - s; y = s; } }
    return { x, y, w, h: hh };
  }

  guide(kind, pos) {
    this.clearGuides();
    const g = h('div.snap-guide', { style: kind === 'v' ? { left: `${pos}px`, top: 0, width: '1px', bottom: 0 } : { top: `${pos}px`, left: 0, height: '1px', right: 0 } });
    this.container.append(g);
    this.guides.push(g);
  }

  clearGuides() { for (const g of this.guides) g.remove(); this.guides = []; }

  // ---- persistence -----------------------------------------------------------------
  saveSoon() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.save(), 300);
  }

  save() {
    const out = { ...this.saved };
    for (const [id, w] of this.wins) {
      if (w.spec.dynamic) continue;
      const r = w.max ? (w.restoreRect || w.rect) : w.rect;
      out[id] = { ...r, open: w.open, min: w.min };
    }
    this.saved = out;
    try { localStorage.setItem(LS_KEY, JSON.stringify(out)); } catch (_) { /* storage disabled */ }
  }

  resetLayout() {
    try { localStorage.removeItem(LS_KEY); } catch (_) { /* ignore */ }
    this.saved = {};
    for (const [id, w] of this.wins) {
      if (w.spec.dynamic) continue;
      w.max = false; w.min = false; w.el.classList.remove('minimized');
      const r = this.specs.get(id).rect;
      w.setRect(r.x, r.y, r.w, r.h);
    }
  }

  wasOpen(id) { return this.saved[id] ? this.saved[id].open : undefined; }
}
