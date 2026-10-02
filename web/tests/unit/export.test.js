import test from 'node:test';
import assert from 'node:assert/strict';
import { createProject, createChannel, createNote, createClip, currentArrangement, createPattern, barTicks } from '../../src/core/project.js';
import { writeMidi, readMidi, channelNotes } from '../../src/core/midi-file.js';
import { PPQ, STEP } from '../../src/core/constants.js';

function project() {
  const p = createProject(); p.tempo = 97.5; p.timeSig = { num: 3, den: 4 };
  const a = createChannel(p, 'subsynth', { name: 'Lead' }), b = createChannel(p, 'drums', { name: 'Kick' });
  p.channels.push(a, b);
  p.patterns[1].notes[a.id] = [createNote(p, 0, 48, 60, 100), createNote(p, 48, 24, 64, 80), createNote(p, 48, 24, 67, 90)];
  p.patterns[1].notes[b.id] = [createNote(p, 0, STEP, 36, 120), createNote(p, 4 * STEP, STEP, 36, 110)];
  return { p, a, b };
}

test('MIDI file: pattern export reads back with the same notes, tempo, time signature and names', () => {
  const { p, a, b } = project();
  const bytes = writeMidi(p, { mode: 'pat' });
  assert.equal(String.fromCharCode(...bytes.slice(0, 4)), 'MThd');
  const m = readMidi(bytes);
  assert.equal(m.format, 1); assert.equal(m.ppq, PPQ);
  assert.ok(Math.abs(m.tempo - 97.5) < 0.01, `tempo ${m.tempo}`);
  assert.deepEqual(m.timeSig, { num: 3, den: 4 });
  assert.deepEqual(m.tracks.map((t) => t.name), ['FL LUA', 'Lead', 'Kick'].map((n, i) => (i === 0 ? p.meta.title : n)));
  const lead = m.tracks[1].notes.map(({ s, l, k, v }) => [s, l, k, v]);
  assert.deepEqual(lead, [[0, 48, 60, 100], [48, 24, 64, 80], [48, 24, 67, 90]]);
  const kick = m.tracks[2];
  assert.deepEqual(kick.notes.map((n) => [n.s, n.k, n.v]), [[0, 36, 120], [96, 36, 110]]);
  assert.ok(kick.notes.every((n) => n.ch === 9), 'drums go to MIDI channel 10');
  assert.ok(m.tracks[1].notes.every((n) => n.ch !== 9), 'melodic channels avoid channel 10');
  void a; void b;
});

test('MIDI file: song export unrolls pattern clips, loops short patterns and honours clip windows', () => {
  const { p, a } = project();
  const arr = currentArrangement(p), bar = barTicks(p.timeSig);                  // 3/4 bar = 288 ticks; pattern 1 is one bar long
  arr.clips.push(createClip(p, 'pattern', 1, bar, 2 * bar, 1));                  // plays twice, starting at bar 2
  arr.clips.push(createClip(p, 'pattern', 1, 4 * bar, 48, 1));                   // a clip cut after 48 ticks
  const n = channelNotes(p, a.id, 'song');
  assert.deepEqual(n.map((x) => x.s), [bar, bar + 48, bar + 48, 2 * bar, 2 * bar + 48, 2 * bar + 48, 4 * bar]);
  assert.ok(n.every((x) => x.l >= 1));
  const back = readMidi(writeMidi(p, { mode: 'song' }));
  assert.equal(back.tracks[1].notes.length, 7);
  assert.equal(readMidi(writeMidi(p, { mode: 'song', channelIds: [a.id] })).tracks.length, 2, 'channel filter');
});

test('MIDI reader handles running status, note-off as velocity 0, tempo and rescales other resolutions', () => {
  // format 0, division 480, running status, "note on vel 0" as off
  const trk = [0, 0xff, 0x51, 3, 0x07, 0xa1, 0x20,                       // 500000 us per quarter = 120 bpm
    0, 0x90, 60, 100, 0x81, 0x70, 62, 90,                              // running status second note-on after 240 ticks (VLQ 0x81 0x70)
    0x81, 0x70, 60, 0, 0x81, 0x70, 62, 0, 0, 0xff, 0x2f, 0];             // note-offs written as velocity 0 (running status again)
  const bytes = Uint8Array.from([0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, 0x01, 0xe0, 0x4d, 0x54, 0x72, 0x6b, 0, 0, 0, trk.length, ...trk]);
  const m = readMidi(bytes);
  assert.equal(m.tempo, 120);
  assert.deepEqual(m.tracks[0].notes.map(({ s, l, k, v }) => [s, l, k, v]), [[0, 96, 60, 100], [48, 96, 62, 90]]);   // 480 ppq -> 96 ppq: 240 ticks = 48
  assert.throws(() => readMidi(new Uint8Array([1, 2, 3])), /Not a MIDI file/);
});

