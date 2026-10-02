import test from 'node:test';
import assert from 'node:assert/strict';
import * as E from '../../src/core/audio-edit.js';

const SR = 44100;
const sine = (f, sec, amp = 0.5, rate = SR) => { const n = Math.round(sec * rate), o = new Float32Array(n); for (let i = 0; i < n; i++) o[i] = amp * Math.sin((2 * Math.PI * f * i) / rate); return o; };
const mk = (...ch) => ({ rate: SR, channels: ch });
const ramp = (n) => Float32Array.from({ length: n }, (_, i) => i / n);

test('cut, delete, insert, trim and paste keep lengths and channels consistent', () => {
  const b = mk(ramp(1000), ramp(1000).map((v) => -v));
  const cut = E.deleteRange(b, 200, 300);
  assert.equal(E.frames(cut), 900);
  assert.equal(cut.channels[0][199], b.channels[0][199]); assert.equal(cut.channels[0][200], b.channels[0][300]);
  assert.equal(cut.channels[1][200], b.channels[1][300]);
  assert.equal(E.frames(E.slice(b, 100, 150)), 50);
  assert.equal(E.slice(b, 150, 100).channels[0][0], b.channels[0][100], 'reversed range arguments are normalised');
  const clip = E.slice(b, 0, 100);
  const ins = E.insert(b, 500, clip);
  assert.equal(E.frames(ins), 1100);
  assert.equal(ins.channels[0][500], b.channels[0][0]); assert.equal(ins.channels[0][600], b.channels[0][500]);
  const over = E.insert(b, 950, clip, 'overwrite');
  assert.equal(E.frames(over), 1050, 'overwrite past the end extends the buffer');
  const mix = E.insert(mk(new Float32Array(100).fill(0.25)), 0, mk(new Float32Array(50).fill(0.5)), 'mix');
  assert.equal(mix.channels[0][10], 0.75); assert.equal(mix.channels[0][60], 0.25);
  assert.equal(E.frames(E.insertSilence(b, 10, 99)), 1099);
  assert.equal(E.frames(E.replaceRange(b, 0, 500, E.slice(b, 0, 10))), 510);
  // pasting a mono clip into a stereo buffer (and a different sample rate) conforms it
  const mono = { rate: 22050, channels: [sine(440, 0.1, 0.5, 22050)] };
  const into = E.insert(b, 0, mono);
  assert.equal(into.channels.length, 2);
  assert.ok(Math.abs(E.frames(into) - 1000 - 4410) <= 2, `resampled to the host rate (${E.frames(into) - 1000})`);
  assert.deepEqual([...into.channels[0].subarray(0, 50)], [...into.channels[1].subarray(0, 50)], 'mono became centred stereo');
});

test('operations return new buffers and never modify their input', () => {
  const b = mk(sine(440, 0.1));
  const copy = b.channels[0].slice();
  for (const fn of [() => E.reverse(b), () => E.gain(b, 0, 1000, -6), () => E.fade(b, 0, 1000, 'in'), () => E.silence(b, 0, 500), () => E.invert(b), () => E.dcRemove(b), () => E.normalize(b), () => E.loopCrossfade(b, 1000, 3000, 200)]) {
    const r = fn();
    assert.notEqual(r.channels[0], b.channels[0]);
  }
  assert.deepEqual([...b.channels[0]], [...copy]);
});

