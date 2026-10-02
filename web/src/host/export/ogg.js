// OGG export: Opus audio (WebCodecs AudioEncoder) in an Ogg container written here. Opus always runs at
// 48 kHz, so exports to this format render at 48 kHz.
let crcTable = null;
function oggCrc(bytes) {
  if (!crcTable) { crcTable = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n << 24; for (let k = 0; k < 8; k++) c = c & 0x80000000 ? (c << 1) ^ 0x04c11db7 : c << 1; crcTable[n] = c >>> 0; } }
  let c = 0;
  for (let i = 0; i < bytes.length; i++) c = ((c << 8) ^ crcTable[((c >>> 24) ^ bytes[i]) & 255]) >>> 0;
  return c >>> 0;
}

// packets: [Uint8Array]; returns one Ogg page (header type: 0x02 first page, 0x04 last page)
export function oggPage(packets, { serial, seq, granule, type = 0 }) {
  const lacing = [];
  for (const p of packets) { let l = p.length; while (l >= 255) { lacing.push(255); l -= 255; } lacing.push(l); }
  if (lacing.length > 255) throw new Error('too many segments for one Ogg page');
  const body = packets.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(27 + lacing.length + body);
  const dv = new DataView(out.buffer);
  out.set([0x4f, 0x67, 0x67, 0x53, 0, type], 0);
  dv.setUint32(6, granule % 2 ** 32 >>> 0, true); dv.setUint32(10, Math.floor(granule / 2 ** 32), true);
  dv.setUint32(14, serial, true); dv.setUint32(18, seq, true);
  out[26] = lacing.length; out.set(lacing, 27);
  let o = 27 + lacing.length; for (const p of packets) { out.set(p, o); o += p.length; }
  dv.setUint32(22, oggCrc(out), true);
  return out;
}

export function opusHead(channels, inputRate, preSkip) {
  const h = new Uint8Array(19); const dv = new DataView(h.buffer);
  h.set([0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64, 1, channels]);
  dv.setUint16(10, preSkip, true); dv.setUint32(12, inputRate, true); dv.setUint16(16, 0, true); h[18] = 0;
  return h;
}
export function opusTags(vendor = 'FL LUA', comments = []) {
  const enc = new TextEncoder(), v = enc.encode(vendor), cs = comments.map((c) => enc.encode(c));
  const len = 8 + 4 + v.length + 4 + cs.reduce((a, c) => a + 4 + c.length, 0);
  const out = new Uint8Array(len), dv = new DataView(out.buffer);
  out.set([0x4f, 0x70, 0x75, 0x73, 0x54, 0x61, 0x67, 0x73]);
  let o = 8; dv.setUint32(o, v.length, true); o += 4; out.set(v, o); o += v.length;
  dv.setUint32(o, cs.length, true); o += 4;
  for (const c of cs) { dv.setUint32(o, c.length, true); o += 4; out.set(c, o); o += c.length; }
  return out;
}

// Mux already-encoded 20 ms Opus packets. total = number of real samples per channel (before padding).
export function muxOggOpus(packets, { channels = 2, totalSamples, preSkip = 312, serial = 0x464c4c55, comments = [] } = {}) {
  const pages = [oggPage([opusHead(channels, 48000, preSkip)], { serial, seq: 0, granule: 0, type: 0x02 }), oggPage([opusTags('FL LUA', comments)], { serial, seq: 1, granule: 0 })];
  let seq = 2, acc = 0;
  const PER = 40;                                                   // packets per page
  for (let i = 0; i < packets.length; i += PER) {
    const group = packets.slice(i, i + PER);
    acc += group.length * 960;
    const last = i + PER >= packets.length;
    pages.push(oggPage(group, { serial, seq: seq++, granule: last ? totalSamples + preSkip : acc, type: last ? 0x04 : 0 }));
  }
  const out = new Uint8Array(pages.reduce((a, p) => a + p.length, 0));
  let o = 0; for (const p of pages) { out.set(p, o); o += p.length; }
  return out;
}

export const oggSupported = () => typeof AudioEncoder !== 'undefined' && typeof AudioData !== 'undefined';

// left/right at 48000 Hz. Returns Uint8Array (.ogg, Opus). onProgress(0..1)
export async function encodeOggOpus(left, right, { bitrate = 192000, channels = 2, onProgress, shouldCancel } = {}) {
  if (!oggSupported()) throw new Error('OGG export needs a browser with WebCodecs (Chrome, Edge)');
  const cfg = { codec: 'opus', sampleRate: 48000, numberOfChannels: channels, bitrate };
  const sup = await AudioEncoder.isConfigSupported(cfg);
  if (!sup.supported) throw new Error('This browser has no Opus encoder');
  const packets = [];
  let preSkip = 312, error = null;
  const encoder = new AudioEncoder({
    output: (chunk, meta) => {
      const b = new Uint8Array(chunk.byteLength); chunk.copyTo(b); packets.push(b);
      const d = meta && meta.decoderConfig && meta.decoderConfig.description;
      if (d && packets.length === 1) { const dv = new DataView(d.buffer ? d.buffer : d, d.byteOffset || 0); if (dv.byteLength >= 12) preSkip = dv.getUint16(10, true); }
    },
    error: (e) => { error = e; },
  });
  encoder.configure(cfg);
  const n = left.length, FRAME = 960;
  const plane = new Float32Array(FRAME * channels);
  for (let i = 0; i < n; i += FRAME) {
    if (error) throw error;
    if (shouldCancel && shouldCancel()) { encoder.close(); return null; }
    plane.fill(0);
    const len = Math.min(FRAME, n - i);
    for (let j = 0; j < len; j++) { plane[j] = channels === 1 ? (left[i + j] + right[i + j]) * 0.5 : left[i + j]; if (channels === 2) plane[FRAME + j] = right[i + j]; }
    const data = new AudioData({ format: 'f32-planar', sampleRate: 48000, numberOfFrames: FRAME, numberOfChannels: channels, timestamp: Math.round((i / 48000) * 1e6), data: plane });
    encoder.encode(data); data.close();
    if (((i / FRAME) & 127) === 0) { if (onProgress) onProgress(i / n); await new Promise((r) => setTimeout(r, 0)); }
  }
  await encoder.flush(); encoder.close();
  if (error) throw error;
  return muxOggOpus(packets, { channels, totalSamples: n, preSkip });
}