// ---- ZIP ----------------------------------------------------------------------------------
import { zipStore, unzip, crc32 } from '../../src/core/zip.js';
import { encodeFlac } from '../../src/host/export/flac.js';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('zip: stored entries round-trip with CRCs; names may be UTF-8; python can read the archive', async () => {
  const files = [{ name: 'project.fllua', data: new TextEncoder().encode('{"a":1}') }, { name: 'samples/ü-kick.wav', data: Uint8Array.from({ length: 5000 }, (_, i) => (i * 7) & 255) }, { name: 'empty.txt', data: new Uint8Array(0) }];
  const zip = zipStore(files);
  const back = await unzip(zip);
  assert.deepEqual(back.map((f) => f.name), files.map((f) => f.name));
  back.forEach((f, i) => assert.deepEqual([...f.data], [...files[i].data]));
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
  const corrupt = zip.slice(); corrupt[46] ^= 0xff;
  await assert.rejects(() => unzip(corrupt), /CRC|Broken|Unsupported/);
  const tmp = path.join(os.tmpdir(), `fllua-${process.pid}.zip`);
  fs.writeFileSync(tmp, zip);
  try {
    const out = execFileSync('python3', ['-c', 'import zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; print(",".join(sorted(z.namelist())))', tmp]).toString().trim();
    assert.equal(out, files.map((f) => f.name).sort().join(','));
  } catch (e) { if (e.code !== 'ENOENT') throw e; }       // no python on this machine: skip the cross-check
  finally { fs.unlinkSync(tmp); }
});

