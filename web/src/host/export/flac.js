// FLAC encoder (16 or 24 bit, stereo or mono). Frames of 4096 samples; per frame it tries independent,
// left/side, side/right and mid/side channel coding and, per channel, a constant, a verbatim or a fixed
// polynomial predictor (order 0-4) with partitioned Rice residual coding, keeping the smallest.
// The output is a plain, valid FLAC stream (STREAMINFO with the MD5 field left at zero = unknown).

class Bits {
  constructor() { this.bytes = []; this.cur = 0; this.n = 0; }
  write(value, bits) {                 // value: non-negative integer (< 2^32), bits <= 32
    for (let i = bits - 1; i >= 0; i--) { this.cur = (this.cur << 1) | ((value >>> i) & 1); if (++this.n === 8) { this.bytes.push(this.cur); this.cur = 0; this.n = 0; } }
  }
  signed(v, bits) { this.write(v < 0 ? v + 2 ** bits : v, bits); }
  unary(q) { for (let i = 0; i < q; i++) this.write(0, 1); this.write(1, 1); }
  align() { while (this.n) this.write(0, 1); }
  get bitLength() { return this.bytes.length * 8 + this.n; }
}

const crc8 = (b) => { let c = 0; for (const x of b) { c ^= x; for (let k = 0; k < 8; k++) c = c & 0x80 ? ((c << 1) ^ 0x07) & 255 : (c << 1) & 255; } return c; };
const crc16 = (b) => { let c = 0; for (const x of b) { c ^= x << 8; for (let k = 0; k < 8; k++) c = c & 0x8000 ? ((c << 1) ^ 0x8005) & 0xffff : (c << 1) & 0xffff; } return c; };

function utf8Number(n) {                // FLAC's UTF-8 style coding of the frame number
  if (n < 0x80) return [n];
  const out = []; let len = 2;
  while (n >= 2 ** (len === 2 ? 11 : 5 * len + 1)) len++;
  for (let i = 0; i < len - 1; i++) { out.unshift(0x80 | (n & 63)); n = Math.floor(n / 64); }
  out.unshift(((0xff << (8 - len)) & 255) | n);
  return out;
}

const zig = (v) => (v >= 0 ? v * 2 : -v * 2 - 1);

function residualOf(x, order) {
  const n = x.length, r = new Array(n - order);
  for (let i = order; i < n; i++) {
    switch (order) {
      case 0: r[i - order] = x[i]; break;
      case 1: r[i - order] = x[i] - x[i - 1]; break;
      case 2: r[i - order] = x[i] - 2 * x[i - 1] + x[i - 2]; break;
      case 3: r[i - order] = x[i] - 3 * x[i - 1] + 3 * x[i - 2] - x[i - 3]; break;
      default: r[i - order] = x[i] - 4 * x[i - 1] + 6 * x[i - 2] - 4 * x[i - 3] + x[i - 4];
    }
  }
  return r;
}

// best partitioned-Rice layout for a residual: returns { bits, order, params[] }
function planRice(res, blockSize, predOrder) {
  let best = null;
  for (let po = 0; po <= 8; po++) {
    const parts = 1 << po;
    if (blockSize % parts) break;
    const psize = blockSize / parts;
    if (psize <= predOrder) break;
    let total = 0; const params = [];
    for (let k = 0, s = 0; k < parts; k++) {
      const from = k === 0 ? 0 : k * psize - predOrder, to = (k + 1) * psize - predOrder;
      let sum = 0; for (let i = from; i < to; i++) sum += zig(res[i]);
      const count = to - from;
      let p = 0; const mean = sum / Math.max(1, count);
      while (p < 30 && (1 << (p + 1)) <= mean + 1) p++;
      // pick the best parameter around the estimate
      let bp = p, bb = Infinity;
      for (let q = Math.max(0, p - 1); q <= Math.min(30, p + 1); q++) {
        let b = count * (q + 1);
        for (let i = from; i < to; i++) b += zig(res[i]) >>> q;
        if (b < bb) { bb = b; bp = q; }
      }
      params.push(bp); total += bb + 5; s += count;
    }
    total += 4;
    if (!best || total < best.bits) best = { bits: total, order: po, params };
  }
  return best;
}

