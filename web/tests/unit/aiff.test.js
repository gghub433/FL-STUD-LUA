import test from 'node:test';
import assert from 'node:assert/strict';
import { isAiff, decodeAiff } from '../../src/core/aiff.js';

// a small AIFF / AIFF-C writer for the tests: chunks are padded to even sizes, an odd-sized chunk comes first
function ext80(rate) {
  const e = Math.floor(Math.log2(rate)), m = BigInt(rate) << BigInt(63 - e);
  const b = new Uint8Array(10), dv = new DataView(b.buffer);
  dv.setUint16(0, 16383 + e); dv.setUint32(2, Number(m >> 32n)); dv.setUint32(6, Number(m & 0xffffffffn));
  return b;
}
function aiff(channels, rate, { bits = 16, comp = null, offset = 0 } = {}) {
  const nch = channels.length, n = channels[0].length;
  const width = comp === 'fl32' ? 4 : comp === 'fl64' ? 8 : Math.ceil(bits / 8);
  const pcm = new Uint8Array(n * nch * width), pv = new DataView(pcm.buffer);
  const little = comp === 'sowt';
  for (let i = 0, o = 0; i < n; i++) for (let c = 0; c < nch; c++, o += width) {
    const v = channels[c][i];
    if (comp === 'fl32') pv.setFloat32(o, v); else if (comp === 'fl64') pv.setFloat64(o, v);
    else if (width === 1) pv.setInt8(o, Math.round(v * 127));
    else if (width === 2) pv.setInt16(o, Math.round(v * 32767), little);
    else if (width === 3) { const x = Math.round(v * 8388607); const bs = [(x >> 16) & 255, (x >> 8) & 255, x & 255]; if (little) bs.reverse(); pcm.set(bs, o); }
    else pv.setInt32(o, Math.round(v * 2147483647), little);
  }
  const chunk = (id, body) => { const out = new Uint8Array(8 + body.length + (body.length & 1)); out.set([...id].map((ch) => ch.charCodeAt(0))); new DataView(out.buffer).setUint32(4, body.length); out.set(body, 8); return out; };
  const comm = new Uint8Array(comp ? 24 : 18), cv = new DataView(comm.buffer);
  cv.setUint16(0, nch); cv.setUint32(2, n); cv.setUint16(6, bits); comm.set(ext80(rate), 8);
  if (comp) { comm.set([...comp].map((ch) => ch.charCodeAt(0)), 18); comm.set([1, 32], 22); }
  const ssnd = new Uint8Array(8 + offset + pcm.length); new DataView(ssnd.buffer).setUint32(0, offset); ssnd.set(pcm, 8 + offset);
  const parts = [chunk('NAME', new Uint8Array([65, 66, 67])), chunk('COMM', comm), chunk('SSND', ssnd)];
  const total = parts.reduce((s, p) => s + p.length, 4);
  const out = new Uint8Array(8 + total), ov = new DataView(out.buffer);
  out.set([70, 79, 82, 77]); ov.setUint32(4, total); out.set([...(comp ? 'AIFC' : 'AIFF')].map((ch) => ch.charCodeAt(0)), 8);
  let o = 12; for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
const ramp = (n, k = 1) => Float32Array.from({ length: n }, (_, i) => k * Math.sin(i / 7) * 0.9);
const close = (a, b, tol, what) => { assert.equal(a.length, b.length, `${what} length`); for (let i = 0; i < a.length; i++) assert.ok(Math.abs(a[i] - b[i]) <= tol, `${what}[${i}]: ${a[i]} vs ${b[i]}`); };

test('AIFF: 8, 16, 24 and 32-bit big-endian PCM, mono and stereo, rates from the 80-bit field', () => {
  for (const [bits, tol] of [[8, 0.015], [16, 6e-5], [24, 1e-6], [32, 1e-6]]) {
    for (const rate of [44100, 48000, 22050, 96000]) {
      const L = ramp(300), R = ramp(300, -0.5);
      const r = decodeAiff(aiff([L, R], rate, { bits }));
      assert.equal(r.rate, rate, `${bits} bit rate`);
      assert.equal(r.channels.length, 2);
      close(r.channels[0], L, tol, `${bits} bit L`); close(r.channels[1], R, tol, `${bits} bit R`);
    }
  }
  const mono = decodeAiff(aiff([ramp(50)], 44100).buffer);   // an ArrayBuffer works too
  assert.equal(mono.channels.length, 1);
});

test('AIFF-C: sowt (little-endian), twos, fl32, fl64, SSND offset; unsupported compression and junk are refused', () => {
  const L = ramp(200), R = ramp(200, 0.3);
  close(decodeAiff(aiff([L, R], 44100, { comp: 'sowt' })).channels[1], R, 6e-5, 'sowt');
  close(decodeAiff(aiff([L], 44100, { comp: 'sowt', bits: 24 })).channels[0], L, 1e-6, 'sowt 24');
  close(decodeAiff(aiff([L], 44100, { comp: 'twos' })).channels[0], L, 6e-5, 'twos');
  close(decodeAiff(aiff([L, R], 48000, { comp: 'fl32', bits: 32 })).channels[0], L, 1e-7, 'fl32');
  close(decodeAiff(aiff([L], 48000, { comp: 'fl64', bits: 64 })).channels[0], L, 1e-7, 'fl64');
  close(decodeAiff(aiff([L], 44100, { offset: 6 })).channels[0], L, 6e-5, 'offset');
  assert.ok(isAiff(aiff([L], 44100)) && isAiff(aiff([L], 44100, { comp: 'sowt' })));
  assert.ok(!isAiff(new Uint8Array([82, 73, 70, 70, 0, 0, 0, 0, 87, 65, 86, 69])), 'a WAV is not AIFF');
  assert.throws(() => decodeAiff(aiff([L], 44100, { comp: 'ima4' })), /not supported/);
  assert.throws(() => decodeAiff(new Uint8Array(4)), /Not an AIFF/);
  const cut = aiff([L], 44100).slice(0, 60);                    // the header survives, the sound does not
  assert.throws(() => decodeAiff(cut), /no sound data/);
});
