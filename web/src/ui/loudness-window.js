// Loudness meter (EBU R128 / BS.1770) of the master output: momentary and short-term history, integrated loudness of
// the current playthrough, loudness range, true peak and stereo correlation. "Analyse song" renders the whole
// arrangement offline in the export worker and reports the same values for the file an export would produce.
import { h } from './h.js';
import { fmtLufs } from '../core/loudness.js';
import { renderInWorker } from '../host/export/render-client.js';

const TARGETS = [[-9, 'Club −9'], [-14, 'Streaming −14'], [-16, 'Apple / podcast −16'], [-23, 'Broadcast −23']];
const KEY = 'stepwise.loudness.target';
const HIST = 600;                                                        // 10 values a second: one minute of history

export function createLoudnessWindow(win, app) {
  win.setTitle('Loudness meter');
  let target = -14;
  try { target = +localStorage.getItem(KEY) || -14; } catch (_) { /* private mode */ }
  const big = h('div.ld-big', '−∞'), bigUnit = h('div.ld-unit', 'LUFS integrated');
  const val = () => h('b', '—');
  const cells = { m: val(), s: val(), lra: val(), tp: val(), mmax: val(), smax: val() };
  const cell = (label, el, hint) => h('div.ld-cell', { hint }, h('span.dim', label), el);
  const grid = h('div.ld-grid',
    cell('Momentary', cells.m, 'Loudness of the last 400 ms'), cell('Short-term', cells.s, 'Loudness of the last 3 s'),
    cell('Range (LRA)', cells.lra, 'Loudness range: spread between the quiet and loud parts (EBU Tech 3342)'),
    cell('True peak', cells.tp, 'Highest peak since playback started, including peaks between samples (4× oversampled)'),
    cell('Max momentary', cells.mmax), cell('Max short-term', cells.smax));
  const corrBar = h('i.ld-corr-dot'), corrTxt = h('span', '0.00');
  const corr = h('div.ld-corr', { hint: 'Stereo correlation: +1 mono, 0 wide, below 0 phase problems (cancels in mono)' }, h('span.dim', '−1'), h('div.ld-corr-track', corrBar), h('span.dim', '+1'), corrTxt);
  const canvas = h('canvas.ld-graph', { width: 600, height: 150 });
  const tSel = h('select.select', { hint: 'Target loudness: the line in the graph, and the colour of the integrated value' }, TARGETS.map(([v, l]) => h('option', { value: v }, l)));
  tSel.value = String(target);
  tSel.addEventListener('change', () => { target = +tSel.value; try { localStorage.setItem(KEY, tSel.value); } catch (_) { /* ignore */ } });
  const report = h('div.ld-report.dim', 'Analyse the whole song as it would export: integrated loudness, range and true peak of the final file.');
  const analyse = h('div.btn', { hint: 'Render the song offline (like Export) and measure it', onclick: () => run() }, 'Analyse song');
  const reset = h('div.btn', { hint: 'Start the integrated value, range and maxima over (also happens whenever playback starts)', onclick: () => { app.host.resetLoudness(); hist.fill(-Infinity); histS.fill(-Infinity); } }, 'Reset');
  const el = h('div.rack.ld', h('div.rack-head', tSel, h('div.grow'), reset, analyse),
    h('div.ld-top', h('div.ld-main', big, bigUnit), grid), corr, canvas, report);

  const hist = new Float32Array(HIST).fill(-Infinity), histS = new Float32Array(HIST).fill(-Infinity);
  let head = 0, lastPush = 0, raf = 0, busy = false;
  const c2 = canvas.getContext('2d');
  const set = (e, t) => { if (e.textContent !== t) e.textContent = t; };

  function frame(now) {
    raf = requestAnimationFrame(frame);
    if (!win.open) return;
    const [m, s, i, lra, tp, mmax, smax, cr] = app.host.loud;
    set(big, Number.isFinite(i) ? i.toFixed(1).replace('-', '−') : '−∞');
    big.style.color = !Number.isFinite(i) ? '' : Math.abs(i - target) <= 1 ? 'var(--green, #6c6)' : i > target ? 'var(--red)' : 'var(--accent)';
    set(cells.m, fmtLufs(m)); set(cells.s, fmtLufs(s)); set(cells.lra, `${(lra || 0).toFixed(1)} LU`);
    set(cells.tp, fmtLufs(tp, ' dBTP')); cells.tp.style.color = tp > -1 ? 'var(--red)' : '';
    set(cells.mmax, fmtLufs(mmax)); set(cells.smax, fmtLufs(smax));
    corrBar.style.left = `${((cr + 1) / 2) * 100}%`; corrBar.style.background = cr < 0 ? 'var(--red)' : '';
    set(corrTxt, (cr >= 0 ? '+' : '−') + Math.abs(cr).toFixed(2));
    if (now - lastPush >= 100) { lastPush = now; hist[head] = m; histS[head] = s; head = (head + 1) % HIST; draw(); }
  }

  function draw() {
    const dpr = window.devicePixelRatio || 1, cw = Math.round(canvas.clientWidth * dpr), ch = Math.round(canvas.clientHeight * dpr);
    if (cw > 0 && ch > 0 && (canvas.width !== cw || canvas.height !== ch)) { canvas.width = cw; canvas.height = ch; }
    const W = canvas.width, H = canvas.height, lo = -48, hi = 0;
    c2.setTransform(1, 0, 0, 1, 0, 0);
    const y = (v) => H - ((Math.max(lo, Math.min(hi, v)) - lo) / (hi - lo)) * H;
    c2.fillStyle = '#0e1012'; c2.fillRect(0, 0, W, H);
    c2.font = `${Math.round(10 * dpr)}px sans-serif`; c2.fillStyle = '#5b636b'; c2.strokeStyle = '#1d2226'; c2.lineWidth = 1;
    for (let d = -42; d < 0; d += 6) { c2.beginPath(); c2.moveTo(0, y(d) + 0.5); c2.lineTo(W, y(d) + 0.5); c2.stroke(); c2.fillText(String(d), 3 * dpr, y(d) - 2 * dpr); }
    c2.strokeStyle = '#3f7fbf'; c2.setLineDash([4, 3]); c2.beginPath(); c2.moveTo(0, y(target)); c2.lineTo(W, y(target)); c2.stroke(); c2.setLineDash([]);
    const line = (arr, color, width) => {
      c2.strokeStyle = color; c2.lineWidth = width * dpr; c2.beginPath();
      let pen = false;
      for (let k = 0; k < HIST; k++) {
        const v = arr[(head + k) % HIST], x = (k / (HIST - 1)) * W;
        if (!Number.isFinite(v) || v < lo) { pen = false; continue; }
        if (pen) c2.lineTo(x, y(v)); else { c2.moveTo(x, y(v)); pen = true; }
      }
      c2.stroke();
    };
    line(hist, 'rgba(255,176,46,0.55)', 1);
    line(histS, '#ffb02e', 2);
  }

  async function run() {
    if (busy) return;
    busy = true; analyse.classList.add('disabled');
    report.textContent = 'Rendering…';
    try {
      const project = app.store.project;
      const samples = [...app.bank.map].map(([id, e]) => ({ id, rate: e.rate, channels: e.channels }));
      const job = { project: JSON.parse(JSON.stringify(project)), samples, opts: { mode: 'song', sampleRate: 44100, tail: 'auto', target: 'off' }, stems: false, packs: app.packs ? app.packs.sources() : [] };
      const out = await renderInWorker(job, { onProgress: (f) => { report.textContent = `Rendering… ${Math.round(f * 100)}%`; } }).promise;
      const r = out && out.result && out.result.report;
      if (!r) { report.textContent = 'Nothing to measure: the song is empty.'; return; }
      const b = r.before, secs = out.result.frames / out.result.sampleRate;
      const diff = Number.isFinite(b.integrated) ? target - b.integrated : 0;
      report.textContent = `Song (${secs.toFixed(1)} s): ${fmtLufs(b.integrated)} integrated · range ${b.range.toFixed(1)} LU · true peak ${fmtLufs(b.truePeak, ' dBTP')} · max short-term ${fmtLufs(b.shortTermMax)}. `
        + (Math.abs(diff) < 0.5 ? 'On target.' : `${diff > 0 ? 'Raise' : 'Lower'} by ${Math.abs(diff).toFixed(1)} dB for ${target} LUFS (Export can do this: Loudness → ${target} LUFS).`);
      report.classList.remove('dim');
      app.lastLoudness = b;
    } catch (err) {
      report.textContent = String(err.message || err);
    } finally { busy = false; analyse.classList.remove('disabled'); }
  }

  raf = requestAnimationFrame(frame);
  return { el, onShow: draw, destroy() { cancelAnimationFrame(raf); }, analyse: run };
}
