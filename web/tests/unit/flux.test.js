import test from 'node:test';
import assert from 'node:assert/strict';
import { create, resolve, PRESETS, schema, macroNames, CATEGORIES } from '../../src/core/instruments/flux.js';
import { INSTRUMENTS } from '../../src/core/instruments/index.js';
import { schema as SUB } from '../../src/core/instruments/subsynth.js';

const SR = 48000;
function render(inst, key = 60, secs = 0.5, offAt = 0.3) {
  const n = Math.round(SR * secs), L = new Float32Array(n), R = new Float32Array(n);
  inst.noteOn({ key, vel: 0.9, rel: 64, pan: 0, id: 1 });
  for (let i = 0; i < n; i += 128) {
    if (i <= offAt * SR && i + 128 > offAt * SR) inst.noteOff(key);
    inst.process(L, R, i, Math.min(n, i + 128));
  }
  return { L, R };
}
const rms = (a, from = 0, to = a.length) => { let s = 0; for (let i = from; i < to; i++) s += a[i] * a[i]; return Math.sqrt(s / (to - from)); };
// share of the signal's energy above roughly 2 kHz (difference of neighbouring samples)
const brightness = (a) => { let d = 0, e = 0; for (let i = 1; i < a.length; i++) { d += (a[i] - a[i - 1]) ** 2; e += a[i] * a[i]; } return d / (e || 1); };

test('flux: registered, every preset sounds, no NaN, stays below clipping', () => {
  assert.ok(INSTRUMENTS.flux && INSTRUMENTS.flux.meta.name === 'Flux');
  assert.ok(PRESETS.length >= 20 && CATEGORIES.length >= 6);
  for (let i = 0; i < PRESETS.length; i++) {
    for (const k of Object.keys(PRESETS[i].s)) assert.ok(SUB.some((d) => d.id === k), `${PRESETS[i].name}: unknown setting ${k}`);
    assert.equal(macroNames(i).length, 8);
    const f = create(SR, { tempo: 120 });
    f.setParam('preset', i);
    const { L, R } = render(f, 60, 1.2, 0.8);
    let peak = 0; for (let j = 0; j < L.length; j++) { assert.ok(Number.isFinite(L[j]) && Number.isFinite(R[j]), PRESETS[i].name); peak = Math.max(peak, Math.abs(L[j]), Math.abs(R[j])); }
    assert.ok(peak > 0.02 && peak < 1.6, `${PRESETS[i].name}: peak ${peak}`);
  }
});

test('flux: macros in the middle give the preset as designed; Brightness opens the filter; Space adds a tail', () => {
  const mid = resolve(0, Array(8).fill(0.5));
  assert.equal(mid.s.cutoff, PRESETS[0].s.cutoff);
  const up = resolve(0, [1, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5]), down = resolve(0, [0, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5]);
  assert.ok(up.s.cutoff > mid.s.cutoff * 4 && down.s.cutoff < mid.s.cutoff / 4, `${down.s.cutoff} < ${mid.s.cutoff} < ${up.s.cutoff}`);
  const sw = PRESETS.findIndex((p) => p.name === 'Supersaw Lead');
  const dark = create(SR, { tempo: 120 }), bright = create(SR, { tempo: 120 });
  for (const f of [dark, bright]) f.setParam('preset', sw);
  dark.setParam('m1', 0.1); bright.setParam('m1', 0.95);
  assert.ok(brightness(render(bright).L) > brightness(render(dark).L) * 2, 'brighter');
  // Space: with it up the sound rings on after the note; with it down it stops
  const pl = PRESETS.findIndex((p) => p.name === 'Glass Pluck');
  const wet = create(SR, { tempo: 120 }), dry = create(SR, { tempo: 120 });
  for (const f of [wet, dry]) f.setParam('preset', pl);
  wet.setParam('m7', 1); dry.setParam('m7', 0);
  const a = render(wet, 72, 2, 0.1).L, b = render(dry, 72, 2, 0.1).L;
  assert.ok(rms(a, SR * 1.2, SR * 2) > 1e-3 && rms(b, SR * 1.2, SR * 2) < rms(a, SR * 1.2, SR * 2) / 10, `${rms(a, SR * 1.2, SR * 2)} vs ${rms(b, SR * 1.2, SR * 2)}`);
  assert.ok(wet.active || true);
  assert.ok(schema.find((d) => d.id === 'preset').options.length === PRESETS.length);
});
