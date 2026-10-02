// Patcher editor: a node canvas (pan / zoom, drag nodes, drag wires between ports), an inspector for the
// selected node and the 16 macro knobs. Used for the Patcher instrument (channel) and the Patcher effect (mixer slot).
import { h, svg, clear, drag, clamp } from './h.js';
import { Knob } from './knob.js';
import { contextMenu, showPopup } from './menu.js';
import { promptText } from './dialog.js';
import { format } from '../core/schema.js';
import { INSTRUMENTS } from '../core/instruments/index.js';
import { EFFECTS } from '../core/effects/index.js';
import { chpAddr, fxpAddr } from '../core/addr.js';
import {
  NODE_TYPES, CATEGORIES, MACROS, nodeInfo, portsOf, modPort, getNode, wireProblem, connect, disconnect, addNode, removeNodes, duplicateNodes,
  setExposed, canHostInstrument, canHostEffect, defaultPatch, normalizePatch,
} from '../core/patcher/spec.js';
import { PATCH_PRESETS } from '../core/patcher/presets.js';
import { IRS } from '../core/factory.js';

const NODE_W = 176, HEAD_H = 22, ROW_H = 20, PAD = 6;
export const WIRE_COLORS = { audio: '#ffb02e', ctl: '#4aaedc', note: '#7fdc5c' };
const CAT_CLASS = { 'Input / output': 'io', Generators: 'gen', Effects: 'fx', Control: 'ctl', Audio: 'aud', Notes: 'note' };

const userKey = (kind) => `stepwise.patchpresets.${kind}`;
const loadUser = (kind) => { try { return JSON.parse(localStorage.getItem(userKey(kind)) || '{}'); } catch (_) { return {}; } };

export class PatcherView {
  // target: { ch } for an instrument channel, { track, slot } for a mixer effect slot
  constructor(app, target, win) {
    this.app = app; this.store = app.store; this.cmd = app.cmd; this.t = target; this.win = win;
    this.kind = target.ch !== undefined ? 'instrument' : 'effect';
    this.sel = new Set(); this.selWire = null; this.override = null; this.temp = null;
    this.view = { x: 24, y: 24, z: 1 };
    this.sig = '';
    this.space = false;
    this.build();
    this.render();
    this.fit(true);
    this.subs = [
      this.store.bus.on('change', ({ paths }) => { if (paths.some((p) => p[0] === 'channels' || p[0] === 'mixer')) this.refresh(); }),
      this.store.bus.on('project', () => this.refresh()),
    ];
    this.keyHook = (e) => this.key(e);
    this.upHook = (e) => { if (e.key === ' ') this.space = false; };
    app.keyHooks.add(this.keyHook);
    window.addEventListener('keyup', this.upHook);
  }

  destroy() { for (const s of this.subs) s(); this.app.keyHooks.delete(this.keyHook); window.removeEventListener('keyup', this.upHook); }

  // ------------------------------------------------------------------ model access
  patch() { return this.cmd.getPatch(this.store, this.t); }
  edit(label, fn, opts) { return this.cmd.patchEdit(this.store, this.t, label, fn, opts); }
  alive() { return !!this.patch(); }
  macroAddr(n) { return this.t.ch !== undefined ? chpAddr(this.t.ch, `m${n}`) : fxpAddr(this.t.track, this.t.slot, `m${n}`); }

  // ------------------------------------------------------------------ DOM
  build() {
    this.world = h('div.pt-world');
    this.wires = svg('svg', { class: 'pt-wires', width: 1, height: 1 });
    this.world.append(this.wires);
    this.cv = h('div.pt-canvas', { tabindex: 0 }, this.world);
    this.marquee = h('div.pt-marquee', { style: { display: 'none' } });
    this.cv.append(this.marquee);
    this.side = h('div.pt-side');
    this.inspector = h('div.pt-insp');
    this.macros = h('div.pt-macros');
    this.side.append(this.inspector, this.macros);
    this.tools = h('div.rack-head.pt-tools');
    this.status = h('span.dim', '');
    this.buildTools();
    this.el = h('div.pt-root', this.tools, h('div.pt-main', this.cv, this.side));
    this.cv.addEventListener('pointerdown', (e) => this.canvasDown(e));
    this.cv.addEventListener('wheel', (e) => this.wheel(e), { passive: false });
    this.cv.addEventListener('contextmenu', (e) => { if (e.target === this.cv || e.target === this.world || e.target === this.wires) { e.preventDefault(); const [x, y] = this.toWorld(e.clientX, e.clientY); contextMenu(e, [{ title: 'Add node' }, ...this.addItems([x, y])]); } });
    this.ro = new ResizeObserver(() => this.applyView());
    this.ro.observe(this.cv);
    this.buildMacros();
  }