test('gain, normalize, fades, silence, reverse, invert and DC removal', () => {
  const b = mk(sine(1000, 0.2, 0.25));
  assert.ok(Math.abs(E.peakOf(E.gain(b, 0, E.frames(b), 6.0206)) - 0.5) < 1e-3, '+6 dB doubles');
  assert.ok(Math.abs(E.peakOf(E.normalize(b, 0, E.frames(b), 0)) - 1) < 1e-4, 'normalize to 0 dBFS');
  assert.ok(Math.abs(E.peakOf(E.normalize(b, 0, E.frames(b), -6)) - 0.5012) < 1e-3, 'normalize to -6 dBFS');
  assert.equal(E.peakOf(E.normalize(mk(new Float32Array(100)), 0, 100)), 0, 'silence stays silent');
  // normalizing a part only touches that part
  const part = E.normalize(b, 0, 2000, 0);
  assert.ok(E.peakOf(part, 0, 2000) > 0.99 && Math.abs(part.channels[0][5000] - b.channels[0][5000]) < 1e-7);
  const ones = mk(new Float32Array(1000).fill(1));
  const fin = E.fade(ones, 0, 1000, 'in'), fout = E.fade(ones, 0, 1000, 'out');
  assert.equal(fin.channels[0][0], 0); assert.ok(Math.abs(fin.channels[0][999] - 1) < 1e-9); assert.ok(Math.abs(fin.channels[0][500] - 0.5) < 0.01);
  assert.equal(fout.channels[0][999], 0); assert.equal(fout.channels[0][0], 1);
  for (const shape of ['exp', 'log', 'scurve']) { const f = E.fade(ones, 0, 1000, 'in', shape); assert.ok(f.channels[0][0] === 0 && Math.abs(f.channels[0][999] - 1) < 1e-9, shape); }
  assert.ok(E.fade(ones, 0, 1000, 'in', 'exp').channels[0][250] < 0.25 && E.fade(ones, 0, 1000, 'in', 'log').channels[0][250] > 0.25);
  const sil = E.silence(ones, 100, 200);
  assert.equal(sil.channels[0][99], 1); assert.equal(sil.channels[0][150], 0); assert.equal(sil.channels[0][200], 1);
  const r = E.reverse(mk(ramp(100)), 0, 100);
  assert.ok(Math.abs(r.channels[0][0] - 0.99) < 1e-6 && r.channels[0][99] === 0);
  assert.equal(E.invert(mk(Float32Array.of(1, -2, 3)), 1, 3).channels[0].join(), '1,2,-3');
  const dc = E.dcRemove(mk(sine(440, 0.1).map((v) => v + 0.3)), 0, 4410);
  assert.ok(Math.abs(E.stats(dc, 0, 4410).dc) < 1e-4, 'DC offset removed');
});

test('stats report peak, RMS and DC like a meter would', () => {
  const s = E.stats(mk(sine(1000, 1, 0.5)), 0, SR);
  assert.ok(Math.abs(s.peak - 0.5) < 1e-3 && Math.abs(s.peakDb + 6.02) < 0.02);
  assert.ok(Math.abs(s.rms - 0.3536) < 1e-3 && Math.abs(s.rmsDb + 9.03) < 0.05, `rms ${s.rmsDb}`);
  assert.ok(Math.abs(s.dc) < 1e-4 && Math.abs(s.seconds - 1) < 1e-6);
  assert.equal(E.stats(mk(new Float32Array(10))).peakDb, -Infinity);
});

test('mono / stereo conversions, channel swap and resampling', () => {
  const st = mk(new Float32Array(100).fill(1), new Float32Array(100).fill(0.5));
  assert.ok(Math.abs(E.toMono(st).channels[0][5] - 0.75) < 1e-7);
  assert.equal(E.toStereo(mk(new Float32Array(10).fill(0.3))).channels.length, 2);
  assert.equal(E.swapChannels(st).channels[0][0], 0.5);
  const up = E.resample(mk(sine(1000, 0.5)), 48000);
  assert.equal(up.rate, 48000); assert.ok(Math.abs(E.frames(up) - 24000) <= 1);
  const rms = (a) => Math.sqrt(a.reduce((s, v) => s + v * v, 0) / a.length);
  assert.ok(Math.abs(rms(up.channels[0].subarray(1000, 20000)) - 0.3536) < 0.01, 'level preserved');
  // a 1 kHz tone keeps its pitch: count rising zero crossings per second
  let z = 0; const c = up.channels[0]; for (let i = 1; i < c.length; i++) if (c[i - 1] <= 0 && c[i] > 0) z++;
  assert.ok(Math.abs(z - 500) <= 2, `1 kHz stays 1 kHz (${z} crossings in 0.5 s)`);
  const down = E.resample(mk(sine(15000, 0.3)), 22050);
  assert.ok(rms(down.channels[0].subarray(500, 5000)) < 0.15, 'content above the new Nyquist is attenuated, not folded back at full level');
  assert.equal(E.resample(st, SR).channels[0].length, 100);
});

