// Visual panels of the Scope, Peak controller and Polish effect windows (see fx-window.js). The engine sends their
// data only while the window is open: 'spectrum' + 'fxview' (Scope) and 'fxmeter' (Peak controller, Polish).
import { h, clamp, clear, hiDPI } from './h.js';
import { t as tr } from './i18n.js';
import { paramLabel } from '../core/addr.js';
import { COLUMNS, VECTOR_POINTS } from '../core/effects/scope.js';
import { MODES } from '../core/effects/polish.js';
import { pickParam } from './param-picker.js';

const BG = '#0e1012', GRID = '#1f2529', LABEL = '#5b666e', COL_L = '#ffb02e', COL_R = '#4aaedc';
const dbOf = (a) => 20 * Math.log10(a + 1e-9);

// ======================================================================================= Scope
// layout (logical pixels): meters column on the right; 'All' = oscilloscope + vectorscope above the spectrum
export function scopePanel(app, track, slotIdx, host, state) {
  const W = 680, H = 360, MW = 84;
  const canvas = h('canvas.fx-scope', { width: W, height: H, style: { width: '100%', maxWidth: `${W}px`, height: 'auto', aspectRatio: `${W}/${H}`, background: BG, display: 'block', borderBottom: '1px solid #000' }, hint: 'Live view of the signal in this slot: oscilloscope, spectrum, vectorscope and levels' });
  host.append(canvas);
  const g = hiDPI(canvas).g;
  const params = () => app.store.project.mixer.tracks[track].fx[slotIdx]?.params || {};
  const sr = app.host.sampleRate;
  const meter = { pk: [0, 0], hold: [0, 0], holdT: [0, 0], last: performance.now() };
  let specHold = null, frames = 0;

  const label = (text, x, y) => { g.fillStyle = LABEL; g.font = '10px sans-serif'; g.fillText(tr(text), x, y); };
  const frame = (x, y, w, hh) => { g.strokeStyle = GRID; g.lineWidth = 1; g.strokeRect(x + 0.5, y + 0.5, w - 1, hh - 1); };

  const scopeView = (v, p, x0, y0, w, hh) => {
    frame(x0, y0, w, hh);
    const mid = y0 + hh / 2, k = (hh / 2 - 4) * Math.pow(10, (p.zoom || 0) / 20);
    g.strokeStyle = GRID; g.beginPath(); g.moveTo(x0, mid + 0.5); g.lineTo(x0 + w, mid + 0.5); g.stroke();
    label(`${(p.time || 20) < 10 ? (p.time || 20).toFixed(1) : Math.round(p.time || 20)} ms`, x0 + 4, y0 + 12);
    if (!v) return;
    for (let c = 1; c >= 0; c--) {                      // R under L
      const off = c * 2;
      g.beginPath();
      for (let i = 0; i < COLUMNS; i++) { const x = x0 + ((i + 0.5) / COLUMNS) * w, y = clamp(mid - v.wave[i * 4 + off + 1] * k, y0, y0 + hh); if (i) g.lineTo(x, y); else g.moveTo(x, y); }
      for (let i = COLUMNS - 1; i >= 0; i--) g.lineTo(x0 + ((i + 0.5) / COLUMNS) * w, clamp(mid - v.wave[i * 4 + off] * k, y0, y0 + hh));
      g.closePath();
      g.fillStyle = c ? 'rgba(74,174,220,.35)' : 'rgba(255,176,46,.35)'; g.fill();
      g.strokeStyle = c ? COL_R : COL_L; g.lineWidth = 1.2; g.stroke();
    }
  };

  const fx = (f, x0, w) => x0 + (Math.log(f / 20) / Math.log(1000)) * w;
  const specView = (spec, p, x0, y0, w, hh) => {
    frame(x0, y0, w, hh);
    const floor = p.floor ?? -90, tilt = p.tilt || 0;
    const yOf = (db) => y0 + 4 + clamp(-db / -floor, 0, 1) * (hh - 16);
    g.font = '10px sans-serif';
    for (const f of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) { const x = fx(f, x0, w); g.strokeStyle = GRID; g.beginPath(); g.moveTo(x + 0.5, y0); g.lineTo(x + 0.5, y0 + hh); g.stroke(); g.fillStyle = LABEL; g.fillText(f >= 1000 ? `${f / 1000}k` : String(f), x + 3, y0 + hh - 3); }
    for (let d = -12; d > floor; d -= 12) { const y = yOf(d); g.strokeStyle = GRID; g.beginPath(); g.moveTo(x0, y + 0.5); g.lineTo(x0 + w, y + 0.5); g.stroke(); g.fillStyle = LABEL; g.fillText(`${d}`, x0 + 3, y - 2); }
    if (!spec) return;
    const n = Math.floor(w / 2);
    if (!specHold || specHold.length !== n + 1) specHold = new Float32Array(n + 1).fill(-200);
    g.beginPath(); g.moveTo(x0, y0 + hh);
    const pts = [];
    for (let j = 0; j <= n; j++) {
      const f = 20 * Math.pow(1000, j / n), kf = Math.min(1022, (f / (sr / 2)) * 1024), b = Math.floor(kf);
      const db = spec[b] + (spec[b + 1] - spec[b]) * (kf - b) + tilt * Math.log2(f / 1000);
      specHold[j] = p.hold ? Math.max(db, specHold[j] - 0.4) : db;
      const y = yOf(db); pts.push(y); g.lineTo(x0 + j * 2, y);
    }
    g.lineTo(x0 + n * 2, y0 + hh); g.closePath();
    g.fillStyle = 'rgba(255,176,46,.25)'; g.fill();
    g.strokeStyle = COL_L; g.lineWidth = 1.2; g.beginPath(); pts.forEach((y, j) => (j ? g.lineTo(x0 + j * 2, y) : g.moveTo(x0, y))); g.stroke();
    if (p.hold) { g.strokeStyle = 'rgba(255,255,255,.45)'; g.lineWidth = 1; g.beginPath(); for (let j = 0; j <= n; j++) { const y = yOf(specHold[j]); if (j) g.lineTo(x0 + j * 2, y); else g.moveTo(x0, y); } g.stroke(); }
  };

  const vectorView = (v, p, x0, y0, w, hh) => {
    frame(x0, y0, w, hh);
    const s = Math.min(w, hh) - 8, cx = x0 + w / 2, cy = y0 + hh / 2, r = s / 2, k = r * 0.7071 * Math.pow(10, (p.zoom || 0) / 20);
    g.strokeStyle = GRID; g.beginPath(); g.moveTo(cx - r, cy - r); g.lineTo(cx + r, cy + r); g.moveTo(cx + r, cy - r); g.lineTo(cx - r, cy + r); g.moveTo(cx, cy - r); g.lineTo(cx, cy + r); g.stroke();
    label('L', cx - r + 2, cy - r + 10); label('R', cx + r - 8, cy - r + 10);
    if (!v) return;
    g.fillStyle = 'rgba(127,220,92,.75)';
    for (let i = 0; i < VECTOR_POINTS; i++) {
      const l = v.vec[i * 2], rr = v.vec[i * 2 + 1];
      const x = cx + (rr - l) * k, y = cy - (l + rr) * k;          // mono = vertical line, left channel alone = upper-left diagonal
      if (x > x0 && x < x0 + w && y > y0 && y < y0 + hh) g.fillRect(x - 0.75, y - 0.75, 1.5, 1.5);
    }
  };

  const meters = (v, x0, y0, w, hh) => {
    frame(x0, y0, w, hh);
    const now = performance.now(), dt = (now - meter.last) / 1000; meter.last = now;
    const top = y0 + 14, bot = y0 + hh - 44, yOf = (db) => top + clamp((6 - db) / 66, 0, 1) * (bot - top);
    g.font = '9px sans-serif';
    for (const d of [0, -6, -12, -24, -48]) { const y = yOf(d); g.fillStyle = LABEL; g.fillText(String(d), x0 + w - 18, y + 3); g.fillStyle = GRID; g.fillRect(x0 + 4, y, w - 26, 1); }
    for (let c = 0; c < 2; c++) {
      const peak = v ? v.peak[c] : 0, rms = v ? v.rms[c] : 0;
      meter.pk[c] = Math.max(peak, meter.pk[c] * Math.pow(10, (-20 * dt) / 20));        // falls 20 dB/s
      if (meter.pk[c] >= meter.hold[c] || now - meter.holdT[c] > 1500) { meter.hold[c] = meter.pk[c]; meter.holdT[c] = now; }
      const bx = x0 + 8 + c * 26, bw = 20;
      g.fillStyle = '#16191c'; g.fillRect(bx, top, bw, bot - top);
      const yp = yOf(dbOf(meter.pk[c])), yr = yOf(dbOf(rms));
      g.fillStyle = c ? 'rgba(74,174,220,.45)' : 'rgba(255,176,46,.45)'; g.fillRect(bx, yp, bw, bot - yp);
      g.fillStyle = c ? COL_R : COL_L; g.fillRect(bx + 4, yr, bw - 8, bot - yr);
      g.fillStyle = meter.hold[c] > 1 ? '#e35d5d' : '#e9eef1'; g.fillRect(bx, yOf(dbOf(meter.hold[c])), bw, 2);
      label(c ? 'R' : 'L', bx + 7, bot + 11);
    }
    // correlation: -1 (out of phase) .. +1 (mono)
    const cy = y0 + hh - 16, cw = w - 12, cx0 = x0 + 6;
    g.fillStyle = '#16191c'; g.fillRect(cx0, cy, cw, 8);
    g.fillStyle = GRID; g.fillRect(cx0 + cw / 2, cy - 2, 1, 12);
    const corr = v ? v.corr : null;
    if (corr !== null && corr !== undefined) { const x = cx0 + ((corr + 1) / 2) * cw; g.fillStyle = corr < 0 ? '#e35d5d' : '#7fdc5c'; g.fillRect(Math.min(x, cx0 + cw / 2), cy, Math.abs(x - (cx0 + cw / 2)) + 1, 8); }
    g.fillStyle = '#d5dce0'; g.font = '10px sans-serif';
    g.fillText(corr === null || corr === undefined ? tr('corr —') : tr(`corr ${corr >= 0 ? '+' : ''}${corr.toFixed(2)}`), cx0, cy - 4);
  };

  return () => {
    const p = params(), v = state.view, view = p.view | 0;
    g.fillStyle = BG; g.fillRect(0, 0, W, H);
    const mw = W - MW;
    if (view === 1) scopeView(v, p, 0, 0, mw, H);
    else if (view === 2) specView(state.spec, p, 0, 0, mw, H);
    else if (view === 3) vectorView(v, p, 0, 0, mw, H);
    else {
      const top = Math.round(H * 0.5), vw = 200;
      scopeView(v, p, 0, 0, mw - vw, top);
      vectorView(v, p, mw - vw, 0, vw, top);
      specView(state.spec, p, 0, top, mw, H - top);
    }
    meters(v, mw, 0, MW, H);
    if (!v && !state.spec) { g.fillStyle = '#8e989f'; g.font = '12px sans-serif'; g.fillText(tr('Play something through this track to see it'), 16, H / 2 - 30); }
    else { frames++; canvas.dataset.frames = frames; }
  };
}

