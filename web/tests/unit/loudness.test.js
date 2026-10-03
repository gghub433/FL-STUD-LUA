import test from 'node:test';
import assert from 'node:assert/strict';
import { LoudnessMeter, measureLoudness, kWeighting, applyTarget, limitInPlace } from '../../src/core/loudness.js';
import { demoProject } from '../../src/core/demo.js';
import { renderOffline } from '../../src/core/offline.js';
import { collectFactorySamples } from '../../src/core/factory.js';

const SR = 48000;
// stereo sine; parts: [[seconds, dBFS]...] (dBFS = peak level of the sine, as in EBU Tech 3341)
function sine(parts, f = 1000, sr = SR, phase = 0) {
  const n = parts.reduce((a, [s]) => a + Math.round(s * sr), 0);
  const L = new Float32Array(n), R = new Float32Array(n);
  let i = 0;
  for (const [s, db] of parts) {
    const a = Math.pow(10, db / 20), m = Math.round(s * sr);
    for (let k = 0; k < m; k++, i++) L[i] = R[i] = a * Math.sin(2 * Math.PI * f * i / sr + phase);
  }
  return [L, R];
}
const near = (v, want, tol, what) => assert.ok(Math.abs(v - want) <= tol, `${what}: ${v} (want ${want} ±${tol})`);

test('K-weighting matches the BS.1770 coefficients at 48 kHz', () => {
  const [shelf, hp] = kWeighting(48000);
  near(shelf.b0, 1.53512485958697, 1e-9, 'shelf b0'); near(shelf.b1, -2.69169618940638, 1e-9, 'shelf b1'); near(shelf.b2, 1.19839281085285, 1e-9, 'shelf b2');
  near(shelf.a1, -1.69065929318241, 1e-9, 'shelf a1'); near(shelf.a2, 0.73248077421585, 1e-9, 'shelf a2');
  near(hp.a1, -1.99004745483398, 1e-9, 'high-pass a1'); near(hp.a2, 0.99007225036621, 1e-9, 'high-pass a2');
});

test('EBU Tech 3341 cases 1–4: steady and gated 1 kHz sines read their level in LUFS', () => {
  for (const sr of [44100, 48000]) {
    near(measureLoudness(...sine([[20, -23]], 1000, sr), sr).integrated, -23, 0.1, `case 1 @${sr}`);
    near(measureLoudness(...sine([[20, -33]], 1000, sr), sr).integrated, -33, 0.1, `case 2 @${sr}`);
  }
  near(measureLoudness(...sine([[10, -36], [60, -23], [10, -36]]), SR).integrated, -23, 0.1, 'case 3: the relative gate drops the quiet parts');
  near(measureLoudness(...sine([[10, -72], [10, -36], [60, -23], [10, -36], [10, -72]]), SR).integrated, -23, 0.1, 'case 4: absolute and relative gates');
});

test('momentary and short-term follow the signal; maxima and reset', () => {
  const m = new LoudnessMeter(SR);
  const [L, R] = sine([[4, -20]]);
  m.process(L, R, L.length);
  near(m.momentary, -20, 0.05, 'momentary'); near(m.shortTerm, -20, 0.05, 'short-term');
  near(m.snapshot()[5], -20, 0.05, 'momentary max'); near(m.snapshot()[6], -20, 0.05, 'short-term max');
  const [l2, r2] = sine([[0.5, -40]]);
  m.process(l2, r2, l2.length);
  near(m.momentary, -40, 0.1, 'momentary after 500 ms at −40');
  assert.ok(m.shortTerm > -24 && m.shortTerm < -20, `short-term still remembers the loud part: ${m.shortTerm}`);
  m.resetIntegrated();
  assert.equal(m.integrated, -Infinity); assert.equal(m.snapshot()[5], -Infinity);
  m.process(l2, r2, l2.length);
  near(m.integrated, -40, 0.1, 'integrated after the reset only measures what came after');
});

test('loudness range (EBU Tech 3342): −20 and −30 dBFS halves give 10 LU; a steady tone gives 0', () => {
  near(measureLoudness(...sine([[20, -20], [20, -30]]), SR).range, 10, 1, 'LRA case 1');
  near(measureLoudness(...sine([[20, -20], [20, -15]]), SR).range, 5, 1, 'LRA case 2');
  near(measureLoudness(...sine([[20, -23]]), SR).range, 0, 0.1, 'steady tone');
});