test('trim silence, audible range, zero crossings, loop cross-fade', () => {
  const x = new Float32Array(5000); x.set(sine(440, 0.05, 0.5).subarray(0, 1000), 2000);
  const b = mk(x);
  const ar = E.audibleRange(b, -60);
  assert.ok(ar[0] >= 2000 && ar[0] <= 2005 && ar[1] >= 2990 && ar[1] <= 3000, `audible part ${ar}`);
  const t = E.trimSilence(b);
  assert.ok(E.frames(t) <= 1001 && E.frames(t) > 900);
  assert.equal(E.audibleRange(mk(new Float32Array(100))), null);
  const zc = E.findZeroCrossing(mk(sine(100, 0.1)), 1234);
  const c = sine(100, 0.1);
  assert.ok(c[zc - 1] <= 0 && c[zc] > 0, 'lands on a rising zero crossing');
  // loop crossfade: the sample before the loop start blends into the loop end
  const l = mk(Float32Array.from({ length: 3000 }, (_, i) => (i < 1000 ? 1 : -1)));
  const f = E.loopCrossfade(l, 1000, 3000, 400);
  assert.equal(f.channels[0][2999], 1, 'the very end equals the material before the loop start');
  assert.equal(f.channels[0][2600], -1, 'before the crossfade nothing changed');
  assert.equal(E.frames(f), 3000);
});

test('time stretch and pitch shift of a range', () => {
  const b = mk(sine(440, 1));
  const slow = E.stretchRange(b, 0, E.frames(b), { ratio: 2 });
  assert.ok(Math.abs(E.frames(slow) / E.frames(b) - 2) < 0.02, `length x2 (${E.frames(slow)})`);
  const part = E.stretchRange(b, 10000, 20000, { ratio: 0.5 });
  assert.ok(Math.abs(E.frames(part) - (E.frames(b) - 5000)) < 200, 'only the selection changes length');
  const up = E.stretchRange(b, 0, E.frames(b), { semitones: 12 });
  assert.ok(Math.abs(E.frames(up) - E.frames(b)) < 200, 'pitch shift keeps the length');
  let z = 0; const c = up.channels[0]; for (let i = SR / 4 + 1; i < SR * 3 / 4; i++) if (c[i - 1] <= 0 && c[i] > 0) z++;
  assert.ok(Math.abs(z - 440) < 20, `440 Hz shifted up an octave = 880 Hz (${z * 2} Hz)`);
});

test('any mixer effect can be applied to a range; the tail option lets reverbs ring out', () => {
  const b = mk(sine(440, 0.5, 0.5));
  const filtered = E.applyEffect(b, 0, E.frames(b), 'filter', { type: 0, cutoff: 200, res: 0.1, lfoAmt: 0 });
  assert.equal(E.frames(filtered), E.frames(b));
  assert.ok(E.peakOf(filtered, 5000, 20000) < 0.15, 'a 200 Hz low-pass takes the 440 Hz tone down');
  // only the selected range is processed
  const part = E.applyEffect(b, 10000, 12000, 'filter', { type: 0, cutoff: 200, res: 0.1, lfoAmt: 0 });
  assert.ok(Math.abs(part.channels[0][5000] - b.channels[0][5000]) < 1e-7 && Math.abs(part.channels[0][20000] - b.channels[0][20000]) < 1e-7);
  const noTail = E.applyEffect(b, 0, E.frames(b), 'reverb', { dry: -60, wet: 0 });
  const tail = E.applyEffect(b, 0, E.frames(b), 'reverb', { dry: -60, wet: 0 }, { tail: 2 });
  assert.equal(E.frames(noTail), E.frames(b));
  assert.equal(E.frames(tail), E.frames(b) + 2 * SR);
  assert.ok(E.peakOf(tail, E.frames(b) + 4000, E.frames(b) + 40000) > 0.002, 'reverb tail present after the original ended');
  // effects with look-ahead (limiter) are latency-compensated so the result stays aligned
  const impulse = mk(new Float32Array(20000)); impulse.channels[0][5000] = 0.5;
  const lim = E.applyEffect(impulse, 0, 20000, 'limiter', {});
  let at = 0; for (let i = 0; i < 20000; i++) if (Math.abs(lim.channels[0][i]) > Math.abs(lim.channels[0][at])) at = i;
  assert.ok(Math.abs(at - 5000) <= 2, `limiter output peak at ${at}`);
  // mono stays mono, stereo stays stereo
  assert.equal(E.applyEffect(b, 0, 1000, 'distortion', {}).channels.length, 1);
  assert.equal(E.applyEffect(E.toStereo(b), 0, 1000, 'distortion', {}).channels.length, 2);
  // the Patcher effect works in the editor too
  const pt = E.applyEffect(b, 0, 2000, 'patcher', {});
  assert.ok(Math.abs(pt.channels[0][500] - b.channels[0][500]) < 1e-6, 'the default patch is transparent');
});