function writeSubframe(bw, x, bps) {
  const n = x.length;
  let same = true; for (let i = 1; i < n; i++) if (x[i] !== x[0]) { same = false; break; }
  if (same) { bw.write(0, 1); bw.write(0, 6); bw.write(0, 1); bw.signed(x[0], bps); return; }
  let best = { bits: n * bps, type: 'verbatim' };
  for (let order = 0; order <= 4 && order < n; order++) {
    const res = residualOf(x, order);
    const plan = planRice(res, n, order);
    if (!plan) continue;
    const bits = order * bps + 2 + plan.bits;
    if (bits < best.bits) best = { bits, type: 'fixed', order, res, plan };
  }
  if (best.type === 'verbatim') { bw.write(0, 1); bw.write(1, 6); bw.write(0, 1); for (let i = 0; i < n; i++) bw.signed(x[i], bps); return; }
  const { order, res, plan } = best;
  bw.write(0, 1); bw.write(8 + order, 6); bw.write(0, 1);
  for (let i = 0; i < order; i++) bw.signed(x[i], bps);
  bw.write(1, 2); bw.write(plan.order, 4);                        // 5-bit Rice parameters
  const parts = 1 << plan.order, psize = n / parts;
  for (let k = 0; k < parts; k++) {
    const from = k === 0 ? 0 : k * psize - order, to = (k + 1) * psize - order, p = plan.params[k];
    bw.write(p, 5);
    for (let i = from; i < to; i++) { const u = zig(res[i]); bw.unary(u >>> p); if (p) bw.write(u & ((1 << p) - 1), p); }
  }
}

// channels: Int32Array per channel (already quantised to `bits`)
function frame(chans, start, size, frameNo, bits) {
  const slices = chans.map((c) => c.subarray(start, start + size));
  let assign = 1, parts = slices, extraBits = [0, 0];
  if (slices.length === 2) {
    const [l, r] = slices;
    const side = new Int32Array(size), mid = new Int32Array(size);
    for (let i = 0; i < size; i++) { side[i] = l[i] - r[i]; mid[i] = (l[i] + r[i]) >> 1; }
    const cost = (a, bps) => { const bw = new Bits(); writeSubframe(bw, a, bps); return bw.bitLength; };
    const cl = cost(l, bits), cr = cost(r, bits), cs = cost(side, bits + 1), cm = cost(mid, bits);
    const opts = [[cl + cr, 1, [l, r], [0, 0]], [cl + cs, 8, [l, side], [0, 1]], [cs + cr, 9, [side, r], [1, 0]], [cm + cs, 10, [mid, side], [0, 1]]];
    opts.sort((a, b) => a[0] - b[0]);
    [, assign, parts, extraBits] = opts[0];
  } else assign = 0;
  const hb = new Bits();
  hb.write(0xfff8, 16);
  const bsCode = size === 4096 ? 12 : size <= 256 ? 6 : 7;
  hb.write(bsCode, 4); hb.write(0, 4);                          // sample rate: from STREAMINFO
  hb.write(assign, 4);
  hb.write(bits === 16 ? 4 : bits === 24 ? 6 : 5, 3); hb.write(0, 1);
  for (const b of utf8Number(frameNo)) hb.write(b, 8);
  if (bsCode === 6) hb.write(size - 1, 8); else if (bsCode === 7) hb.write(size - 1, 16);
  const hbytes = hb.bytes;
  hb.write(crc8(hbytes), 8);
  const out = new Bits();
  out.bytes.push(...hb.bytes);
  parts.forEach((x, i) => writeSubframe(out, x, bits + extraBits[i]));
  out.align();
  const crc = crc16(out.bytes);
  out.bytes.push(crc >> 8, crc & 255);
  return out.bytes;
}

// left/right: Float32Array in -1..1. opts: { bits: 16 | 24, dither, channels: 1 | 2 }
export function encodeFlac(left, right, sampleRate, { bits = 16, dither = true, channels = 2 } = {}) {
  const n = left.length, nch = channels === 1 ? 1 : 2;
  const scale = bits === 24 ? 8388607 : 32767;
  let seed = 0x2468ace;
  const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  const q = (x) => { let v = x * scale; if (dither && bits < 24) v += rnd() - rnd(); return Math.max(-scale - 1, Math.min(scale, Math.round(v))); };
  const chans = nch === 1 ? [Int32Array.from({ length: n }, (_, i) => q((left[i] + right[i]) * 0.5))] : [Int32Array.from(left, q), Int32Array.from(right, q)];
  const BLOCK = 4096;
  const frames = [];
  for (let start = 0, no = 0; start < n; start += BLOCK, no++) frames.push(frame(chans, start, Math.min(BLOCK, n - start), no, bits));
  const si = new Bits();
  si.write(BLOCK, 16); si.write(BLOCK, 16); si.write(0, 24); si.write(0, 24);
  si.write(sampleRate, 20); si.write(nch - 1, 3); si.write(bits - 1, 5);
  si.write(Math.floor(n / 2 ** 32), 4); si.write(n >>> 0, 32);
  for (let i = 0; i < 16; i++) si.write(0, 8);
  const total = 4 + 4 + 34 + frames.reduce((a, f) => a + f.length, 0);
  const out = new Uint8Array(total);
  out.set([0x66, 0x4c, 0x61, 0x43, 0x80, 0, 0, 34], 0);
  out.set(si.bytes, 8);
  let o = 42; for (const f of frames) { out.set(f, o); o += f.length; }
  return out;
}
