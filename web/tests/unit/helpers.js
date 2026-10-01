import { createProject, createChannel, createNote, createPattern, createClip, currentArrangement } from '../../src/core/project.js';
import { renderOffline } from '../../src/core/offline.js';
import { collectFactorySamples } from '../../src/core/factory.js';
import { STEP } from '../../src/core/constants.js';

export const SR = 44100;

export function peak(a) { let m = 0; for (let i = 0; i < a.length; i++) { const x = Math.abs(a[i]); if (x > m) m = x; } return m; }
export function rms(a, from = 0, to = a.length) { let s = 0; for (let i = from; i < to; i++) s += a[i] * a[i]; return Math.sqrt(s / Math.max(1, to - from)); }
export function firstSound(a, from = 0, thr = 1e-3) { for (let i = from; i < a.length; i++) if (Math.abs(a[i]) > thr) return i; return -1; }

// onset detector: indices where a burst starts after at least `gap` samples of silence
export function onsets(a, thr = 0.02, gap = 2000) {
  const out = []; let last = -1e9;
  for (let i = 0; i < a.length; i++) {
    if (Math.abs(a[i]) > thr) { if (i - last > gap) out.push(i); last = i; }
  }
  return out;
}

export function oneChannelProject(factoryKey = 'kick-punch', steps = [0]) {
  const p = createProject();
  const id = `factory:${factoryKey}`;
  const ch = createChannel(p, 'sampler', { name: 'T', sample: { id, name: factoryKey }, mixer: 0 });
  p.channels.push(ch);
  p.tempo = 120;
  const list = p.patterns[1].notes[ch.id] = [];
  for (const s of steps) list.push(createNote(p, s * STEP, STEP, 60, 127));
  return { p, ch };
}

export function renderPat(p, opts = {}) {
  return renderOffline(p, collectFactorySamples(p, SR), { mode: 'pat', sampleRate: SR, tail: 0.5, ...opts });
}

export function renderSong(p, opts = {}) {
  return renderOffline(p, collectFactorySamples(p, SR), { mode: 'song', sampleRate: SR, tail: 0.5, ...opts });
}
export { createClip, currentArrangement };
