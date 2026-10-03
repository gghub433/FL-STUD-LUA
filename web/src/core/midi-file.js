// Standard MIDI File (SMF) writer and reader. The project uses 96 ticks per beat, the file keeps that
// resolution, so notes survive a round trip exactly. Export covers the current pattern or the whole
// playlist arrangement (pattern clips are unrolled like the engine does); import returns plain note lists.
import { PPQ } from './constants.js';
import { patternLength, currentArrangement, songLength } from './project.js';

const enc = new TextEncoder();
const vlq = (n) => { const b = [n & 127]; while ((n >>= 7)) b.push((n & 127) | 128); return b.reverse(); };
const be32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const be16 = (n) => [(n >> 8) & 255, n & 255];

function chunk(type, bytes) { return [...enc.encode(type), ...be32(bytes.length), ...bytes]; }
function meta(delta, type, data) { return [...vlq(delta), 0xff, type, ...vlq(data.length), ...data]; }

// notes of one channel as [{ s, l, k, v }] for the pattern or the song (pattern clips unrolled, clip windows respected)
export function channelNotes(project, chId, mode = 'song') {
  if (mode === 'pat') return (project.patterns[project.currentPattern].notes[chId] || []).filter((n) => !n.mute).map((n) => ({ s: n.s, l: n.l, k: n.k, v: n.v }));
  const out = [];
  const arr = currentArrangement(project);
  for (const clip of arr.clips) {
    if (clip.type !== 'pattern' || clip.mute) continue;
    const pat = project.patterns[clip.ref];
    if (!pat || !pat.notes[chId]) continue;
    const plen = patternLength(project, pat), end = clip.s + clip.l;
    for (let k = Math.floor(clip.o / plen); k < Math.ceil((clip.o + clip.l) / plen); k++) {
      const base = clip.s - clip.o + k * plen;
      for (const n of pat.notes[chId]) {
        if (n.mute || n.s >= plen) continue;
        const s = base + n.s;
        if (s < clip.s || s >= end) continue;
        out.push({ s, l: Math.max(1, Math.min(n.l, end - s)), k: n.k, v: n.v });
      }
    }
  }
  return out.sort((a, b) => a.s - b.s || a.k - b.k);
}

export function writeMidi(project, { mode = 'song', channelIds = null } = {}) {
  const chans = project.channels.filter((c) => c.type !== 'automation' && c.type !== 'layer' && c.type !== 'audio' && c.type !== 'controller' && (!channelIds || channelIds.includes(c.id)));
  const tracks = [];
  // conductor track: name, tempo, time signature
  const uspq = Math.round(60000000 / project.tempo), ts = project.timeSig;
  const dn = Math.round(Math.log2(ts.den));
  const t0 = [...meta(0, 0x03, [...enc.encode(project.meta.title || 'FL LUA')]), ...meta(0, 0x51, [(uspq >> 16) & 255, (uspq >> 8) & 255, uspq & 255]), ...meta(0, 0x58, [ts.num, dn, 24, 8]), ...meta(0, 0x2f, [])];
  tracks.push(chunk('MTrk', t0));
  let melodic = 0;
  for (const c of chans) {
    const drum = c.type === 'drums' || c.type === 'fpc';
    let midiCh;
    if (drum) midiCh = 9; else { midiCh = melodic % 15; if (midiCh >= 9) midiCh++; melodic++; }
    const notes = channelNotes(project, c.id, mode);
    const ev = [];                                       // [tick, order, bytes]  (offs sort before ons at the same tick)
    for (const n of notes) { ev.push([n.s, 1, [0x90 | midiCh, n.k & 127, Math.max(1, Math.min(127, n.v))]]); ev.push([n.s + n.l, 0, [0x80 | midiCh, n.k & 127, 0]]); }
    ev.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const body = [...meta(0, 0x03, [...enc.encode(c.name)])];
    let last = 0;
    for (const [t, , bytes] of ev) { body.push(...vlq(t - last), ...bytes); last = t; }
    body.push(...meta(0, 0x2f, []));
    tracks.push(chunk('MTrk', body));
  }
  const header = chunk('MThd', [...be16(1), ...be16(tracks.length), ...be16(PPQ)]);
  return Uint8Array.from([...header, ...tracks.flat()]);
}

