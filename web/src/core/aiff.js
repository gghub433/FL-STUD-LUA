// AIFF / AIFF-C reader. Chromium (and so the desktop app) cannot decode AIFF with decodeAudioData, yet sample packs
// made on a Mac are full of .aif files. Uncompressed PCM (8–32 bit, big- or little-endian "sowt") and 32/64-bit float.
const tag = (d, o) => String.fromCharCode(d[o], d[o + 1], d[o + 2], d[o + 3]);

export function isAiff(bytes) {
  const d = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return d.length >= 12 && tag(d, 0) === 'FORM' && (tag(d, 8) === 'AIFF' || tag(d, 8) === 'AIFC');
}

// 80-bit IEEE 754 extended (the sample rate in the COMM chunk)
function extended(dv, o) {
  const se = dv.getUint16(o), hi = dv.getUint32(o + 2), lo = dv.getUint32(o + 6);
  const e = se & 0x7fff;
  if (!e && !hi && !lo) return 0;
  const v = (hi * 2 ** 32 + lo) * 2 ** (e - 16383 - 63);
  return se & 0x8000 ? -v : v;
}

// -> { rate, channels: Float32Array[] } (all channels of the file)
export function decodeAiff(bytes) {
  const d = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (!isAiff(d)) throw new Error('Not an AIFF file');
  const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
  const aifc = tag(d, 8) === 'AIFC';
  let comm = null, data = -1, dataEnd = 0;
  for (let o = 12; o + 8 <= d.length;) {
    const id = tag(d, o), size = dv.getUint32(o + 4), body = o + 8;
    if (id === 'COMM' && size >= 18 && body + 18 <= d.length) {
      comm = { nch: dv.getUint16(body), frames: dv.getUint32(body + 2), bits: dv.getUint16(body + 6), rate: extended(dv, body + 8), comp: aifc && size >= 22 && body + 22 <= d.length ? tag(d, body + 18) : 'NONE' };
    } else if (id === 'SSND' && size >= 8 && body + 8 <= d.length) {
      data = body + 8 + dv.getUint32(body); dataEnd = Math.min(d.length, body + size);
    }
    o = body + size + (size & 1);
  }
  if (!comm || data < 0) throw new Error('The AIFF file has no sound data');
  const { nch, bits, rate, comp } = comm;
  const float = /^fl(32|64)$/i.test(comp);
  const little = comp === 'sowt';
  if (!float && !little && comp !== 'NONE' && comp !== 'twos') throw new Error(`AIFF-C compression "${comp}" is not supported`);
  if (!nch || !(rate > 0)) throw new Error('The AIFF file is damaged');
  const width = float ? (/64/.test(comp) ? 8 : 4) : Math.ceil(bits / 8);
  if (width < 1 || width > (float ? 8 : 4)) throw new Error('The AIFF file is damaged');
  const frames = Math.min(comm.frames, Math.floor((dataEnd - data) / (width * nch)));
  if (!(frames > 0)) throw new Error('The AIFF file has no sound data');
  const channels = Array.from({ length: nch }, () => new Float32Array(frames));
  const read = float ? (o) => (width === 8 ? dv.getFloat64(o) : dv.getFloat32(o))
    : width === 1 ? (o) => dv.getInt8(o) / 128
      : width === 2 ? (o) => dv.getInt16(o, little) / 32768
        : width === 3 ? (little ? (o) => (((d[o + 2] << 24) | (d[o + 1] << 16) | (d[o] << 8)) >> 8) / 8388608 : (o) => (((d[o] << 24) | (d[o + 1] << 16) | (d[o + 2] << 8)) >> 8) / 8388608)
          : (o) => dv.getInt32(o, little) / 2147483648;
  for (let i = 0, o = data; i < frames; i++) for (let c = 0; c < nch; c++, o += width) channels[c][i] = read(o);
  return { rate: Math.round(rate), channels };
}