test('true peak finds inter-sample peaks that the sample peak misses', () => {
  // fs/4 at 45°: every sample sits at ±0.707 of the waveform's real peak
  const n = SR, L = new Float32Array(n);
  for (let i = 0; i < n; i++) L[i] = 0.5 * Math.sin(Math.PI / 2 * i + Math.PI / 4);
  const st = measureLoudness(L, L, SR);
  near(st.samplePeak, 20 * Math.log10(0.5 * Math.SQRT1_2), 0.01, 'sample peak');
  near(st.truePeak, 20 * Math.log10(0.5), 0.2, 'true peak');
  const [a, b] = sine([[1, -6]], 997);
  near(measureLoudness(a, b, SR).truePeak, -6, 0.05, 'a low tone has true peak = sample peak');
});

test('correlation: +1 for mono, −1 for inverted, ~0 for unrelated channels', () => {
  const m = new LoudnessMeter(SR);
  const [L] = sine([[1, -10]]);
  m.process(L, L, L.length); near(m.correlation, 1, 1e-6, 'mono');
  const inv = L.map((x) => -x);
  m.reset(); m.process(L, inv, L.length); near(m.correlation, -1, 1e-6, 'inverted');
  const [o] = sine([[1, -10]], 1733);
  m.reset(); m.process(L, o, L.length); near(m.correlation, 0, 0.05, 'unrelated tones');
});

test('applyTarget: −14 LUFS by gain; limiter only where the gain would clip; peak mode', () => {
  let [L, R] = sine([[10, -30]]);
  let r = applyTarget(L, R, SR, -14, -1);
  near(r.after.integrated, -14, 0.1, 'reached −14 LUFS'); near(r.gain, 16, 0.1, 'gain'); assert.equal(r.limited, false);
  near(measureLoudness(L, R, SR).integrated, -14, 0.1, 're-measured');

  // a loud transient over a quiet bed: +24 dB would clip, the limiter holds the ceiling
  [L, R] = sine([[8, -30]]);
  for (let i = SR * 2; i < SR * 2 + 400; i++) { L[i] = 0.9 * Math.sign(L[i] || 1); R[i] = L[i]; }
  r = applyTarget(L, R, SR, -6, -1);
  assert.equal(r.limited, true);
  assert.ok(r.after.truePeak <= -0.9, `true peak under the ceiling: ${r.after.truePeak}`);
  near(r.after.integrated, -6, 0.6, 'loudness close to the target');

  [L, R] = sine([[2, -12]]);
  r = applyTarget(L, R, SR, 'peak');
  near(r.after.samplePeak, -0.1, 0.01, 'peak mode');
  const silent = new Float32Array(1000);
  assert.equal(applyTarget(silent, silent, SR, -14).gain, 0, 'silence is left alone');
});

test('limitInPlace keeps timing: no delay, peaks at the ceiling', () => {
  const n = 4800, L = new Float32Array(n), R = new Float32Array(n);
  L[1000] = R[1000] = 1;
  limitInPlace(L, R, SR, -6);
  let at = -1, pk = 0;
  for (let i = 0; i < n; i++) if (Math.abs(L[i]) > pk) { pk = Math.abs(L[i]); at = i; }
  assert.equal(at, 1000); assert.ok(pk <= Math.pow(10, -6 / 20) + 1e-6, `peak ${pk}`);
});

test('the demo project is limited on the master and stays below 0 dBFS', () => {
  const p = demoProject();
  assert.equal(p.mixer.tracks[0].fx.at(-1).type, 'limiter', 'a limiter sits in the last master slot');
  const r = renderOffline(p, collectFactorySamples(p, 44100), { sampleRate: 44100, tail: 1 });
  const st = measureLoudness(r.left, r.right, 44100);
  assert.ok(st.samplePeak <= -0.29, `sample peak ${st.samplePeak}`);
  assert.ok(st.integrated > -20 && st.integrated < -6, `integrated ${st.integrated}`);
});
