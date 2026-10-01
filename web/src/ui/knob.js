// Rotary knob. Vertical drag (Ctrl/Shift = fine), mouse wheel, double-click = type a value,
// right-click = parameter menu (reset, copy/paste, automation, MIDI link). Bound to a parameter
// address, so it follows undo/redo and automation playback.
import { h, svg, drag, clamp } from './h.js';
import { toNorm, fromNorm, format, parseValue } from '../core/schema.js';
import { paramDef, paramLabel } from '../core/addr.js';
import { contextMenu } from './menu.js';

const registry = new Set();
let clipboard = null;

function polar(cx, cy, r, deg) {
  const a = ((deg - 90) * Math.PI) / 180;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
}
function arc(cx, cy, r, from, to) {
  if (Math.abs(to - from) < 0.5) return '';
  const [x0, y0] = polar(cx, cy, r, from), [x1, y1] = polar(cx, cy, r, to);
  const large = Math.abs(to - from) > 180 ? 1 : 0, sweep = to > from ? 1 : 0;
  return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r} ${r} 0 ${large} ${sweep} ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

const START = -135, END = 135; // degrees from 12 o'clock

export class Knob {
  // opts: { addr } | { def, value, onChange(v, final) } ; size: 'sm'|''|'lg'; label; color
  constructor(app, opts) {
    this.app = app;
    this.addr = opts.addr || null;
    this.def = opts.def || (this.addr ? paramDef(app.store.project, this.addr) : null);
    this.onChange = opts.onChange;
    this.value = this.addr ? app.store.getParam(this.addr) : opts.value;
    if (this.def && (this.value === undefined)) this.value = this.def.def;
    this.title = opts.title || (this.addr ? paramLabel(app.store.project, this.addr) : this.def?.name || '');
    this.bipolar = !!this.def && this.def.min < 0 && this.def.max > 0 && !this.def.int;

    this.pathVal = svg('path', { class: 'val', 'stroke-width': 2.6 });
    this.tick = svg('line', { class: 'tick', 'stroke-width': 2 });
    this.el = h('div.knob', { class: opts.size || '', hint: this.title });
    this.el.append(svg('svg', { viewBox: '0 0 32 32' },
      svg('path', { class: 'track', 'stroke-width': 2.6, d: arc(16, 16, 13, START, END) }),
      this.pathVal,
      svg('circle', { class: 'body', cx: 16, cy: 16, r: 9.5 }),
      this.tick));
    this.el._knob = this;
    this.el.addEventListener('pointerdown', (e) => this.down(e));
    this.el.addEventListener('dblclick', (e) => { e.preventDefault(); this.edit(); });
    this.el.addEventListener('wheel', (e) => this.wheel(e), { passive: false });
    this.el.addEventListener('contextmenu', (e) => this.menu(e));
    this.el.addEventListener('pointerenter', () => { this.updateHint(); if (this.addr) app.hoverAddr = this.addr; });
    this.el.addEventListener('pointerleave', () => { if (app.hoverAddr === this.addr) app.hoverAddr = null; });
    registry.add(this);
    this.draw();
    this.markState();

    if (opts.label) {
      this.wrap = h('div.knob-wrap', this.el, h('div.knob-label', opts.label));
    }
  }

  get root() { return this.wrap || this.el; }

  set(v, final = true, fromUser = true) {
    if (!this.def) return;
    v = this.def.int ? Math.round(v) : v;
    v = clamp(v, this.def.min, this.def.max);
    this.value = v;
    if (this.addr) { if (fromUser) this.app.store.setParam(this.addr, v); }
    if (this.onChange) this.onChange(v, final);
    this.draw();
    this.updateHint();
  }

  // value pushed from outside (undo, automation): redraw only
  sync(v) { this.value = v; this.draw(); }

  draw() {
    const d = this.def;
    if (!d) return;
    const n = toNorm(d, this.value);
    const ang = START + (END - START) * n;
    const from = this.bipolar ? 0 : START;
    this.pathVal.setAttribute('d', arc(16, 16, 13, Math.min(from, ang), Math.max(from, ang)));
    const [x0, y0] = polar(16, 16, 3, ang), [x1, y1] = polar(16, 16, 8.5, ang);
    this.tick.setAttribute('x1', x0); this.tick.setAttribute('y1', y0);
    this.tick.setAttribute('x2', x1); this.tick.setAttribute('y2', y1);
  }