  buildTools() {
    const add = h('div.btn', { hint: 'Add a node: plugins, modulators, utilities, note tools', onclick: (e) => { const r = e.currentTarget.getBoundingClientRect(); showPopup(this.addItems(), r.left, r.bottom, r); } }, '＋ Add node ▾');
    const presets = h('div.btn', { hint: 'Factory patches and your own saved patches', onclick: (e) => { const r = e.currentTarget.getBoundingClientRect(); showPopup(this.presetItems(), r.left, r.bottom, r); } }, 'Patches ▾');
    this.tools.append(add,
      h('div.btn.sm', { hint: 'Delete the selected nodes or wire (Del)', onclick: () => this.deleteSel() }, 'Delete'),
      h('div.btn.sm', { hint: 'Duplicate the selected nodes (Ctrl+D)', onclick: () => this.duplicateSel() }, 'Duplicate'),
      h('div.btn.sm', { hint: 'Show the whole patch', onclick: () => this.fit() }, 'Fit'),
      presets, h('div.grow'), this.status);
  }

  buildMacros() {
    clear(this.macros);
    this.macros.append(h('div.mx-title', 'Macros — automate or link to MIDI like any knob'));
    const grid = h('div.pt-macro-grid');
    this.macroLabels = [];
    for (let n = 1; n <= MACROS; n++) {
      const name = () => (this.patch() && this.patch().macroNames && this.patch().macroNames[n - 1]) || `${n}`;
      const k = new Knob(this.app, { addr: this.macroAddr(n), size: 'sm', label: name() });
      const label = k.root.querySelector('.knob-label');
      label.title = 'Double-click to rename this macro';
      this.macroLabels.push(label);
      label.addEventListener('dblclick', async () => {
        const v = await promptText('Macro name', `Name of macro ${n}`, name() === `${n}` ? '' : name());
        if (v === null || v === undefined) return;
        this.edit('Rename macro', (patch) => { const names = Array.from({ length: MACROS }, (_, i) => (patch.macroNames && patch.macroNames[i]) || ''); names[n - 1] = v.slice(0, 24); patch.macroNames = names.some(Boolean) ? names : []; }, { sync: false });
        this.render();
      });
      grid.append(k.root);
    }
    this.macros.append(grid);
  }

  // ------------------------------------------------------------------ geometry
  info(node) { return nodeInfo(node); }
  size(node) { const p = portsOf(node); const rows = Math.max(1, p.ins.length, p.outs.length); return { w: NODE_W, h: HEAD_H + PAD * 2 + rows * ROW_H }; }
  pos(node) { const o = this.override && this.override.get(node.id); return o || [node.x, node.y]; }
  portPos(node, dir, id) {
    const p = portsOf(node), list = dir === 'in' ? p.ins : p.outs;
    const i = Math.max(0, list.findIndex((q) => q.id === id)), [x, y] = this.pos(node);
    return [x + (dir === 'in' ? 0 : NODE_W), y + HEAD_H + PAD + ROW_H * (i + 0.5)];
  }
  toWorld(cx, cy) { const r = this.cv.getBoundingClientRect(); return [(cx - r.left - this.view.x) / this.view.z, (cy - r.top - this.view.y) / this.view.z]; }

  applyView() { this.world.style.transform = `translate(${this.view.x}px, ${this.view.y}px) scale(${this.view.z})`; }

