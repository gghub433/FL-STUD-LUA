// Automation clip editor: edit the curve of an automation channel. Click to add points, drag to move,
// Alt-drag a segment to bend it, right-click for the segment type (single curve, hold, stairs, smooth
// stairs, pulse, wave, half sine, smooth), LFO tool, flip, quantize. Shared by every clip of the channel.
import { h, drag, clamp, clear } from './h.js';
import { contextMenu, showPopup } from './menu.js';
import { formDialog } from './forms.js';
import { pickParam } from './param-picker.js';
import { PPQ, STEP } from '../core/constants.js';
import { barTicks } from '../core/project.js';
import { CURVE_TYPES, evalPoints, generateLfoPoints, thinPoints, LFO_TOOL_SHAPES } from '../core/automation.js';
import { paramDef, paramLabel } from '../core/addr.js';
import { fromNorm, toNorm, format } from '../core/schema.js';

const LEFT = 58, TOP = 8, RULER = 20, HIT = 8;

export function openAutomationEditor(app, chId) {
  const ch = app.store.channel(chId);
  if (!ch) return null;
  const id = `auto:${chId}`;
  if (app.wm.isOpen(id)) { app.wm.focus(id); return app.wm.get(id); }
  return app.wm.open(id, { title: 'Automation', dynamic: true, rect: { x: 200, y: 110, w: 780, h: 440 }, minW: 440, minH: 260, create: (win) => automationEditor(win, app, chId) });
}