  markState() {
    if (!this.addr) return;
    const p = this.app.store.project;
    const auto = p.channels.some((c) => c.type === 'automation' && c.target === this.addr);
    this.el.classList.toggle('auto', auto);
    this.el.classList.toggle('linked', p.controllers.some((l) => l.addr === this.addr));
    this.el.classList.toggle('ctl', p.channels.some((c) => c.type === 'controller' && c.links.some((l) => l.addr === this.addr)));
  }

  text() { return this.def ? format(this.def, this.value) : String(this.value); }

  updateHint() {
    this.el.dataset.hint = `${this.title}: ${this.text()}`;
    this.app.hint && this.app.hint.update(this.el);
  }

  down(e) {
    if (e.button !== 0 || !this.def) return;
    e.preventDefault();
    const d = this.def, start = toNorm(d, this.value);
    this.el.focus && this.el.focus();
    let last = this.value;
    drag(e, (dx, dy, ev) => {
      const fine = ev.ctrlKey || ev.metaKey || ev.shiftKey;
      const n = clamp(start - dy / (fine ? 1200 : 180), 0, 1);
      const v = fromNorm(d, n);
      if (v !== last) { last = v; this.set(v, false); }
    }, () => { if (this.onChange) this.onChange(this.value, true); });
  }

  wheel(e) {
    if (!this.def) return;
    e.preventDefault();
    const d = this.def, step = (e.ctrlKey || e.shiftKey ? 0.004 : 0.03) * (e.deltaY < 0 ? 1 : -1);
    if (d.int) this.set(this.value + (e.deltaY < 0 ? 1 : -1));
    else this.set(fromNorm(d, clamp(toNorm(d, this.value) + step, 0, 1)));
  }

  edit() {
    if (!this.def) return;
    const r = this.el.getBoundingClientRect();
    const inp = h('input.knob-edit', { type: 'text', value: this.text().replace(/ (dB|Hz|ms|st|s|cents|BPM)$/, ''), style: { left: `${Math.min(r.left, innerWidth - 90)}px`, top: `${r.bottom + 2}px` } });
    document.body.append(inp);
    inp.focus(); inp.select();
    let closed = false;
    const done = (apply) => {
      if (closed) return;
      closed = true;
      if (apply) {
        const v = parseValue(this.def, inp.value);
        if (v !== null) this.set(v);
      }
      if (inp.isConnected) inp.remove();
    };
    inp.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') done(true); else if (e.key === 'Escape') done(false); });
    inp.addEventListener('blur', () => done(false));
  }

  menu(e) {
    if (!this.def) return;
    const d = this.def;
    const items = [
      { title: this.title },
      { label: `Reset (${format(d, d.def)})`, fn: () => this.set(d.def) },
      { label: 'Edit value…', fn: () => this.edit() },
      { label: 'Copy value', fn: () => { clipboard = this.value; } },
      { label: 'Paste value', disabled: clipboard === null, fn: () => this.set(clipboard) },
    ];
    if (this.addr && this.app.paramMenuItems) items.push({ sep: true }, ...this.app.paramMenuItems(this.addr));
    contextMenu(e, items);
  }
}

export function knob(app, opts) { return new Knob(app, opts); }

// keep every bound knob in sync with the model
export function wireKnobs(app) {
  app.store.bus.on('param', (addr, v) => {
    for (const k of registry) {
      if (!k.el.isConnected) { registry.delete(k); continue; }
      if (k.addr === addr) k.sync(v);
    }
  });
  const refresh = () => {
    for (const k of registry) {
      if (!k.el.isConnected) { registry.delete(k); continue; }
      if (k.addr) { k.def = paramDef(app.store.project, k.addr) || k.def; k.sync(app.store.getParam(k.addr)); k.markState(); }
    }
  };
  app.store.bus.on('project', refresh);
  app.store.bus.on('change', ({ paths }) => { if (paths.some((p) => p[0] === 'channels' || p[0] === 'mixer' || p[0] === 'controllers')) refresh(); });
}
