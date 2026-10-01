import test from 'node:test';
import assert from 'node:assert/strict';
import { stretchAudio } from '../../src/core/stretch.js';
import { FFT } from '../../src/core/fft.js';

const SR = 44100;
function tone(f, sec) { const a = new Float32Array(Math.floor(sec * SR)); for (let i = 0; i < a.length; i++) a[i] = 0.6 * Math.sin(2 * Math.PI * f * i / SR) + 0.2 * Math.sin(2 * Math.PI * f * 2.01 * i / SR); return a; }
function peakFreq(a, from) {
  const N = 16384, fft = new FFT(N), re = new Float32Array(N), im = new Float32Array(N);
  for (let i = 0; i < N; i++) re[i] = (a[from + i] || 0) * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / N));
  fft.transform(re, im);
  let best = 0, bv = 0; for (let k = 5; k < N / 2; k++) { const m = Math.hypot(re[k], im[k]); if (m > bv) { bv = m; best = k; } }
  return (best * SR) / N;
}
const rms = (a, f = 0, t = a.length) => { let s = 0; for (let i = f; i < t; i++) s += a[i] * a[i]; return Math.sqrt(s / (t - f)); };

test('time stretch changes duration but keeps pitch', () => {
  const x = tone(330, 2);
  for (const ratio of [0.5, 0.8, 1.5, 2]) {
    const [y] = stretchAudio([x], { ratio, rate: SR });
    assert.ok(Math.abs(y.length / x.length - ratio) < 0.01, `ratio ${ratio}: ${y.length / x.length}`);
    const f = peakFreq(y, Math.floor(y.length / 2) - 8000);
    assert.ok(Math.abs(f - 330) < 8, `ratio ${ratio}: pitch ${f}`);
    assert.ok(Math.abs(rms(y, 8000, y.length - 8000) / rms(x, 8000, x.length - 8000) - 1) < 0.2, 'level preserved');
  }
});

test('pitch shift keeps duration and moves the pitch by the requested semitones', () => {
  const x = tone(220, 2);
  for (const st of [-5, 7, 12]) {
    const [y] = stretchAudio([x], { ratio: 1, semitones: st, rate: SR });
    assert.ok(Math.abs(y.length / x.length - 1) < 0.01, `length ${y.length / x.length}`);
    const f = peakFreq(y, 20000);
    assert.ok(Math.abs(f / 220 - Math.pow(2, st / 12)) < 0.03, `${st} st: ${f}`);
  }
});

test('stereo channels keep their length relationship', () => {
  const x = tone(200, 1), z = tone(300, 1);
  const [l, r] = stretchAudio([x, z], { ratio: 1.25, rate: SR });
  assert.equal(l.length, r.length);
});
