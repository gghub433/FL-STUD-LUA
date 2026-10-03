import test from 'node:test';
import assert from 'node:assert/strict';
import { detectTempo, nearestOctave } from '../../src/core/tempo-detect.js';
import { demoProject } from '../../src/core/demo.js';
import { TEMPLATE_BY_ID } from '../../src/core/templates.js';
import { renderOffline } from '../../src/core/offline.js';
import { collectFactorySamples } from '../../src/core/factory.js';

const SR = 44100;
// kick on every beat, snare on 2 and 4, hats on eighths, a little noise; `extra` seconds of tail make it a non-loop
function drums(bpm, beats, { extra = 0, swing = 0, seed = 1 } = {}) {
  const beat = 60 / bpm, n = Math.round((beats * beat + extra) * SR), x = new Float32Array(n);
  let r = seed;
  const rnd = () => { r = (r * 16807) % 2147483647; return r / 2147483647 - 0.5; };
  const add = (t, fn, len) => { const s = Math.round(t * SR); for (let i = 0; i < len * SR && s + i < n; i++) x[s + i] += fn(i / SR); };
  for (let b = 0; b < beats; b++) {
    add(b * beat, (t) => Math.sin(2 * Math.PI * (50 + 80 * Math.exp(-t * 30)) * t) * Math.exp(-t * 9) * 0.8, 0.35);
    if (b % 2 === 1) add(b * beat, (t) => rnd() * Math.exp(-t * 18) * 0.6, 0.2);
    for (const h of [0, 0.5]) add((b + h + (h ? swing : 0)) * beat, (t) => rnd() * Math.exp(-t * 60) * 0.25, 0.05);
  }
  for (let i = 0; i < n; i++) x[i] += rnd() * 0.002;
  return x;
}

test('drum loops: the tempo within 0.1 BPM and the loop length in beats', () => {
  for (const bpm of [86, 92, 110, 124, 128, 140, 160]) {
    const r = detectTempo([drums(bpm, 32)], SR);
    assert.ok(Math.abs(r.bpm - bpm) < 0.1, `${bpm}: got ${JSON.stringify(r)}`);
    assert.equal(r.beats, 32, `${bpm}: beats`);
    assert.ok(r.confidence > 0.3, `${bpm}: confidence ${r.confidence}`);
  }
});

test('very slow and very fast loops come out at half or double tempo; nearestOctave fits them to the project', () => {
  for (const bpm of [70, 174]) {
    const r = detectTempo([drums(bpm, 32)], SR);
    const fit = nearestOctave(r.bpm, bpm);
    assert.ok(Math.abs(fit - bpm) < 0.1, `${bpm}: detected ${r.bpm}, fitted ${fit}`);
  }
  assert.equal(nearestOctave(87, 174), 174); assert.equal(nearestOctave(87, 100), 87); assert.equal(nearestOctave(140, 72), 70);
});

test('not a loop (extra tail), swing and a start offset: tempo within 1 BPM, phase on the beat', () => {
  for (const bpm of [98, 120, 136]) {
    const r = detectTempo([drums(bpm, 24, { extra: 1.37, swing: 0.08 })], SR, { loop: false });
    assert.ok(Math.abs(r.bpm - bpm) < 1, `${bpm}: ${JSON.stringify(r)}`);
  }
  const bpm = 120, lead = 0.25, x = drums(bpm, 24), y = new Float32Array(x.length + lead * SR);
  y.set(x, lead * SR);
  const r = detectTempo([y], SR, { loop: false });
  const beatFrames = SR * 60 / bpm, off = ((r.offset - lead * SR) % beatFrames + beatFrames) % beatFrames;
  assert.ok(Math.min(off, beatFrames - off) < SR * 0.03, `beat phase ${r.offset} (${off} frames from a beat)`);
});

test('rendered projects: the demo at 124 BPM and the hip-hop template at 90 BPM', () => {
  for (const [p, want] of [[demoProject(), 124], [TEMPLATE_BY_ID.get('hiphop').build(), 90]]) {
    const r = renderOffline(p, collectFactorySamples(p, SR), { sampleRate: SR, tail: 0 });
    const t = detectTempo([r.left, r.right], SR, { loop: false });
    assert.ok(Math.abs(t.bpm - want) < 0.6, `${want}: ${JSON.stringify(t)}`);
  }
});

test('silence and very short audio report no tempo', () => {
  assert.equal(detectTempo([new Float32Array(SR * 4)], SR).bpm, 0);
  assert.equal(detectTempo([drums(120, 1)], SR).bpm, 0);
});