// ---- reader -----------------------------------------------------------------------------------
// returns { format, ppq, tempo, timeSig: {num, den}, tracks: [{ name, notes: [{ s, l, k, v, ch }], programs: { ch: program } }] }
// with ticks scaled to PPQ 96 (programs: the first program change on each MIDI channel)
export function readMidi(bytes) {
  const d = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let p = 0;
  const u32 = () => ((d[p++] << 24) | (d[p++] << 16) | (d[p++] << 8) | d[p++]) >>> 0;
  const u16 = () => (d[p++] << 8) | d[p++];
  const tag = () => String.fromCharCode(d[p++], d[p++], d[p++], d[p++]);
  if (d.length < 14 || tag() !== 'MThd') throw new Error('Not a MIDI file');
  const hlen = u32(), format = u16(), ntracks = u16(), division = u16();
  p = 8 + hlen;
  if (division & 0x8000) throw new Error('SMPTE time division is not supported');
  const scale = PPQ / division;
  let tempo = 120, timeSig = { num: 4, den: 4 }, gotTempo = false;
  const tracks = [];
  for (let t = 0; t < ntracks && p + 8 <= d.length; t++) {
    const id = tag(), len = u32(), end = Math.min(d.length, p + len);
    if (id !== 'MTrk') { p = end; t--; continue; }
    let tick = 0, status = 0, name = '';
    const open = new Map(), notes = [], programs = {};
    while (p < end) {
      let delta = 0, b;
      do { b = d[p++]; delta = (delta << 7) | (b & 127); } while (b & 128 && p < end);
      tick += delta;
      let st = d[p];
      if (st & 0x80) { status = st; p++; } else st = status;           // running status
      if (st === 0xff) {
        const type = d[p++]; let l = 0; do { b = d[p++]; l = (l << 7) | (b & 127); } while (b & 128);
        const data = d.subarray(p, p + l); p += l;
        if (type === 0x03 && !name) name = String.fromCharCode(...data);
        else if (type === 0x51 && l === 3 && !gotTempo) { tempo = 60000000 / ((data[0] << 16) | (data[1] << 8) | data[2]); gotTempo = true; }
        else if (type === 0x58 && l >= 2 && tick === 0) timeSig = { num: data[0], den: 1 << data[1] };
        else if (type === 0x2f) break;
      } else if (st === 0xf0 || st === 0xf7) {
        let l = 0; do { b = d[p++]; l = (l << 7) | (b & 127); } while (b & 128);
        p += l;
      } else {
        const hi = st >> 4, ch = st & 15;
        const a = d[p++], c = hi === 0xc || hi === 0xd ? 0 : d[p++];
        if (hi === 0xc && !(ch in programs)) programs[ch] = a;
        if (hi === 9 && c > 0) { const key = `${ch}:${a}`; if (!open.has(key)) open.set(key, []); open.get(key).push({ s: tick, v: c }); }
        else if (hi === 8 || (hi === 9 && c === 0)) {
          const q = open.get(`${ch}:${a}`);
          if (q && q.length) { const n = q.shift(); notes.push({ s: Math.round(n.s * scale), l: Math.max(1, Math.round((tick - n.s) * scale)), k: a, v: n.v, ch }); }
        }
      }
    }
    for (const [key, q] of open) for (const n of q) notes.push({ s: Math.round(n.s * scale), l: PPQ / 4, k: +key.split(':')[1], v: n.v, ch: +key.split(':')[0] });   // unterminated notes: a step long
    p = end;
    notes.sort((a, b) => a.s - b.s || a.k - b.k);
    tracks.push({ name, notes, programs });
  }
  return { format, ppq: division, tempo: Math.round(tempo * 100) / 100, timeSig, tracks };
}

export { songLength };