  fit(initial) {
    const patch = this.patch();
    if (!patch || !patch.nodes.length) { this.view = { x: 24, y: 24, z: 1 }; this.applyView(); return; }
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const n of patch.nodes) { const s = this.size(n); x0 = Math.min(x0, n.x); y0 = Math.min(y0, n.y); x1 = Math.max(x1, n.x + s.w); y1 = Math.max(y1, n.y + s.h); }
    const W = this.cv.clientWidth || 640, H = this.cv.clientHeight || 360;
    const z = clamp(Math.min((W - 48) / (x1 - x0), (H - 48) / (y1 - y0)), 0.45, initial ? 1.2 : 1.4);
    this.view = { z, x: (W - (x1 - x0) * z) / 2 - x0 * z, y: (H - (y1 - y0) * z) / 2 - y0 * z };
    this.applyView();
  }

  // ------------------------------------------------------------------ rendering
  refresh() {
    if (this.quiet) return;
    if (!this.alive()) { if (this.win && this.win.close) this.win.close(); return; }
    const sig = JSON.stringify(this.patch());
    if (sig === this.sig) return;
    this.render();
  }

  render() {
    const patch = this.patch();
    if (!patch) return;
    this.sig = JSON.stringify(patch);
    for (const id of [...this.sel]) if (!getNode(patch, id)) this.sel.delete(id);
    if (this.selWire && !patch.wires.some((w) => w.id === this.selWire)) this.selWire = null;
    for (const el of [...this.world.querySelectorAll('.pt-node')]) el.remove();
    this.els = new Map();
    for (const node of patch.nodes) { const el = this.nodeEl(node); this.world.append(el); this.els.set(node.id, el); }
    this.drawWires();
    this.renderInspector();
    this.status.textContent = `${patch.nodes.length} nodes · ${patch.wires.length} wires`;
    this.macroLabels.forEach((el, i) => { el.textContent = (patch.macroNames && patch.macroNames[i]) || `${i + 1}`; });
    this.applyView();
  }

  nodeEl(node) {
    const info = this.info(node), ports = portsOf(node);
    const [x, y] = this.pos(node);
    const cat = CAT_CLASS[info.cat] || 'aud';
    const modded = new Set(this.patch().wires.filter((w) => w.to[0] === node.id).map((w) => w.to[1]));
    const portEl = (p, dir) => h('div.pt-port.' + dir + (p.mod ? '.mod' : '') + (modded.has(p.id) ? '.wired' : ''), { dataset: { node: node.id, port: p.id, dir, kind: p.type }, hint: `${p.name} (${p.type})` },
      dir === 'in' ? [h('span.pt-dot', { style: { background: WIRE_COLORS[p.type] } }), h('span.pt-plabel', p.name)] : [h('span.pt-plabel', p.name), h('span.pt-dot', { style: { background: WIRE_COLORS[p.type] } })]);
    const el = h('div.pt-node.cat-' + cat + (this.sel.has(node.id) ? '.sel' : '') + (node.bypass ? '.bypass' : ''), { dataset: { id: node.id, type: node.type }, style: { left: `${x}px`, top: `${y}px`, width: `${NODE_W}px` } },
      h('div.pt-head', { hint: `${info.name}${info.desc ? ' — ' + info.desc : ''}. Drag to move, double-click to edit, right-click for more` },
        h('span.pt-title', node.name || info.name),
        node.sample ? h('span.dim.pt-sub', node.sample.name) : (node.type === 'macro' ? h('span.dim.pt-sub', this.macroLabel(node.params.n)) : null)),
      h('div.pt-body', h('div.pt-col', ports.ins.map((p) => portEl(p, 'in'))), h('div.pt-col.out', ports.outs.map((p) => portEl(p, 'out')))));
    el.addEventListener('pointerdown', (e) => this.nodeDown(e, node.id));
    el.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); if (!this.sel.has(node.id)) this.select([node.id]); contextMenu(e, this.nodeMenu(node.id)); });
    el.addEventListener('dblclick', (e) => { if (!e.target.closest('.pt-port')) { this.select([node.id]); this.renameNode(node.id); } });
    return el;
  }

  macroLabel(n) { const names = this.patch().macroNames; return (names && names[n - 1]) || `Macro ${n}`; }

  wirePath(a, b) { const dx = Math.max(40, Math.abs(b[0] - a[0]) * 0.5); return `M ${a[0]} ${a[1]} C ${a[0] + dx} ${a[1]}, ${b[0] - dx} ${b[1]}, ${b[0]} ${b[1]}`; }

  drawWires() {
    clear(this.wires);
    const patch = this.patch();
    if (!patch) return;
    for (const w of patch.wires) {
      const a = getNode(patch, w.from[0]), b = getNode(patch, w.to[0]);
      if (!a || !b) continue;
      const po = portsOf(a).outs.find((q) => q.id === w.from[1]);
      if (!po) continue;
      const d = this.wirePath(this.portPos(a, 'out', w.from[1]), this.portPos(b, 'in', w.to[1]));
      const sel = this.selWire === w.id;
      const hit = svg('path', { d, class: 'pt-hit', 'data-wire': w.id });
      hit.addEventListener('pointerdown', (e) => { e.stopPropagation(); this.selWire = w.id; this.sel.clear(); this.refreshSel(); this.drawWires(); this.cv.focus(); });
      hit.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); this.selWire = w.id; this.drawWires(); contextMenu(e, [{ label: 'Delete wire', fn: () => this.removeWire(w.id) }]); });
      this.wires.append(svg('path', { d, class: 'pt-wire' + (sel ? ' sel' : ''), stroke: WIRE_COLORS[po.type], 'data-kind': po.type }), hit);
    }
    if (this.temp) this.wires.append(svg('path', { d: this.wirePath(this.temp.a, this.temp.b), class: 'pt-wire temp', stroke: WIRE_COLORS[this.temp.kind] }));
  }

  refreshSel() {
    for (const [id, el] of this.els) el.classList.toggle('sel', this.sel.has(id));
    this.renderInspector();
  }

  select(ids, add = false) {
    if (!add) this.sel.clear();
    for (const id of ids) { if (add && this.sel.has(id)) this.sel.delete(id); else this.sel.add(id); }
    this.selWire = null;
    this.refreshSel();
    this.drawWires();
  }

  // ------------------------------------------------------------------ interaction: canvas
  canvasDown(e) {
    if (e.target !== this.cv && e.target !== this.world && e.target !== this.wires) return;
    this.cv.focus();
    if (e.button === 1 || (e.button === 0 && this.space)) { e.preventDefault(); this.panDrag(e); return; }
    if (e.button !== 0) return;
    const r = this.cv.getBoundingClientRect(), x0 = e.clientX - r.left, y0 = e.clientY - r.top;
    const base = e.shiftKey ? new Set(this.sel) : new Set();
    if (!e.shiftKey) { this.sel.clear(); this.selWire = null; this.refreshSel(); this.drawWires(); }
    let moved = false;
    drag(e, (dx, dy, ev) => {
      if (!moved && Math.hypot(dx, dy) < 3) return;
      moved = true;
      const x1 = ev.clientX - r.left, y1 = ev.clientY - r.top;
      const L = Math.min(x0, x1), T = Math.min(y0, y1), W = Math.abs(x1 - x0), H = Math.abs(y1 - y0);
      Object.assign(this.marquee.style, { display: 'block', left: `${L}px`, top: `${T}px`, width: `${W}px`, height: `${H}px` });
      const z = this.view.z, wx0 = (L - this.view.x) / z, wy0 = (T - this.view.y) / z, wx1 = (L + W - this.view.x) / z, wy1 = (T + H - this.view.y) / z;
      const next = new Set(base);
      for (const n of this.patch().nodes) { const s = this.size(n); if (n.x < wx1 && n.x + s.w > wx0 && n.y < wy1 && n.y + s.h > wy0) next.add(n.id); }
      this.sel = next; this.refreshSel();
    }, () => { this.marquee.style.display = 'none'; });
  }

  panDrag(e) {
    const v0 = { ...this.view };
    drag(e, (dx, dy) => { this.view.x = v0.x + dx; this.view.y = v0.y + dy; this.applyView(); });
  }

  wheel(e) {
    e.preventDefault();
    const r = this.cv.getBoundingClientRect(), px = e.clientX - r.left, py = e.clientY - r.top;
    const z0 = this.view.z, z1 = clamp(z0 * (e.deltaY < 0 ? 1.12 : 1 / 1.12), 0.35, 2);
    this.view.x = px - ((px - this.view.x) / z0) * z1; this.view.y = py - ((py - this.view.y) / z0) * z1; this.view.z = z1;
    this.applyView();
  }

  // ------------------------------------------------------------------ interaction: nodes and wires
  nodeDown(e, id) {
    if (e.button !== 0) return;
    const portEl = e.target.closest('.pt-port');
    if (portEl) { this.portDown(e, portEl); return; }
    e.stopPropagation();
    this.cv.focus();
    if (e.shiftKey) this.select([id], true);
    else if (!this.sel.has(id)) this.select([id]);
    const patch = this.patch(), ids = [...this.sel], z = this.view.z;
    const start = new Map(ids.map((i) => [i, [getNode(patch, i).x, getNode(patch, i).y]]));
    let moved = false;
    this.override = new Map();
    drag(e, (dx, dy, ev) => {
      if (!moved && Math.hypot(dx, dy) < 3) return;
      moved = true;
      const snap = ev.altKey ? 1 : 10;
      for (const [i, [x, y]] of start) {
        const nx = Math.round((x + dx / z) / snap) * snap, ny = Math.round((y + dy / z) / snap) * snap;
        this.override.set(i, [nx, ny]);
        const el = this.els.get(i);
        if (el) { el.style.left = `${nx}px`; el.style.top = `${ny}px`; }
      }
      this.drawWires();
    }, () => {
      const ov = this.override; this.override = null;
      if (!moved) return;
      this.edit('Move nodes', (p) => { for (const [i, [x, y]] of ov) { const n = getNode(p, i); if (n) { n.x = x; n.y = y; } } }, { sync: false });
      this.render();
    });
  }

  portDown(e, portEl) {
    e.stopPropagation(); e.preventDefault();
    this.cv.focus();
    const patch = this.patch();
    const nodeId = +portEl.dataset.node, port = portEl.dataset.port, dir = portEl.dataset.dir, kind = portEl.dataset.kind;
    let from = null, to = null;
    if (dir === 'out') from = [nodeId, port];
    else {
      // pick up an existing cable from this input (like pulling a plug); an empty input starts a wire backwards
      const w = patch.wires.filter((q) => q.to[0] === nodeId && q.to[1] === port).pop();
      if (w) { from = w.from.slice(); this.edit('Disconnect', (p) => disconnect(p, w.id)); this.render(); } else to = [nodeId, port];
    }
    const node = getNode(this.patch(), (from || to)[0]);
    const anchor = from ? this.portPos(node, 'out', from[1]) : this.portPos(node, 'in', to[1]);
    this.world.classList.add('wiring');
    this.markTargets(from ? 'in' : 'out', kind);
    const upd = (ev) => {
      const b = this.toWorld(ev.clientX, ev.clientY);
      this.temp = from ? { a: anchor, b, kind } : { a: b, b: anchor, kind };
      this.drawWires();
    };
    upd(e);
    drag(e, (dx, dy, ev) => upd(ev), (ev) => {
      this.temp = null; this.world.classList.remove('wiring');
      for (const el of this.world.querySelectorAll('.pt-port.ok, .pt-port.no')) el.classList.remove('ok', 'no');
      const t = document.elementFromPoint(ev.clientX, ev.clientY);
      const pe = t && t.closest ? t.closest('.pt-port') : null;
      if (pe && pe.dataset.dir === (from ? 'in' : 'out')) {
        const a = from || [+pe.dataset.node, pe.dataset.port], b = to || [+pe.dataset.node, pe.dataset.port];
        const problem = wireProblem(this.patch(), a, b);
        if (problem) this.app.toast(problem); else this.edit('Connect', (p) => connect(p, a, b));
      }
      this.render();
    });
  }

  markTargets(dir, kind) {
    for (const el of this.world.querySelectorAll('.pt-port')) {
      if (el.dataset.dir !== dir) { el.classList.add('no'); continue; }
      el.classList.add(el.dataset.kind === kind ? 'ok' : 'no');
    }
  }

  removeWire(id) { this.edit('Delete wire', (p) => disconnect(p, id)); this.selWire = null; this.render(); }

  // ------------------------------------------------------------------ commands
  key(e) {
    if (!this.win || !this.win.open || !this.win.el.classList.contains('active')) return false;
    if (e.target && ['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName)) return false;
    const mod = e.ctrlKey || e.metaKey;
    if (e.key === ' ' && document.activeElement === this.cv) { this.space = true; return true; }      // hold Space and drag to pan
    if (e.key === 'Delete' || e.key === 'Backspace') { this.deleteSel(); return true; }
    if (mod && e.key.toLowerCase() === 'd') { this.duplicateSel(); return true; }
    if (mod && e.key.toLowerCase() === 'a') { this.select(this.patch().nodes.map((n) => n.id)); return true; }
    if (e.key === 'Escape' && (this.sel.size || this.selWire)) { this.select([]); return true; }
    return false;
  }

  deleteSel() {
    if (this.selWire) { this.removeWire(this.selWire); return; }
    if (!this.sel.size) return;
    const ids = [...this.sel];
    this.edit('Delete nodes', (p) => removeNodes(p, ids));
    this.sel.clear(); this.render();
  }

  duplicateSel() {
    if (!this.sel.size) return;
    let made = [];
    this.edit('Duplicate nodes', (p) => { made = duplicateNodes(p, [...this.sel]); });
    this.sel = new Set(made.map((n) => n.id)); this.render();
  }

  addNodeAt(type, opts = {}, at) {
    const patch = this.patch();
    const [cx, cy] = at || this.toWorld(this.cv.getBoundingClientRect().left + this.cv.clientWidth / 2 - NODE_W / 2, this.cv.getBoundingClientRect().top + this.cv.clientHeight / 2 - 40);
    let made = null;
    this.edit('Add node', (p) => { made = addNode(p, type, { ...opts, x: Math.round(cx / 10) * 10, y: Math.round(cy / 10) * 10 }); });
    if (!made) { this.app.toast(patch.nodes.length >= 64 ? 'A patch can hold 64 nodes' : 'That node is already in the patch'); return null; }
    this.sel = new Set([made.id]); this.render();
    return made;
  }

  addItems(at) {
    const patch = this.patch();
    const has = (t) => patch.nodes.some((n) => n.type === t);
    const byCat = (cat) => Object.entries(NODE_TYPES).filter(([, t]) => t.cat === cat)
      .map(([type, t]) => ({ label: t.name, disabled: !!t.unique && has(type), title: undefined, fn: () => this.addNodeAt(type, {}, at) }));
    const gens = Object.entries(INSTRUMENTS).filter(([id]) => canHostInstrument(id)).map(([id, m]) => ({ label: m.meta.name, fn: () => this.addNodeAt('inst', { ref: id }, at) }));
    const fxCats = {};
    for (const [id, m] of Object.entries(EFFECTS)) if (canHostEffect(id)) (fxCats[m.meta.category || 'Other'] = fxCats[m.meta.category || 'Other'] || []).push({ label: m.meta.name, fn: () => this.addNodeAt('fx', { ref: id }, at) });
    const items = [];
    for (const cat of CATEGORIES) {
      if (cat === 'Notes') continue;
      items.push({ label: cat, submenu: byCat(cat) });
      if (cat === 'Input / output') items.push({ label: 'Generators', submenu: gens }, { label: 'Effects', submenu: Object.entries(fxCats).map(([c, list]) => ({ label: c, submenu: list })) });
    }
    items.push({ label: 'Notes', submenu: byCat('Notes') });
    return items;
  }

  presetItems() {
    const kind = this.kind;
    const apply = (patch, label) => { this.cmd.setPatch(this.store, this.t, patch, label); this.sel.clear(); this.render(); this.fit(); };
    const items = [
      { label: 'Save patch…', fn: async () => {
        const name = await promptText('Save patch', 'Patch name', 'My patch');
        if (!name) return;
        const all = loadUser(kind); all[name] = JSON.parse(JSON.stringify(this.patch()));
        try { localStorage.setItem(userKey(kind), JSON.stringify(all)); this.app.toast(`Saved patch "${name}"`); } catch (_) { this.app.toast('Could not save (storage disabled)'); }
      } },
      { label: 'New empty patch', fn: () => apply(defaultPatch(kind), 'New patch') },
      { sep: true }, { title: 'Factory patches' },
      ...Object.entries(PATCH_PRESETS[kind]).map(([name, mk]) => ({ label: name, fn: () => apply(mk(), `Load patch ${name}`) })),
    ];
    const user = loadUser(kind), names = Object.keys(user);
    if (names.length) {
      items.push({ sep: true }, { title: 'My patches' }, ...names.map((n) => ({ label: n, fn: () => apply(normalizePatch(user[n], kind), `Load patch ${n}`) })));
      items.push({ sep: true }, { label: 'Delete patch…', submenu: names.map((n) => ({ label: n, fn: () => { const all = loadUser(kind); delete all[n]; localStorage.setItem(userKey(kind), JSON.stringify(all)); } })) });
    }
    return items;
  }

  nodeMenu(id) {
    const node = getNode(this.patch(), id), info = this.info(node);
    const items = [{ title: node.name || info.name },
      { label: 'Rename…', fn: () => this.renameNode(id) }];
    if (node.type === 'inst' || node.type === 'fx' || node.type === 'gain' || node.type === 'xfade') {
      items.push({ label: 'Bypass', checked: !!node.bypass, fn: () => { this.edit('Bypass node', (p) => { const n = getNode(p, id); if (n.bypass) delete n.bypass; else n.bypass = 1; }); this.render(); } });
    }
    if (info.params.length) {
      items.push({ label: 'Expose parameter as input', submenu: info.params.map((d) => ({ label: d.name, checked: (node.mods || []).includes(d.id), fn: () => { this.edit('Expose parameter', (p) => setExposed(p, id, d.id, !(getNode(p, id).mods || []).includes(d.id))); this.render(); } })) });
    }
    items.push({ sep: true },
      { label: 'Disconnect everything', fn: () => { this.edit('Disconnect node', (p) => { p.wires = p.wires.filter((w) => w.from[0] !== id && w.to[0] !== id); }); this.render(); } },
      { label: 'Duplicate', disabled: !!(NODE_TYPES[node.type] && NODE_TYPES[node.type].unique), fn: () => this.duplicateSel() },
      { label: 'Delete', fn: () => this.deleteSel() });
    return items;
  }

  async renameNode(id) {
    const node = getNode(this.patch(), id), info = this.info(node);
    const v = await promptText('Rename node', 'Name', node.name || info.name);
    if (v === null || v === undefined) return;
    this.edit('Rename node', (p) => { const n = getNode(p, id); if (v && v !== info.name) n.name = v.slice(0, 24); else delete n.name; }, { sync: false });
    this.render();
  }

  // ------------------------------------------------------------------ inspector
  setParam(id, def, v) {
    this.quiet = true;                                  // the knob being dragged must not be rebuilt under the pointer
    try { this.edit(`Patcher: ${def.name}`, (p) => { const n = getNode(p, id); if (n) n.params[def.id] = v; }, { coalesce: `pt:${this.t.ch ?? this.t.track + '.' + this.t.slot}:${id}:${def.id}` }); } finally { this.quiet = false; }
    this.sig = JSON.stringify(this.patch());
    // modulated knobs and the node subtitle follow the new value without rebuilding the canvas
    if (def.id === 'n') { const n = getNode(this.patch(), id), el = this.els.get(id); if (el && n.type === 'macro') { const sub = el.querySelector('.pt-sub'); if (sub) sub.textContent = this.macroLabel(v); } }
  }

  renderInspector() {
    clear(this.inspector);
    const patch = this.patch();
    if (!patch) return;
    const ids = [...this.sel];
    if (ids.length !== 1) {
      this.inspector.append(h('div.mx-title', ids.length ? `${ids.length} nodes selected` : 'Patcher'),
        h('div.pt-help', ids.length ? 'Drag to move them together. Delete removes them, Ctrl+D duplicates.' : [
          'Right-click the canvas or use ', h('b', '＋ Add node'), ' to place plugins, modulators and note tools. Drag from a dot on the right edge of a node to a dot on the left edge of another to wire them. ',
          'Dots are coloured by signal: ', h('span', { style: { color: WIRE_COLORS.audio } }, 'audio'), ', ', h('span', { style: { color: WIRE_COLORS.ctl } }, 'control'), ', ', h('span', { style: { color: WIRE_COLORS.note } }, 'notes'), '. ',
          'Turn any knob into a control input with ⇄, then wire a Macro, LFO, Envelope or another modulator into it. Pan with the middle mouse button (or hold Space and drag), zoom with the wheel.']));
      return;
    }
    const node = getNode(patch, ids[0]);
    if (!node) return;
    const info = this.info(node);
    this.inspector.append(h('div.mx-title', info.name), info.desc ? h('div.pt-help', info.desc) : null);
    const wired = new Set(patch.wires.filter((w) => w.to[0] === node.id).map((w) => w.to[1]));
    if (node.type === 'inst' && node.ref === 'sampler') this.inspector.append(this.samplePicker(node));
    if (node.type === 'fx' && node.ref === 'convolver') this.inspector.append(this.irPicker(node));
    const grid = h('div.pt-params');
    for (const d of info.params) {
      const exposed = (node.mods || []).includes(d.id), isWired = wired.has(modPort(d.id));
      const value = node.params[d.id] ?? d.def;
      const toggle = h('div.btn.sm.pt-expose' + (exposed ? '.on' : ''), { hint: exposed ? 'Exposed as a control input — click to hide it again' : 'Expose as a control input so a modulator can drive it', onclick: () => { this.edit('Expose parameter', (p) => setExposed(p, node.id, d.id, !exposed)); this.render(); } }, '⇄');
      let ctl;
      if (d.options) {
        const sel = h('select.select', { hint: d.name, onchange: () => { this.setParam(node.id, d, +sel.value); } }, d.options.map((o, i) => h('option', { value: i }, o)));
        sel.value = String(Math.round(value)); ctl = h('div.pt-pc', h('div.knob-label', d.name), sel);
      } else if (d.bool) {
        const b = h('div.btn' + (value ? '.on' : ''), { hint: d.name, onclick: () => { const v = value ? 0 : 1; this.setParam(node.id, d, v); b.classList.toggle('on', !!v); this.renderInspector(); } }, d.name);
        ctl = h('div.pt-pc', b);
      } else {
        const k = new Knob(this.app, { def: d, value, label: d.name, onChange: (v) => { this.setParam(node.id, d, v); txt.textContent = format(d, v); } });
        const txt = h('div.knob-label', { style: { color: 'var(--accent)' } }, format(d, value));
        k.root.append(txt);
        ctl = h('div.pt-pc', k.root);
      }
      grid.append(h('div.pt-param' + (exposed ? '.exposed' : '') + (isWired ? '.wired' : ''), ctl, toggle));
    }
    this.inspector.append(grid);
  }

  samplePicker(node) {
    const name = h('span', { style: { color: 'var(--accent)' } }, node.sample ? node.sample.name : '(no sample)');
    const setSample = (smp) => { this.edit('Set sample', (p) => { const n = getNode(p, node.id); if (smp) n.sample = { id: smp.id, name: smp.name }; else delete n.sample; }); if (smp) this.app.bank.ensure(smp.id); this.render(); };
    const pick = () => {
      const inp = h('input', { type: 'file', accept: 'audio/*,.wav,.mp3,.ogg,.flac,.aif,.aiff,.m4a', style: { display: 'none' } });
      inp.addEventListener('change', async () => {
        const f = inp.files[0];
        if (f) { try { const e = await this.app.bank.decode(f.name, await f.arrayBuffer()); setSample({ id: e.id, name: e.name }); this.app.preview && this.t.ch !== undefined && this.app.preview(this.t.ch); } catch (err) { this.app.toast(`Could not decode ${f.name}`); } }
        inp.remove();
      });
      document.body.append(inp); inp.click();
    };
    return h('div.pt-pick', h('span.dim', 'Sample'), name, h('div.btn.sm', { onclick: pick }, 'Load file…'), node.sample ? h('div.btn.sm', { onclick: () => setSample(null) }, 'Clear') : null);
  }

  irPicker(node) {
    const sel = h('select.select', { hint: 'Impulse response' }, h('option', { value: '' }, '(none)'), IRS.map((f) => h('option', { value: `factory:${f.id}` }, f.name || f.id)));
    sel.value = (node.extra && node.extra.irId) || '';
    sel.addEventListener('change', () => {
      this.edit('Set impulse response', (p) => { const n = getNode(p, node.id); if (sel.value) n.extra = { irId: sel.value }; else delete n.extra; });
      if (sel.value) this.app.bank.ensure(sel.value);
    });
    return h('div.pt-pick', h('span.dim', 'Impulse'), sel);
  }
}

// ---- windows
export function patcherEditor(win, app, chId) {
  const store = app.store;
  const ch = () => store.channel(chId);
  win.setTitle(ch().name, 'Patcher');
  const view = new PatcherView(app, { ch: chId }, win);
  const head = h('div.rack-head',
    new Knob(app, { addr: `ch:${chId}:vol`, size: 'sm', title: 'Channel volume' }).el,
    new Knob(app, { addr: `ch:${chId}:pan`, size: 'sm', title: 'Channel panning' }).el,
    new Knob(app, { addr: `ch:${chId}:pitch`, size: 'sm', title: 'Channel pitch (semitones)' }).el,
    h('div.grow'),
    h('div.btn', { hint: 'Preview — plays the channel at its root key', onclick: () => app.preview(chId) }, '▶ Preview'));
  const el = h('div.rack', head, view.el);
  const sub = store.bus.on('change', ({ paths }) => { if (paths.some((p) => p[0] === 'channels') && ch()) win.setTitle(ch().name, 'Patcher'); });
  return { el, onResize: () => view.applyView(), onShow: () => view.fit(true), destroy() { sub(); view.destroy(); view.ro.disconnect(); } };
}
patcherEditor.rect = { w: 1000, h: 600 };

// the Patcher effect shows the same editor inside the mixer effect window
export function patcherFxPanel(app, win, track, slot) {
  const view = new PatcherView(app, { track, slot }, win);
  return { el: view.el, view, destroy() { view.destroy(); view.ro.disconnect(); } };
}

