// MIDI file import: every MIDI track (and, in type-0 files, every MIDI channel) becomes a Channel rack channel with its
// own pattern and mixer insert; the patterns are laid out in the Playlist one per track, after anything already there.
// Melodic parts get an instrument picked from their General MIDI program, channel 10 gets an FPC with a GM drum kit.
import { MAX_INSERT } from './constants.js';
import { createChannel, createNote, createPattern, createClip, currentArrangement, barTicks, songLength } from './project.js';
import { defaultPads } from './instruments/fpc.js';
import { factoryId, FACTORY_BY_ID } from './factory.js';

// General MIDI drum notes -> factory sounds [sample, pitch, choke group]
const GM_DRUMS = {
  35: ['kick-deep'], 36: ['kick-punch'], 37: ['rim'], 38: ['snare-tight'], 39: ['clap'], 40: ['snare-fat'],
  41: ['tom-low', -2], 42: ['hat-closed', 0, 1], 43: ['tom-low'], 44: ['hat-pedal', 0, 1], 45: ['tom-mid', -1], 46: ['hat-open', 0, 1],
  47: ['tom-mid', 1], 48: ['tom-high', -1], 49: ['crash'], 50: ['tom-high', 1], 51: ['crash', -5], 52: ['crash', -2], 53: ['crash', -7],
  54: ['shaker', 2], 55: ['crash', 3], 56: ['cowbell'], 57: ['crash', 1], 59: ['crash', -4], 60: ['perc', 3], 61: ['perc'],
  62: ['perc', 5], 63: ['perc', 2], 64: ['perc', -2], 69: ['shaker', -1], 70: ['shaker', 1], 75: ['rim', 5], 76: ['perc', 7], 77: ['perc', 4],
};

export function gmDrumPads() {
  const pads = defaultPads();
  const notes = Object.keys(GM_DRUMS).map(Number);
  notes.forEach((note, i) => {
    const [id, pitch = 0, choke = 0] = GM_DRUMS[note], f = FACTORY_BY_ID.get(factoryId(id));
    Object.assign(pads[i], { name: f ? f.name : id, note, pitch, choke, layers: [{ sample: { id: factoryId(id), name: f ? f.name : id }, vol: 1, pan: 0, pitch: 0, start: 0 }] });
  });
  // the unused pads keep notes no drum part plays
  for (let i = notes.length; i < pads.length; i++) pads[i].note = 0;
  return pads;
}

// General MIDI program (0-127) -> an instrument of this app
export function instrumentFor(program) {
  if (program == null) return 'subsynth';
  const fam = Math.floor(program / 8);
  return ['fm', 'fm', 'organ', 'pluck', 'subsynth', 'wavetable', 'wavetable', 'subsynth', 'wavetable', 'wavetable', 'wavetable', 'wavetable', 'wavetable', 'pluck', 'fm', 'subsynth'][fam] || 'subsynth';
}

const GM_FAMILY = ['Piano', 'Chromatic perc', 'Organ', 'Guitar', 'Bass', 'Strings', 'Ensemble', 'Brass', 'Reed', 'Pipe', 'Synth lead', 'Synth pad', 'Synth FX', 'Ethnic', 'Percussive', 'Sound FX'];

// split the file into parts: one per track, or per MIDI channel inside a track that uses several
export function midiParts(midi) {
  const parts = [];
  midi.tracks.forEach((t, ti) => {
    const byCh = new Map();
    for (const n of t.notes) { if (!byCh.has(n.ch)) byCh.set(n.ch, []); byCh.get(n.ch).push(n); }
    for (const [ch, notes] of byCh) {
      const program = t.programs ? t.programs[ch] : undefined;
      const drums = ch === 9;
      const label = t.name || (drums ? 'Drums' : program != null ? GM_FAMILY[Math.floor(program / 8)] : `Track ${ti + 1}`);
      parts.push({ name: byCh.size > 1 && t.name ? `${t.name} ${ch + 1}` : label, ch, drums, program, notes });
    }
  });
  return parts;
}

// opts: { name, instrument: 'gm' | an instrument type, setTempo, at (ticks; default: after the song) }
// returns { channels, patterns, start, length }
export function importMidi(p, midi, opts = {}) {
  const parts = midiParts(midi);
  if (!parts.length) throw new Error('The MIDI file has no notes');
  if (opts.setTempo && midi.tempo > 10 && midi.tempo < 999) p.tempo = midi.tempo;
  if (opts.setTempo && midi.timeSig && midi.timeSig.num > 0) p.timeSig = { num: midi.timeSig.num, den: midi.timeSig.den };
  const arr = currentArrangement(p), bar = barTicks(p.timeSig);
  const start = opts.at ?? Math.ceil(songLength(p, arr) / bar) * bar;
  const usedTracks = arr.clips.map((c) => c.track);
  let track = Math.max(0, ...usedTracks) + 1;
  const usedInserts = new Set(p.channels.map((c) => c.mixer));
  let insert = 1;
  const nextInsert = () => { while (insert <= MAX_INSERT && usedInserts.has(insert)) insert++; return insert <= MAX_INSERT ? insert++ : 0; };
  const end = Math.max(...parts.map((pt) => Math.max(...pt.notes.map((n) => n.s + n.l))));
  const length = Math.max(bar, Math.ceil(end / bar) * bar);
  const channels = [], patterns = [];
  for (const part of parts) {
    const type = part.drums ? 'fpc' : opts.instrument && opts.instrument !== 'gm' ? opts.instrument : instrumentFor(part.program);
    const mixer = nextInsert();
    const ch = createChannel(p, type, { name: part.name.slice(0, 40), mixer, pads: part.drums ? gmDrumPads() : undefined });
    p.channels.push(ch);
    if (mixer) p.mixer.tracks[mixer].name = part.name.slice(0, 24);
    const pat = createPattern(p, 0, `${opts.name ? `${opts.name}: ` : ''}${part.name}`.slice(0, 60));
    pat.notes[ch.id] = part.notes.map((n) => createNote(p, n.s, n.l, n.k, Math.max(1, Math.min(127, n.v))));
    pat.len = length;
    arr.clips.push(createClip(p, 'pattern', track++, start, length, pat.id));
    channels.push(ch); patterns.push(pat);
  }
  arr.clips.sort((a, b) => a.s - b.s);
  p.currentPattern = patterns[0].id;
  return { channels, patterns, start, length };
}