// ---- FLAC: an independent decoder (fixed/constant/verbatim subframes, Rice) checks the encoder bit-exactly ----
function decodeFlac(buf) {
  let p = 0;
  assert.equal(String.fromCharCode(...buf.slice(0, 4)), 'fLaC'); p = 4;
  let info = null, last = false;
  while (!last) { const h = buf[p++]; last = !!(h & 128); const type = h & 127, len = (buf[p] << 16) | (buf[p + 1] << 8) | buf[p + 2]; p += 3; if (type === 0) info = buf.slice(p, p + len); p += len; }
  const bits = ((info[12] & 1) << 4 | info[13] >> 4) + 1, nch = ((info[12] >> 1) & 7) + 1;
  const rate = (info[10] << 12) | (info[11] << 4) | (info[12] >> 4);
  const total = ((info[13] & 15) * 2 ** 32) + ((info[14] << 24) | (info[15] << 16) | (info[16] << 8) | info[17]) >>> 0;
  const outCh = Array.from({ length: nch }, () => []);
  let bp = p * 8;
  const read = (n) => { let v = 0; for (let i = 0; i < n; i++, bp++) v = v * 2 + ((buf[bp >> 3] >> (7 - (bp & 7))) & 1); return v; };
  const sread = (n) => { const v = read(n); return v >= 2 ** (n - 1) ? v - 2 ** n : v; };
  const crc8 = (b) => { let c = 0; for (const x of b) { c ^= x; for (let k = 0; k < 8; k++) c = c & 0x80 ? ((c << 1) ^ 7) & 255 : (c << 1) & 255; } return c; };
  const crc16 = (b) => { let c = 0; for (const x of b) { c ^= x << 8; for (let k = 0; k < 8; k++) c = c & 0x8000 ? ((c << 1) ^ 0x8005) & 0xffff : (c << 1) & 0xffff; } return c; };
  while (outCh[0].length < total) {
    const fstart = bp >> 3;
    assert.equal(read(14), 0x3ffe, 'sync'); read(2);
    const bsCode = read(4), rateCode = read(4), assign = read(4), szCode = read(3); read(1);
    let first = read(8); if (first >= 0xc0) { let n = first >= 0xfc ? 5 : first >= 0xf8 ? 4 : first >= 0xf0 ? 3 : first >= 0xe0 ? 2 : 1; while (n--) read(8); }
    let size = bsCode === 12 ? 4096 : bsCode === 6 ? read(8) + 1 : bsCode === 7 ? read(16) + 1 : -1;
    assert.ok(size > 0 && rateCode === 0);
    const hdrEnd = bp >> 3;
    assert.equal(read(8), crc8(buf.slice(fstart, hdrEnd)), 'header crc8');
    const bps = szCode === 4 ? 16 : szCode === 6 ? 24 : 0;
    assert.equal(bps, bits);
    const decodeSub = (sb) => {
      assert.equal(read(1), 0); const type = read(6); assert.equal(read(1), 0, 'no wasted bits');
      const out = new Array(size);
      if (type === 0) { out.fill(sread(sb)); return out; }
      if (type === 1) { for (let i = 0; i < size; i++) out[i] = sread(sb); return out; }
      assert.ok(type >= 8 && type <= 12, `subframe type ${type}`);
      const order = type - 8;
      for (let i = 0; i < order; i++) out[i] = sread(sb);
      const method = read(2), pord = read(4), pbits = method === 0 ? 4 : 5;
      const parts = 1 << pord, psize = size >> pord;
      for (let k = 0; k < parts; k++) {
        const prm = read(pbits);
        const from = k === 0 ? order : k * psize, to = (k + 1) * psize;
        for (let i = from; i < to; i++) {
          let q = 0; while (read(1) === 0) q++;
          const u = q * 2 ** prm + (prm ? read(prm) : 0);
          const r = u & 1 ? -(u + 1) / 2 : u / 2;
          const x = (j) => out[i - j];
          out[i] = r + (order === 0 ? 0 : order === 1 ? x(1) : order === 2 ? 2 * x(1) - x(2) : order === 3 ? 3 * x(1) - 3 * x(2) + x(3) : 4 * x(1) - 6 * x(2) + 4 * x(3) - x(4));
        }
      }
      return out;
    };
    let chs;
    if (assign <= 7) chs = Array.from({ length: assign + 1 }, () => decodeSub(bits));
    else if (assign === 8) { const l = decodeSub(bits), s = decodeSub(bits + 1); chs = [l, l.map((v, i) => v - s[i])]; }
    else if (assign === 9) { const s = decodeSub(bits + 1), r = decodeSub(bits); chs = [s.map((v, i) => v + r[i]), r]; }
    else { const m = decodeSub(bits), s = decodeSub(bits + 1); chs = [m.map((mm, i) => { const sum = mm * 2 + (s[i] & 1); return (sum + s[i]) / 2; }), m.map((mm, i) => { const sum = mm * 2 + (s[i] & 1); return (sum - s[i]) / 2; })]; }
    while (bp & 7) bp++;
    const fend = bp >> 3;
    assert.equal(read(16), crc16(buf.slice(fstart, fend)), 'frame crc16');
    chs.forEach((c, i) => outCh[i].push(...c));
  }
  return { rate, bits, channels: outCh, total };
}

test('FLAC encoder output decodes bit-exactly (16/24 bit, stereo/mono, constant and short blocks) and compresses', () => {
  const SR = 44100, n = 10000;
  const L = Float32Array.from({ length: n }, (_, i) => 0.6 * Math.sin((2 * Math.PI * 330 * i) / SR) + 0.1 * Math.sin((2 * Math.PI * 3300 * i) / SR));
  const R = Float32Array.from({ length: n }, (_, i) => 0.5 * Math.sin((2 * Math.PI * 440 * i) / SR + 1));
  for (const bits of [16, 24]) {
    const flac = encodeFlac(L, R, SR, { bits, dither: false });
    const d = decodeFlac(flac);
    assert.equal(d.rate, SR); assert.equal(d.bits, bits); assert.equal(d.total, n); assert.equal(d.channels.length, 2);
    const scale = bits === 24 ? 8388607 : 32767;
    for (let i = 0; i < n; i += 3) {
      assert.equal(d.channels[0][i], Math.round(L[i] * scale) || 0, `${bits}-bit left sample ${i}`);
      assert.equal(d.channels[1][i], Math.round(R[i] * scale) || 0, `${bits}-bit right sample ${i}`);
    }
    assert.ok(flac.length < n * 2 * (bits / 8) * 0.75, `${bits}-bit: ${flac.length} bytes vs raw ${n * 2 * bits / 8}`);
  }
  const mono = decodeFlac(encodeFlac(L, R, SR, { bits: 16, dither: false, channels: 1 }));
  assert.equal(mono.channels.length, 1);
  assert.ok(Math.abs(mono.channels[0][100] - Math.round(((L[100] + R[100]) * 0.5) * 32767)) <= 1);
  const silent = decodeFlac(encodeFlac(new Float32Array(5000), new Float32Array(5000), SR, { bits: 16, dither: false }));
  assert.equal(silent.total, 5000); assert.ok(silent.channels[0].every((v) => v === 0));
  const noise = Float32Array.from({ length: 9000 }, (_, i) => Math.sin(i * i * 0.37) * 0.9);
  const dn = decodeFlac(encodeFlac(noise, noise, SR, { bits: 24, dither: false }));
  assert.equal(dn.channels[1][4321], Math.round(noise[4321] * 8388607) || 0, 'full-scale noisy signal survives');
  const tiny = decodeFlac(encodeFlac(L.subarray(0, 3), R.subarray(0, 3), SR, { bits: 16, dither: false }));
  assert.equal(tiny.total, 3);
  const loud = decodeFlac(encodeFlac(Float32Array.of(1, -1, 1, -1, 1, -1, 1, -1), Float32Array.of(-1, 1, -1, 1, -1, 1, -1, 1), SR, { bits: 24, dither: false }));
  assert.deepEqual(loud.channels[0], [8388607, -8388607, 8388607, -8388607, 8388607, -8388607, 8388607, -8388607]);
  assert.deepEqual(loud.channels[1], [-8388607, 8388607, -8388607, 8388607, -8388607, 8388607, -8388607, 8388607]);
});