test('peak pyramid returns the same extremes as brute force at any zoom', () => {
  const n = 300000, l = new Float32Array(n), r = new Float32Array(n);
  for (let i = 0; i < n; i++) { l[i] = Math.sin(i / 37) * Math.sin(i / 5000); r[i] = Math.cos(i / 91) * 0.6; }
  const pk = new E.Peaks([l, r]);
  for (const [s, e, w] of [[0, n, 800], [1000, 9000, 700], [123456, 123456 + 400, 400], [0, 64, 64], [250000, n, 300]]) {
    for (const k of [0, 1]) {
      const cols = pk.columns(k, s, e, w), src = k ? r : l, per = (e - s) / w;
      let worst = 0;
      for (let x = 0; x < w; x += Math.max(1, Math.floor(w / 25))) {
        const a = Math.floor(s + x * per), b = Math.min(n, Math.max(a + 1, Math.floor(s + (x + 1) * per)));
        let lo = 0, hi = 0; for (let i = a; i < b; i++) { lo = Math.min(lo, src[i]); hi = Math.max(hi, src[i]); }
        // coarser levels may include a little more than the column's own samples, never less
        assert.ok(cols[x * 2] <= lo + 1e-6 && cols[x * 2 + 1] >= hi - 1e-6, `covers the true extremes (zoom ${e - s}/${w}, col ${x})`);
        worst = Math.max(worst, (hi - lo) - (cols[x * 2 + 1] - cols[x * 2]));
      }
      assert.ok(worst < 1e-6);
    }
  }
});

test('spectrogram puts a sine in the right bin; regions follow the hits of a drum loop', () => {
  const b = mk(sine(2000, 1, 0.5));
  const sp = E.spectrogram(b, 0, E.frames(b), { size: 2048, columns: 20 });
  let best = 0, bv = -999;
  for (let k = 0; k < sp.bins; k++) { const v = sp.data[10 * sp.bins + k]; if (v > bv) { bv = v; best = k; } }
  assert.ok(Math.abs((best * SR) / 2048 - 2000) < 25, `peak at ${(best * SR) / 2048} Hz`);
  assert.ok(bv > -12 && bv < 0, `level of a 0.5 sine is about -6 dB (${bv.toFixed(1)})`);
  const loop = new Float32Array(SR * 2);
  for (const t of [0, 0.5, 1, 1.5]) for (let i = 0; i < 3000; i++) loop[Math.floor(t * SR) + i] += Math.sin(i / 3) * Math.exp(-i / 700) * 0.8;
  const regs = E.detectRegions(mk(loop), { sensitivity: 0.6 });
  assert.ok(regs.length >= 4 && regs.length <= 8, `found ${regs.length} regions`);
  assert.equal(regs[0].a, 0); assert.equal(regs[regs.length - 1].b, loop.length);
  for (let i = 1; i < regs.length; i++) assert.equal(regs[i].a, regs[i - 1].b, 'regions tile the sample');
});
