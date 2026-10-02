// Audio / MIDI export pipeline: render in a worker, then (optionally) normalise and encode.
import { renderInWorker } from '../host/export/render-client.js';
import { encodeWav, downloadBlob } from '../host/export/wav.js';
import { encodeFlac } from '../host/export/flac.js';
import { loadLame, encodeMp3 } from '../host/export/mp3.js';
import { encodeOggOpus } from '../host/export/ogg.js';
import { writeMidi } from '../core/midi-file.js';
import { zipStore } from '../core/zip.js';
import { currentArrangement } from '../core/project.js';
import { usedTracks } from '../core/offline.js';
import { trackName } from '../core/addr.js';

export const FORMATS = {
  wav: { label: 'WAV', ext: 'wav', mime: 'audio/wav', qualities: [['16', '16-bit'], ['24', '24-bit'], ['32', '32-bit float']], def: '16' },
  flac: { label: 'FLAC (lossless)', ext: 'flac', mime: 'audio/flac', qualities: [['16', '16-bit'], ['24', '24-bit']], def: '24' },
  mp3: { label: 'MP3', ext: 'mp3', mime: 'audio/mpeg', qualities: [['128', '128 kbps'], ['192', '192 kbps'], ['256', '256 kbps'], ['320', '320 kbps']], def: '192' },
  ogg: { label: 'OGG (Opus)', ext: 'ogg', mime: 'audio/ogg', qualities: [['96', '96 kbps'], ['128', '128 kbps'], ['192', '192 kbps'], ['256', '256 kbps']], def: '192' },
  mid: { label: 'MIDI file', ext: 'mid', mime: 'audio/midi', qualities: [], def: '' },
};

export const defaultSettings = (project) => ({ format: 'wav', quality: '16', source: 'song', rate: 44100, tail: 'auto', dither: true, normalize: false, stems: false, keep: true, name: (project.meta.title || 'project').replace(/[^\w\- ]+/g, '_') });

const safeName = (s) => s.replace(/[^\w\- ]+/g, '_').trim() || 'track';
const peakOf = (l, r) => { let m = 0; for (let i = 0; i < l.length; i++) { const a = Math.abs(l[i]), b = Math.abs(r[i]); if (a > m) m = a; if (b > m) m = b; } return m; };

export function normalizeInPlace(l, r, targetDb = -0.1) {
  const pk = peakOf(l, r);
  if (pk < 1e-6) return 1;
  const g = Math.pow(10, targetDb / 20) / pk;
  for (let i = 0; i < l.length; i++) { l[i] *= g; r[i] *= g; }
  return g;
}

async function encodeOne(l, r, sr, s, ui) {
  const q = +s.quality;
  switch (s.format) {
    case 'wav': return encodeWav(l, r, sr, { bits: q, dither: s.dither && q < 32 });
    case 'flac': return encodeFlac(l, r, sr, { bits: q, dither: s.dither && q < 24 });
    case 'mp3': { const lame = await loadLame(); return encodeMp3(lame, l, r, sr, { kbps: q, dither: s.dither, onProgress: (f) => ui.progress(f, 'Encoding MP3…'), shouldCancel: () => ui.cancelled() }); }
    case 'ogg': return encodeOggOpus(l, r, { bitrate: q * 1000, onProgress: (f) => ui.progress(f, 'Encoding OGG…'), shouldCancel: () => ui.cancelled() });
    default: throw new Error(`Unknown format ${s.format}`);
  }
}

// ui: { progress(fraction, text), cancelled(), onCancel(fn) }. Returns { name, bytes, seconds, kind } or null when cancelled.
export async function exportProject(app, s, ui = { progress() {}, cancelled: () => false, onCancel() {} }) {
  const store = app.store, project = store.project, sink = app.exportSink || downloadBlob;
  const fmt = FORMATS[s.format];
  if (!fmt) throw new Error('Unknown export format');
  if (s.format === 'mid') {
    const bytes = writeMidi(project, { mode: s.source === 'pat' ? 'pat' : 'song' });
    sink(bytes, `${s.name}.mid`, fmt.mime);
    return { name: `${s.name}.mid`, bytes, kind: 'midi' };
  }
  const mode = s.source === 'pat' ? 'pat' : 'song';
  const opts = { mode, sampleRate: s.format === 'ogg' ? 48000 : s.rate, tail: s.tail === 'cut' ? 0 : s.tail };
  if (s.source === 'loop') {
    const arr = currentArrangement(project);
    if (!arr.loop) throw new Error('There is no loop region in the playlist. Shift-drag on the playlist ruler to set one');
    opts.from = arr.loop.s; opts.to = arr.loop.e;
  }
  const samples = [...app.bank.map].map(([id, e]) => ({ id, rate: e.rate, channels: e.channels }));
  const job = { project: JSON.parse(JSON.stringify(project)), samples, opts, stems: !!s.stems };
  const run = renderInWorker(job, { onProgress: (f) => ui.progress(f * (s.format === 'wav' ? 1 : 0.7), 'Rendering…') });
  ui.onCancel(() => run.cancel());
  const out = await run.promise;
  if (!out) return null;

  if (s.stems) {
    const entries = [];
    let i = 0;
    for (const st of out.stems) {
      if (ui.cancelled()) return null;
      i++;
      if (s.normalize) normalizeInPlace(st.left, st.right);
      const bytes = await encodeOne(st.left, st.right, st.sampleRate, s, ui);
      if (!bytes) return null;
      entries.push({ name: `${String(i).padStart(2, '0')} ${safeName(trackName(project, st.track))}.${fmt.ext}`, data: bytes });
      ui.progress(0.7 + 0.3 * (i / out.stems.length), 'Encoding stems…');
    }
    if (!entries.length) throw new Error('No mixer tracks are in use');
    const zip = zipStore(entries);
    sink(zip, `${s.name} stems.zip`, 'application/zip');
    return { name: `${s.name} stems.zip`, bytes: zip, kind: 'stems', count: entries.length };
  }

  const { left, right, sampleRate, frames } = out.result;
  if (!frames) throw new Error('Nothing to render. Add notes or clips first');
  if (s.normalize) normalizeInPlace(left, right);
  const bytes = await encodeOne(left, right, sampleRate, s, ui);
  if (!bytes) return null;
  const name = `${s.name}${s.source === 'pat' ? '-pattern' : s.source === 'loop' ? '-loop' : ''}.${fmt.ext}`;
  ui.progress(1, 'Saving…');
  sink(bytes, name, fmt.mime);
  const seconds = frames / sampleRate;
  if (s.keep && seconds <= 60) {                                       // short renders are kept in the Browser's "Rendered" section
    try {
      const e = app.bank.addPCM(name.replace(/\.[^.]+$/, ''), sampleRate, [left, right]);
      await app.library.save('rendered', e.name, { id: e.id });
    } catch (_) { /* storage unavailable */ }
  }
  return { name, bytes, seconds, kind: 'audio', left, right, sampleRate };
}

export { usedTracks };