// ---- OGG container ------------------------------------------------------------------------
import { muxOggOpus, oggPage, opusHead } from '../../src/host/export/ogg.js';
import { createRequire } from 'node:module';

function parseOgg(bytes) {
  const pages = []; let p = 0;
  const crcT = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n << 24; for (let k = 0; k < 8; k++) c = c & 0x80000000 ? (c << 1) ^ 0x04c11db7 : c << 1; crcT[n] = c >>> 0; }
  while (p < bytes.length) {
    assert.equal(String.fromCharCode(...bytes.slice(p, p + 4)), 'OggS');
    const dv = new DataView(bytes.buffer, bytes.byteOffset + p), nseg = bytes[p + 26];
    const lacing = [...bytes.slice(p + 27, p + 27 + nseg)], body = lacing.reduce((a, b) => a + b, 0), total = 27 + nseg + body;
    const copy = bytes.slice(p, p + total); copy.fill(0, 22, 26);
    let c = 0; for (const x of copy) c = ((c << 8) ^ crcT[((c >>> 24) ^ x) & 255]) >>> 0;
    assert.equal(c >>> 0, dv.getUint32(22, true), 'page crc');
    // packets (a lacing value < 255 ends a packet)
    const packets = []; let o = p + 27 + nseg, cur = 0;
    for (const l of lacing) { cur += l; if (l < 255) { packets.push(bytes.slice(o, o + cur)); o += cur; cur = 0; } }
    pages.push({ type: bytes[p + 5], granule: dv.getUint32(6, true) + dv.getUint32(10, true) * 2 ** 32, seq: dv.getUint32(18, true), serial: dv.getUint32(14, true), packets });
    p += total;
  }
  return pages;
}

test('Ogg Opus muxer: valid pages (CRC, sequence, BOS/EOS), headers first, long packets spanning segments', () => {
  const packets = Array.from({ length: 95 }, (_, i) => Uint8Array.from({ length: i === 3 ? 700 : 60 + (i % 7) }, (_, j) => (i + j) & 255));
  const ogg = muxOggOpus(packets, { channels: 2, totalSamples: 95 * 960 - 400, preSkip: 312 });
  const pages = parseOgg(ogg);
  assert.equal(pages[0].type, 2); assert.equal(pages[0].packets.length, 1);
  assert.equal(String.fromCharCode(...pages[0].packets[0].slice(0, 8)), 'OpusHead'); assert.equal(pages[0].packets[0][9], 2);
  assert.equal(String.fromCharCode(...pages[1].packets[0].slice(0, 8)), 'OpusTags');
  pages.forEach((pg, i) => assert.equal(pg.seq, i, 'page sequence numbers'));
  assert.equal(new Set(pages.map((x) => x.serial)).size, 1);
  assert.equal(pages.at(-1).type, 4, 'last page is flagged EOS');
  assert.equal(pages.at(-1).granule, 95 * 960 - 400 + 312, 'granule of the last page = real samples + pre-skip');
  const back = pages.slice(2).flatMap((x) => x.packets);
  assert.equal(back.length, 95); back.forEach((b, i) => assert.deepEqual([...b], [...packets[i]]));
  assert.equal(opusHead(2, 48000, 312).length, 19);
  assert.throws(() => oggPage(Array.from({ length: 300 }, () => new Uint8Array(10)), { serial: 1, seq: 0, granule: 0 }), /too many segments/);
});

