// "Export" dialog: format and quality, what to render, sample rate, tail, dither, normalise, split mixer
// tracks into stems. Rendering runs in a worker with a progress bar and a Cancel button.
import { h } from './h.js';
import { modal } from './dialog.js';
import { FORMATS, defaultSettings, exportProject } from '../app/export.js';
import { currentArrangement } from '../core/project.js';

const KEY = 'stepwise.export';
const load = () => { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch (_) { return {}; } };

export function openExportDialog(app) {
  const project = app.store.project;
  const s = { ...defaultSettings(project), ...load() };
  s.name = defaultSettings(project).name;
  const arr = currentArrangement(project);
  const sel = (opts, value, hint) => { const el = h('select.select', { hint, style: { flex: 1 } }, opts.map(([v, l]) => h('option', { value: String(v) }, l))); el.value = String(value); return el; };
  const row = (label, el, note) => h('div.row', { style: { margin: '6px 0' } }, h('span', { style: { width: '120px' } }, label), el, note ? h('span.dim', { style: { fontSize: '10px' } }, note) : null);
  const fmtSel = sel(Object.entries(FORMATS).map(([k, f]) => [k, f.label]), s.format, 'File format');
  const qSel = sel([], s.quality, 'Bit depth or bitrate');
  const srcSel = sel([['song', 'Song (playlist arrangement)'], ['pat', 'Current pattern'], ['loop', arr.loop ? 'Loop region of the playlist' : 'Loop region (none set)']], s.source, 'What to export');
  const rateSel = sel([[44100, '44.1 kHz'], [48000, '48 kHz'], [96000, '96 kHz']], s.rate, 'Sample rate of the file');
  const tailSel = sel([['auto', 'Auto (until the sound dies)'], ['cut', 'Cut at the end'], [2, '2 seconds'], [4, '4 seconds'], [8, '8 seconds']], s.tail, 'Time added after the last note so reverbs, delays and releases can ring out');
  const chk = (label, value, hint) => { const c = h('input', { type: 'checkbox', checked: !!value }); return { c, el: h('label.row', { style: { margin: '4px 0', gap: '8px' }, title: hint }, c, label) }; };
  const dither = chk('Dither (when reducing to 16 bit or MP3)', s.dither, 'Adds a little noise that hides rounding distortion');
  const norm = chk('Normalise to −0.1 dBFS', s.normalize, 'Scales the whole file so its loudest peak just touches full scale');
  const stems = chk('Split mixer tracks (one file per insert, as a ZIP)', s.stems, 'Renders each used mixer insert on its own, including its route to the master');
  const keep = chk('Keep a copy in the Browser (Rendered), up to 60 s', s.keep, 'Short exports can be dragged back into the project from the Browser');
  const nameIn = h('input.field', { type: 'text', value: s.name, style: { flex: 1 } });
  nameIn.addEventListener('keydown', (e) => e.stopPropagation());
  const note = h('div.dim', { style: { fontSize: '10px', minHeight: '28px', marginTop: '4px' } }, '');
  const fillQuality = () => {
    const f = FORMATS[fmtSel.value];
    qSel.textContent = '';
    for (const [v, l] of f.qualities) qSel.append(h('option', { value: v }, l));
    qSel.value = f.qualities.some(([v]) => v === s.quality) ? s.quality : f.def;
    qSel.disabled = !f.qualities.length;
    const audio = fmtSel.value !== 'mid';
    for (const el of [rateSel, tailSel, dither.c, norm.c, stems.c, keep.c]) el.disabled = !audio;
    rateSel.disabled = !audio || fmtSel.value === 'ogg';
    srcSel.querySelector('option[value=loop]').disabled = fmtSel.value === 'mid';
    note.textContent = fmtSel.value === 'ogg' ? 'OGG files use Opus and are always rendered at 48 kHz.' : fmtSel.value === 'mid' ? 'Notes of the pattern or the playlist, one track per instrument channel. Audio clips and automation are not included.' : fmtSel.value === 'mp3' ? 'MP3 encoding uses LAME (lamejs, LGPL).' : '';
  };
  fmtSel.addEventListener('change', fillQuality);
  fillQuality();
  const progress = h('progress', { max: 100, value: 0, style: { width: '100%', display: 'none', height: '14px', accentColor: 'var(--accent)' } });
  const status = h('div.dim', { style: { minHeight: '16px', marginTop: '6px' } }, '');
  const body = h('div', row('Format', fmtSel), row('Quality', qSel), row('Render', srcSel), row('Sample rate', rateSel), row('Tail', tailSel),
    h('div', { style: { margin: '8px 0 4px 0' } }, dither.el, norm.el, stems.el, keep.el), row('File name', nameIn, ''), note, progress, status);
  let running = false, cancelled = false, cancelRun = null, m;
  const read = () => ({ format: fmtSel.value, quality: qSel.value, source: srcSel.value, rate: +rateSel.value, tail: tailSel.value === 'auto' || tailSel.value === 'cut' ? tailSel.value : +tailSel.value, dither: dither.c.checked, normalize: norm.c.checked, stems: stems.c.checked, keep: keep.c.checked, name: (nameIn.value || 'project').replace(/[^\w\- ]+/g, '_') });
  const start = async () => {
    if (running) return;
    const cfg = read();
    try { localStorage.setItem(KEY, JSON.stringify({ ...cfg, name: undefined })); } catch (_) { /* private mode */ }
    running = true; cancelled = false;
    progress.style.display = ''; status.textContent = 'Starting…';
    m.el.querySelectorAll('select, input').forEach((e) => { e.disabled = true; });
    try {
      const res = await exportProject(app, cfg, {
        progress: (f, t) => { progress.value = Math.round(f * 100); if (t) status.textContent = t; },
        cancelled: () => cancelled,
        onCancel: (fn) => { cancelRun = fn; },
      });
      if (res) app.toast(res.kind === 'audio' ? `Exported ${res.name} (${res.seconds.toFixed(1)} s, ${(res.bytes.length / 1048576).toFixed(2)} MB)` : res.kind === 'stems' ? `Exported ${res.count} stems` : `Exported ${res.name}`);
      else app.toast('Export cancelled');
      m.close();
    } catch (err) {
      running = false; progress.style.display = 'none'; status.textContent = String(err.message || err); status.style.color = 'var(--red)';
      m.el.querySelectorAll('select, input').forEach((e) => { e.disabled = false; });
      fillQuality();
    }
  };
  // the Export button starts the async job and returns false so the dialog stays open while it runs
  m = modal({
    title: 'Export', body, width: 480,
    buttons: [{ label: 'Close', fn: () => { if (running) { cancelled = true; if (cancelRun) cancelRun(); } } }, { label: 'Export', primary: true, fn: () => { start(); return false; } }],
    onClose: () => { if (running) { cancelled = true; if (cancelRun) cancelRun(); } },
  });
  return m;
}