function automationEditor(win, app, chId) {
  const store = app.store, cmd = app.cmd;
  const ch = () => store.channel(chId);
  const view = { px: 0.5, x0: 0 };
  let sel = -1, gesture = 0, hover = null, dirty = true, raf = 0, W = 0, H = 0, dpr = 1;
  const def = () => { const c = ch(); return c && c.target ? paramDef(store.project, c.target) : null; };
  const len = () => ch().len || barTicks(store.project.timeSig);
  const token = () => `gesture:auto:${++gesture}`;

  const cv = h('canvas', { style: { width: '100%', height: '100%', display: 'block', cursor: 'crosshair', touchAction: 'none' }, hint: 'Click to add a point, drag to move, double-click a point to delete it. Alt-drag a segment to bend it. Right-click: segment type' });
  const wrap = h('div', { style: { flex: 1, minHeight: 0, position: 'relative', background: '#25282b' } }, cv);
  const targetBtn = h('div.btn', { hint: 'The knob this curve controls — click to choose another', onclick: async () => { const a = await pickParam(app, { title: 'Automate which parameter?', current: ch().target }); if (a) cmd.setAutomationTarget(store, chId, a); } }, '');
  const typeSel = h('select.select', { hint: 'Type of the segment that starts at the selected point' }, CURVE_TYPES.map((t) => h('option', { value: t.id }, t.name)));
  typeSel.addEventListener('change', () => editSel((p) => { p.type = typeSel.value; }, 'Segment type'));
  const tens = h('input', { type: 'range', min: -100, max: 100, value: 0, style: { width: '90px', accentColor: 'var(--accent)' }, hint: 'Tension of a single curve / number of steps, pulses or waves' });
  tens.addEventListener('input', () => editSel((p) => { if ((p.type || 'single') === 'single') p.tension = tens.value / 100; else p.count = Math.max(1, Math.round(1 + (+tens.value + 100) / 200 * 31)); }, 'Segment shape', 'tens'));
  const lenIn = h('input.field', { type: 'number', min: 0.25, max: 256, step: 0.25, style: { width: '64px' }, hint: 'Length of the clip in bars (the curve loops when a playlist clip is longer)' });
  lenIn.addEventListener('keydown', (e) => e.stopPropagation());
  lenIn.addEventListener('change', () => cmd.setAutomationLength(store, chId, Math.max(STEP, Math.round(+lenIn.value * barTicks(store.project.timeSig)))));
  const readout = h('span.dim', { style: { flex: 'none', width: '190px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', textAlign: 'right' } }, '');
  const head = h('div.rack-head', targetBtn, h('div.pr-sep'), h('span.dim', 'Segment'), typeSel, tens, h('div.pr-sep'), h('span.dim', 'Bars'), lenIn,
    h('div.btn.sm', { hint: 'LFO tool — write a sine, triangle, saw, square or random curve over the clip', onclick: () => lfoTool() }, 'LFO…'),
    h('div.btn.sm', { hint: 'More tools: flip, steps, smooth, quantize, simplify, reset', onclick: (e) => { const r = e.currentTarget.getBoundingClientRect(); showPopup(toolItems(), r.left, r.bottom, r); } }, 'Tools ▾'),
    h('div.grow'), readout);
  const el = h('div.rack', head, wrap);

  // ---------------------------------------------------------------- helpers
  const pts = () => (ch() ? ch().points : []);
  const tx = (t) => LEFT + (t - view.x0) * view.px;
  const xt = (x) => (x - LEFT) / view.px + view.x0;
  const vy = (v) => TOP + (1 - v) * (H - TOP - RULER);
  const yv = (y) => clamp(1 - (y - TOP) / (H - TOP - RULER), 0, 1);
  const gridT = () => app.snapTicks({ cell: STEP, line: lineTicks() });
  const lineTicks = () => { const bar = barTicks(store.project.timeSig), c = [bar * 4, bar * 2, bar, PPQ, PPQ / 2, STEP, STEP / 2].map(Math.round); let b = c[0]; for (const x of c) if (x * view.px >= 12) b = x; return b; };
  const snapT = (t, ev) => { if (ev && ev.altKey) return Math.round(t); const g = gridT(); return Math.round(t / g) * g; };
  const fit = () => { view.px = Math.max(0.05, (W - LEFT - 24) / len()); view.x0 = 0; };

  const editSel = (fn, label, coalesce) => {
    if (sel < 0) return;
    const i = sel;
    cmd.editAutomation(store, chId, (list) => { if (list[i]) fn(list[i]); return list; }, label, coalesce ? `gesture:auto:${coalesce}` : undefined);
  };

  const pointAt = (x, y) => {
    let best = -1, bd = HIT * HIT;
    pts().forEach((p, i) => { const dx = tx(p.t) - x, dy = vy(p.v) - y, d = dx * dx + dy * dy; if (d <= bd) { bd = d; best = i; } });
    return best;
  };
  const segmentAt = (x) => {
    const list = pts(), t = xt(x);
    for (let i = 0; i < list.length - 1; i++) if (t >= list[i].t && t <= list[i + 1].t) return i;
    return -1;
  };

  // ---------------------------------------------------------------- drawing
  const draw = () => {
    const c = ch(); if (!c || !W) return;
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = '#25282b'; g.fillRect(0, 0, W, H);
    const d = def(), plotH = H - TOP - RULER;
    g.font = '10px "Segoe UI", system-ui, sans-serif'; g.textBaseline = 'middle';
    // horizontal value lines + labels
    for (let i = 0; i <= 4; i++) {
      const v = i / 4, y = vy(v);
      g.fillStyle = i === 0 || i === 4 ? 'rgba(255,255,255,.14)' : 'rgba(255,255,255,.07)'; g.fillRect(LEFT, Math.round(y), W - LEFT, 1);
      g.fillStyle = '#8e989f'; g.textAlign = 'right';
      g.fillText(d ? format(d, fromNorm(d, v)) : `${Math.round(v * 100)}%`, LEFT - 6, Math.min(H - RULER - 5, Math.max(TOP + 5, y)));
    }
    g.textAlign = 'left';
    // vertical grid
    const bar = barTicks(store.project.timeSig), beat = Math.round((PPQ * 4) / store.project.timeSig.den), L = len();
    const t0 = Math.max(0, view.x0), t1 = Math.min(xt(W), L * 8);
    const sub = lineTicks();
    if (sub * view.px >= 6) { g.fillStyle = 'rgba(255,255,255,.04)'; for (let t = Math.ceil(t0 / sub) * sub; t <= t1; t += sub) g.fillRect(Math.round(tx(t)), TOP, 1, plotH); }
    if (beat * view.px >= 8) { g.fillStyle = 'rgba(255,255,255,.08)'; for (let t = Math.ceil(t0 / beat) * beat; t <= t1; t += beat) g.fillRect(Math.round(tx(t)), TOP, 1, plotH); }
    g.fillStyle = 'rgba(255,255,255,.2)'; for (let t = Math.ceil(t0 / bar) * bar; t <= t1; t += bar) g.fillRect(Math.round(tx(t)), TOP, 1, plotH);
    // ruler
    g.fillStyle = '#2f3438'; g.fillRect(0, H - RULER, W, RULER);
    g.fillStyle = '#d5dce0';
    for (let t = Math.ceil(t0 / bar) * bar; t <= t1; t += bar) { const x = tx(t); if (x < W - 20) g.fillText(String(t / bar + 1), x + 4, H - RULER / 2); }
    // outside of the clip
    const ex = tx(L);
    if (ex < W) { g.fillStyle = 'rgba(0,0,0,.35)'; g.fillRect(Math.max(LEFT, ex), TOP, W - Math.max(LEFT, ex), plotH); g.fillStyle = 'rgba(255,176,46,.6)'; g.fillRect(Math.round(ex), TOP, 1, plotH); }
    // curve: filled area then line
    const list = pts();
    if (list.length) {
      g.beginPath();
      let first = true;
      for (let x = LEFT; x <= W; x += 2) {
        const t = xt(x);
        const v = t > L ? null : evalPoints(list, Math.max(0, t));
        if (v === null) continue;
        if (first) { g.moveTo(x, vy(v)); first = false; } else g.lineTo(x, vy(v));
      }
      g.strokeStyle = '#ffb02e'; g.lineWidth = 2; g.stroke();
      g.lineTo(Math.min(W, tx(L)), vy(0)); g.lineTo(LEFT, vy(0)); g.closePath();
      const grd = g.createLinearGradient(0, TOP, 0, H - RULER); grd.addColorStop(0, 'rgba(255,176,46,.28)'); grd.addColorStop(1, 'rgba(255,176,46,.02)');
      g.fillStyle = grd; g.fill();
      // bend handles on single-curve segments with tension, markers for other types
      list.forEach((p, i) => {
        if (i >= list.length - 1) return;
        const q = list[i + 1], mt = (p.t + q.t) / 2, mv = evalPoints(list, mt), x = tx(mt), y = vy(mv);
        if (x < LEFT || x > W) return;
        g.fillStyle = (p.type || 'single') === 'single' && !p.tension ? 'rgba(255,255,255,.35)' : '#4aa8e0';
        g.beginPath(); g.moveTo(x, y - 4); g.lineTo(x + 4, y); g.lineTo(x, y + 4); g.lineTo(x - 4, y); g.closePath(); g.fill();
      });
      list.forEach((p, i) => {
        const x = tx(p.t), y = vy(p.v);
        if (x < LEFT - 6 || x > W + 6) return;
        g.beginPath(); g.arc(x, y, i === sel ? 6 : 5, 0, 6.283);
        g.fillStyle = i === sel ? '#fff' : '#ffb02e'; g.fill();
        g.strokeStyle = '#1b1d20'; g.lineWidth = 1.5; g.stroke();
      });
    } else { g.fillStyle = '#6b757d'; g.textAlign = 'center'; g.fillText('Click to add the first point', (W + LEFT) / 2, H / 2); g.textAlign = 'left'; }
    // playhead (inside the clip being played)
    const st = app.host.st;
    if (st.playing) {
      const tick = app.transport.displayTick();
      const clip = store.arrangement.clips.find((cl) => cl.type === 'automation' && cl.ref === chId && tick >= cl.s && tick < cl.s + cl.l);
      if (clip) { const t = (tick - clip.s + clip.o) % L; g.fillStyle = '#fff'; g.fillRect(Math.round(tx(t)), TOP, 1, plotH); }
    }
    // hover readout
    if (hover) {
      g.fillStyle = 'rgba(255,255,255,.18)'; g.fillRect(Math.round(hover.x), TOP, 1, plotH);
    }
  };

  const syncUi = () => {
    const c = ch(); if (!c) return;
    const d = def();
    win.setTitle('Automation', c.name);
    targetBtn.textContent = c.target ? `Target: ${paramLabel(store.project, c.target)}` : 'Target: (choose a knob…)';
    lenIn.value = String(+(len() / barTicks(store.project.timeSig)).toFixed(3));
    const p = pts()[sel];
    typeSel.disabled = tens.disabled = !p || sel >= pts().length - 1;
    if (p) {
      typeSel.value = p.type || 'single';
      tens.value = (p.type || 'single') === 'single' ? String(Math.round((p.tension || 0) * 100)) : String(Math.round((((p.count || 4) - 1) / 31) * 200 - 100));
    }
    void d;
  };

  const loop = () => { raf = requestAnimationFrame(loop); if (app.host.st.playing) dirty = true; if (dirty) { dirty = false; draw(); } };
  const layout = () => {
    const r = wrap.getBoundingClientRect();
    if (!r.width || !r.height) return;
    dpr = window.devicePixelRatio || 1; W = Math.floor(r.width); H = Math.floor(r.height);
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    if (!view.userMoved) fit();                       // follows window resizes until the user zooms or scrolls
    dirty = true;
  };

  // ---------------------------------------------------------------- interaction
  const local = (e) => { const r = cv.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  const valueText = (v) => { const d = def(); return d ? format(d, fromNorm(d, v)) : `${Math.round(v * 100)}%`; };

  cv.addEventListener('pointermove', (e) => {
    const { x, y } = local(e);
    hover = { x, y };
    const t = Math.max(0, xt(x)), tm = barTicks(store.project.timeSig);
    readout.textContent = `bar ${Math.floor(t / tm) + 1}.${Math.floor((t % tm) / PPQ) + 1}   ·   ${valueText(yv(y))}`;
    cv.style.cursor = pointAt(x, y) >= 0 ? 'grab' : e.altKey ? 'ns-resize' : 'crosshair';
    dirty = true;
  });
  cv.addEventListener('pointerleave', () => { hover = null; dirty = true; });
  cv.addEventListener('contextmenu', (e) => e.preventDefault());
  cv.addEventListener('wheel', (e) => {
    e.preventDefault();
    view.userMoved = true;
    if (e.ctrlKey) { const { x } = local(e), t = xt(x); view.px = clamp(view.px * (e.deltaY < 0 ? 1.15 : 1 / 1.15), 0.02, 4); view.x0 = Math.max(0, t - (x - LEFT) / view.px); }
    else view.x0 = Math.max(0, view.x0 + (e.deltaY + e.deltaX) / view.px * 0.5);
    dirty = true;
  }, { passive: false });
  cv.addEventListener('dblclick', (e) => {
    const { x, y } = local(e), i = pointAt(x, y);
    if (i >= 0) { cmd.editAutomation(store, chId, (l) => { l.splice(i, 1); return l; }, 'Delete point'); sel = -1; syncUi(); dirty = true; }
  });

  cv.addEventListener('pointerdown', (e) => {
    if (!ch()) return;
    const { x, y } = local(e);
    const i = pointAt(x, y);
    if (e.button === 2) { rightClick(e, i, x); return; }
    if (e.button !== 0) return;
    if (i >= 0) { sel = i; syncUi(); movePoint(e, i); return; }
    const si = segmentAt(x);
    if (e.altKey && si >= 0) { bendSegment(e, si); return; }
    if (y >= H - RULER) return;
    // add a point and drag it straight away
    const t = Math.max(0, Math.min(len(), snapT(xt(x), e))), tk = token();
    const v = yv(y);
    let list = pts().map((p) => ({ ...p })), created = null;
    const existing = list.findIndex((p) => p.t === t);
    if (existing >= 0) { sel = existing; syncUi(); movePoint(e, existing); return; }
    created = { t, v, type: 'single', tension: 0, count: 4 };
    list.push(created);
    cmd.setAutomationPoints(store, chId, list, 'Add point', tk);
    sel = pts().findIndex((p) => p.t === t && p.v === v);
    syncUi();
    movePoint(e, sel, tk);
  });

  const movePoint = (e, index, tk = token()) => {
    const startPts = pts().map((p) => ({ ...p }));
    const target = startPts[index];
    const r = cv.getBoundingClientRect();
    let moved = false;
    drag(e, (dx, dy, ev) => {
      if (!moved && Math.abs(dx) < 2 && Math.abs(dy) < 2) return;
      moved = true;
      const list = startPts.map((p) => ({ ...p }));
      const p = list[index];
      const first = index === 0, last = index === list.length - 1;
      const prev = list[index - 1], next = list[index + 1];
      let t = snapT(xt(ev.clientX - r.left), ev);
      t = clamp(t, prev ? prev.t + 1 : 0, next ? next.t - 1 : len());
      if (first && !ev.shiftKey && target.t === 0) t = 0;
      void last;
      p.t = Math.round(t);
      p.v = ev.shiftKey ? target.v : yv(ev.clientY - r.top);
      cmd.setAutomationPoints(store, chId, list, 'Move point', tk);
      sel = index; dirty = true;
      readout.textContent = valueText(p.v);
    }, () => { syncUi(); dirty = true; });
  };

  const bendSegment = (e, si) => {
    const tk = token(), start = pts().map((p) => ({ ...p })), p0 = start[si];
    const r = cv.getBoundingClientRect(), sy = e.clientY, sx = e.clientX;
    sel = si; syncUi();
    drag(e, (dx, dy, ev) => {
      const list = start.map((p) => ({ ...p })), p = list[si];
      if ((p.type || 'single') === 'single') p.tension = clamp((p0.tension || 0) - (ev.clientY - sy) / 120 * (list[si + 1].v >= p.v ? 1 : -1), -1, 1);
      else p.count = clamp(Math.round((p0.count || 4) + (ev.clientX - sx) / 18), 1, 32);
      cmd.setAutomationPoints(store, chId, list, 'Bend segment', tk);
      dirty = true; void r;
    }, () => syncUi());
  };

  const typeItems = (apply) => CURVE_TYPES.map((t) => ({ label: t.name, fn: () => apply(t.id) }));
  const rightClick = (e, i, x) => {
    const si = i >= 0 ? i : segmentAt(x);
    const list = pts();
    const items = [];
    if (i >= 0) {
      sel = i; syncUi(); dirty = true;
      items.push({ label: 'Delete point', fn: () => { cmd.editAutomation(store, chId, (l) => { l.splice(i, 1); return l; }, 'Delete point'); sel = -1; syncUi(); } },
        { label: 'Set value…', fn: async () => { const v = await formDialog('Point value', [{ id: 'p', label: 'Value', type: 'number', min: 0, max: 100, step: 0.1, value: +(list[i].v * 100).toFixed(2), unit: '%' }], { ok: 'Set' }); if (v) editSel((p) => { p.v = clamp(v.p / 100, 0, 1); }, 'Set value'); } },
        { sep: true });
    }
    if (si >= 0 && si < list.length - 1) {
      items.push({ title: 'Segment type' }, ...typeItems((type) => cmd.editAutomation(store, chId, (l) => { if (l[si]) l[si].type = type; return l; }, 'Segment type')));
    }
    if (!items.length) items.push({ label: 'Add LFO…', fn: () => lfoTool() });
    contextMenu(e, items);
  };

  // ---------------------------------------------------------------- tools
  const lfoTool = async () => {
    const L = len();
    const v = await formDialog('LFO tool', [
      { id: 'shape', label: 'Shape', type: 'select', value: 0, options: LFO_TOOL_SHAPES.map((n, k) => [k, n]) },
      { id: 'cycles', label: 'Cycles in the clip', type: 'number', min: 0.25, max: 256, step: 0.25, value: 4 },
      { id: 'amp', label: 'Amplitude', type: 'range', min: 0, max: 100, value: 100, unit: '%' },
      { id: 'center', label: 'Centre', type: 'range', min: 0, max: 100, value: 50, unit: '%' },
      { id: 'phase', label: 'Phase', type: 'range', min: 0, max: 100, value: 0, unit: '%' },
      { id: 'ppc', label: 'Points per cycle (sine)', type: 'number', min: 6, max: 64, value: 24 },
      { id: 'seed', label: 'Seed (random shapes)', type: 'number', min: 1, max: 99999, value: 1 },
    ], { ok: 'Write curve' });
    if (!v) return;
    const out = generateLfoPoints(L, { shape: v.shape, cycles: v.cycles, amp: v.amp / 100, center: v.center / 100, phase: v.phase / 100, pointsPerCycle: v.ppc, seed: v.seed });
    cmd.setAutomationPoints(store, chId, out, 'LFO tool');
    sel = -1; syncUi(); dirty = true;
  };
  const toolItems = () => [
    { label: 'Flip vertically', fn: () => cmd.editAutomation(store, chId, (l) => l.map((p) => ({ ...p, v: 1 - p.v, tension: -(p.tension || 0) })), 'Flip automation') },
    { label: 'Make all segments smooth', fn: () => cmd.editAutomation(store, chId, (l) => l.map((p) => ({ ...p, type: 'smooth' })), 'Smooth automation') },
    { label: 'Turn into hold (steps)', fn: () => cmd.editAutomation(store, chId, (l) => l.map((p) => ({ ...p, type: 'hold' })), 'Hold automation') },
    { label: 'Quantize points to the snap grid', fn: () => cmd.editAutomation(store, chId, (l, c) => { const g = gridT(); const out = []; for (const p of l) { const t = clamp(Math.round(p.t / g) * g, 0, c.len); if (out.length && out[out.length - 1].t === t) out[out.length - 1] = { ...p, t }; else out.push({ ...p, t }); } return out; }, 'Quantize automation') },
    { label: 'Simplify (remove redundant points)', fn: () => cmd.editAutomation(store, chId, (l) => thinPoints(l), 'Simplify automation') },
    { sep: true },
    { label: 'Reset to a flat line at the current value', fn: () => { const d = def(), v = d ? toNorm(d, store.getParam(ch().target) ?? d.def) : 0.5; cmd.setAutomationPoints(store, chId, [{ t: 0, v, type: 'single', tension: 0, count: 4 }, { t: len(), v, type: 'single', tension: 0, count: 4 }], 'Reset automation'); sel = -1; syncUi(); } },
    { label: 'Clear all points', fn: () => { cmd.setAutomationPoints(store, chId, [], 'Clear automation'); sel = -1; syncUi(); } },
  ];

  const keyHandler = (e) => {
    if (!win.open || !win.el.classList.contains('active')) return false;
    if (e.target && ['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName)) return false;
    if ((e.key === 'Delete' || e.key === 'Backspace') && sel >= 0) { const i = sel; cmd.editAutomation(store, chId, (l) => { l.splice(i, 1); return l; }, 'Delete point'); sel = -1; syncUi(); dirty = true; return true; }
    return false;
  };
  app.keyHooks.add(keyHandler);

  const subs = [
    store.bus.on('change', ({ paths }) => { if (paths.some((p) => p[0] === 'channels' || p[0] === 'timeSig')) { if (!ch()) { win.close(); return; } sel = Math.min(sel, pts().length - 1); syncUi(); dirty = true; } }),
    store.bus.on('project', () => { if (!ch()) win.close(); else { syncUi(); dirty = true; } }),
    store.bus.on('snap', () => { dirty = true; }),
    store.bus.on('param', (a) => { if (ch() && a === ch().target) dirty = true; }),
  ];
  syncUi();
  raf = requestAnimationFrame(loop);
  requestAnimationFrame(layout);
  const ro = new ResizeObserver(() => layout());      // the header may change height; keep the canvas in step
  ro.observe(wrap);
  return { el, onResize: layout, onShow: layout, destroy() { ro.disconnect(); cancelAnimationFrame(raf); for (const s of subs) s(); app.keyHooks.delete(keyHandler); } };
}