test('MP3 export through the vendored lamejs produces a valid MPEG stream with the right duration', async () => {
  const src = fs.readFileSync(new URL('../../vendor/lamejs/lame.min.js', import.meta.url), 'utf8');
  const lame = new Function(`${src}; return lamejs;`)();
  const { encodeMp3 } = await import('../../src/host/export/mp3.js');
  const SR = 44100, n = SR;
  const L = Float32Array.from({ length: n }, (_, i) => 0.5 * Math.sin((2 * Math.PI * 440 * i) / SR)), R = Float32Array.from(L);
  const mp3 = await encodeMp3(lame, L, R, SR, { kbps: 128 });
  assert.equal(mp3[0], 0xff); assert.ok((mp3[1] & 0xe0) === 0xe0, 'frame sync');
  const sizeAt128 = (128000 / 8) * (n / SR);
  assert.ok(Math.abs(mp3.length - sizeAt128) < sizeAt128 * 0.1, `128 kbps for 1 s is about 16 kB, got ${mp3.length}`);
  const cancelled = await encodeMp3(lame, L, R, SR, { shouldCancel: () => true, onProgress: () => {} });
  void cancelled; void createRequire;
});

// ---- WAV read-back and project zip -----------------------------------------------------------
import { encodeWav, decodeWav } from '../../src/host/export/wav.js';
import { projectToZip, projectFromZip, userSampleIds } from '../../src/app/project-io.js';

test('WAV decode reads back what encodeWav wrote (16/24/32f, mono/stereo)', () => {
  const n = 500, L = Float32Array.from({ length: n }, (_, i) => Math.sin(i / 7) * 0.8), R = Float32Array.from({ length: n }, (_, i) => Math.cos(i / 5) * 0.4);
  for (const [bits, tol] of [[16, 2 / 32767], [24, 2 / 8388607], [32, 0]]) {
    const w = decodeWav(encodeWav(L, R, 48000, { bits, dither: false }));
    assert.equal(w.rate, 48000); assert.equal(w.channels.length, 2);
    for (let i = 0; i < n; i += 11) { assert.ok(Math.abs(w.channels[0][i] - L[i]) <= tol + 1e-9 && Math.abs(w.channels[1][i] - R[i]) <= tol + 1e-9, `${bits}-bit sample ${i}`); }
  }
  const mono = decodeWav(encodeWav(L, R, 44100, { bits: 32, channels: 1 }));
  assert.equal(mono.channels.length, 1);
  assert.throws(() => decodeWav(new Uint8Array(100)), /Not a WAV/);
});

test('project zip carries user samples and restores them under their ids; factory sounds are not stored', async () => {
  const p = createProject();
  const a = createChannel(p, 'sampler', { name: 'Mine', sample: { id: 'user:abc123', name: 'My loop' } }), b = createChannel(p, 'sampler', { name: 'Kick', sample: { id: 'factory:kick-punch', name: 'Kick' } });
  p.channels.push(a, b);
  assert.deepEqual(userSampleIds(p), ['user:abc123']);
  const data = Float32Array.from({ length: 2000 }, (_, i) => Math.sin(i / 9) * 0.7);
  const bank = new Map([['user:abc123', { name: 'My loop', rate: 44100, channels: [data] }]]);
  const zip = projectToZip(p, { get: (id) => bank.get(id) });
  const restored = new Map();
  const out = await projectFromZip(zip, { addPCM: (name, rate, channels, id) => restored.set(id, { name, rate, channels }) });
  assert.equal(out.restored, 1);
  const s = restored.get('user:abc123');
  assert.equal(s.name, 'My loop'); assert.equal(s.rate, 44100); assert.equal(s.channels.length, 1);
  for (let i = 0; i < 2000; i += 97) assert.equal(s.channels[0][i], data[i], 'float32 WAV is lossless');
  assert.equal(out.project.channels.length, 2);
  await assert.rejects(() => projectFromZip(zipStore([{ name: 'x.txt', data: new Uint8Array(3) }]), {}), /no project/);
});