// ======================================================================================= Peak controller
// level history (detected level and the output value) and the list of linked parameters
export function peakPanel(app, track, slotIdx, host, state, subs) {
  const store = app.store, cmd = app.cmd;
  const W = 640, H = 80, N = 300;
  const canvas = h('canvas', { width: W, height: H, style: { width: '100%', maxWidth: `${W}px`, height: 'auto', aspectRatio: `${W}/${H}`, background: BG, display: 'block', borderBottom: '1px solid #000' }, hint: 'Detected level (filled) and the value sent to the linked knobs (line)' });
  const list = h('div.scroll', { style: { maxHeight: '150px', padding: '2px 8px' } });
  host.append(canvas, h('div.mx-title', 'Linked parameters'), list);
  const g = hiDPI(canvas).g;
  const live = () => store.project.mixer.tracks[track].fx[slotIdx];
  const lv = [], out = [];

  const render = () => {
    clear(list);
    const s = live();
    if (!s || !Array.isArray(s.links)) return;
    if (!s.links.length) list.append(h('div.dim', { style: { padding: '6px 4px' } }, 'Nothing linked yet. Right-click any knob → Link to controller → this Peak controller, or use + Link parameter.'));
    s.links.forEach((l, i) => {
      const range = (key, text) => {
        const inp = h('input', { type: 'range', min: 0, max: 100, value: Math.round(l[key] * 100), style: { width: '90px', accentColor: '#b968d6' }, hint: `${text} of the linked knob's range that the controller maps to` });
        inp.addEventListener('input', () => cmd.updateFxLink(store, track, slotIdx, i, { [key]: inp.value / 100 }, `fxlink:${track}:${slotIdx}:${i}:${key}`));
        return inp;
      };
      list.append(h('div.row.fx-link', { style: { gap: '8px', padding: '3px 0', borderBottom: '1px solid #1b1e21' } },
        h('div', { style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, hint: l.addr }, paramLabel(store.project, l.addr)),
        h('span.dim', 'min'), range('min', 'Minimum'), h('span.dim', 'max'), range('max', 'Maximum'),
        h('div.btn.sm' + (l.inv ? '.on' : ''), { hint: 'Invert the controller for this link', onclick: () => cmd.updateFxLink(store, track, slotIdx, i, { inv: l.inv ? 0 : 1 }) }, 'Inv'),
        h('div.btn.sm', { hint: 'Remove this link', onclick: () => cmd.unlinkFxController(store, track, slotIdx, l.addr) }, '✕')));
    });
    list.append(h('div.row', { style: { padding: '6px 0' } }, h('div.btn', { hint: 'Choose a parameter from a list', onclick: async () => {
      const a = await pickParam(app, { title: 'Link which parameter?' });
      if (a) cmd.linkFxController(store, track, slotIdx, a, { min: 0, max: 1, inv: 0 });
    } }, '＋ Link parameter…')));
  };
  render();
  subs.push(store.bus.on('change', ({ paths }) => { if (paths.some((p) => p[0] === 'mixer' || p[0] === 'channels') && live() && !list.contains(document.activeElement)) render(); }));
  subs.push(store.bus.on('project', () => { if (live()) render(); }));

  return () => {
    const m = state.meters || [];
    lv.push(m[0] || 0); out.push(m[1] || 0);
    if (lv.length > N) { lv.shift(); out.shift(); }
    g.fillStyle = BG; g.fillRect(0, 0, W, H);
    g.fillStyle = GRID; for (const f of [0.25, 0.5, 0.75]) g.fillRect(0, 4 + (1 - f) * (H - 8), W, 1);
    const x = (i) => (i / N) * W, y = (v) => 4 + (1 - clamp(v, 0, 1)) * (H - 8);
    g.beginPath(); g.moveTo(0, H);
    lv.forEach((v, i) => g.lineTo(x(i), y(v)));
    g.lineTo(x(lv.length - 1), H); g.closePath(); g.fillStyle = 'rgba(185,104,214,.35)'; g.fill();
    g.strokeStyle = '#e9eef1'; g.lineWidth = 1.5; g.beginPath();
    out.forEach((v, i) => (i ? g.lineTo(x(i), y(v)) : g.moveTo(x(i), y(v)))); g.stroke();
    g.fillStyle = '#d5dce0'; g.font = '11px sans-serif';
    g.fillText(tr(`level ${Math.round((m[0] || 0) * 100)}%  ·  output ${Math.round((m[1] || 0) * 100)}%`), 8, H - 8);
  };
}

