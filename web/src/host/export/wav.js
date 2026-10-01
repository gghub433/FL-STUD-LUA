// RIFF/WAVE encoder: 16/24-bit PCM (optional TPDF dither) and 32-bit float.
// left/right are Float32Array; returns Uint8Array.
export function encodeWav(left, right, sampleRate, { bits = 16, dither = true, channels = 2 } = {}) {
  const n = left.length;
  const ch = channels === 1 ? 1 : 2;
  const bytes = bits === 32 ? 4 : bits === 24 ? 3 : 2;
  const dataSize = n * ch * bytes;
  const buf = new ArrayBuffer(44 + dataSize);
  const dv = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); dv.setUint32(4, 36 + dataSize, true); w(8, 'WAVE');
  w(12, 'fmt '); dv.setUint32(16, 16, true);
  dv.setUint16(20, bits === 32 ? 3 : 1, true);
  dv.setUint16(22, ch, true); dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * ch * bytes, true); dv.setUint16(32, ch * bytes, true); dv.setUint16(34, bytes * 8, true);
  w(36, 'data'); dv.setUint32(40, dataSize, true);
  let o = 44;
  let seed = 0x1234567;
  const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  const scale = bits === 24 ? 8388607 : 32767;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < ch; c++) {
      let x = ch === 1 ? (left[i] + right[i]) * 0.5 : c === 0 ? left[i] : right[i];
      if (bits === 32) { dv.setFloat32(o, x, true); o += 4; continue; }
      x = x * scale;
      if (dither) x += rnd() - rnd(); // TPDF, +/-1 LSB
      x = Math.max(-scale - 1, Math.min(scale, Math.round(x)));
      if (bits === 24) { dv.setUint8(o, x & 255); dv.setUint8(o + 1, (x >> 8) & 255); dv.setUint8(o + 2, (x >> 16) & 255); o += 3; }
      else { dv.setInt16(o, x, true); o += 2; }
    }
  }
  return new Uint8Array(buf);
}

export function downloadBlob(bytes, name, type = 'application/octet-stream') {
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