// ======================================================================================= Polish
// mode buttons and the net gain of the three compressor bands
export function polishPanel(app, track, slotIdx, host, state, subs) {
  const store = app.store;
  const W = 640, H = 64;
  const addr = `mx:${track}:fx:${slotIdx}:p:mode`;
  const hints = ['Warm — thicker and rounder, a little darker', 'Bright — presence and air on top', 'Wide — opens the stereo image, keeps the bass centred', 'Punch — denser, lets the hits through'];
  const btns = MODES.map((name, i) => h('div.btn', { hint: hints[i], dataset: { mode: i }, style: { flex: 1 }, onclick: () => store.setParam(addr, i) }, name));
  const sync = () => { const m = store.getParam(addr) ?? 0; btns.forEach((b, i) => b.classList.toggle('on', i === m)); };
  const canvas = h('canvas', { width: W, height: H, style: { width: '100%', maxWidth: `${W}px`, height: 'auto', aspectRatio: `${W}/${H}`, background: BG, display: 'block', borderBottom: '1px solid #000' }, hint: 'How much each band is turned up or down right now (dB)' });
  host.append(h('div.row', { style: { gap: '6px', padding: '6px 8px' } }, btns), canvas);
  sync();
  subs.push(store.bus.on('param', (a) => { if (a === addr) sync(); }), store.bus.on('change', sync), store.bus.on('project', sync));
  const g = hiDPI(canvas).g;
  const names = ['Low band', 'Mid band', 'High band'];
  return () => {
    const m = state.meters || [];
    g.fillStyle = BG; g.fillRect(0, 0, W, H);
    const cx = 110 + (W - 170) / 2, k = (W - 170) / 2 / 12;     // ±12 dB
    g.fillStyle = GRID; g.fillRect(cx, 2, 1, H - 4);
    for (let b = 0; b < 3; b++) {
      const v = clamp(m[b] || 0, -12, 12), y = 6 + b * 19;
      g.fillStyle = '#16191c'; g.fillRect(110, y, W - 170, 13);
      g.fillStyle = v < 0 ? 'rgba(230,90,75,.7)' : 'rgba(127,220,92,.7)';
      g.fillRect(Math.min(cx, cx + v * k), y, Math.abs(v * k) + 1, 13);
      g.fillStyle = '#d5dce0'; g.font = '10px sans-serif';
      g.fillText(tr(names[b]), 8, y + 10);
      g.fillText(`${v >= 0 ? '+' : ''}${v.toFixed(1)} dB`, W - 44, y + 10);
    }
  };
}
