// Scale and chord tables (standard music theory; intervals in semitones from the root) and helpers
// shared by the piano roll highlighting, the chord tool/stamp and the riff generator.

export const SCALES = [
  { id: 'chromatic', name: 'Chromatic', iv: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] },
  { id: 'major', name: 'Major (Ionian)', iv: [0, 2, 4, 5, 7, 9, 11] },
  { id: 'minor', name: 'Natural minor (Aeolian)', iv: [0, 2, 3, 5, 7, 8, 10] },
  { id: 'harmonic-minor', name: 'Harmonic minor', iv: [0, 2, 3, 5, 7, 8, 11] },
  { id: 'melodic-minor', name: 'Melodic minor', iv: [0, 2, 3, 5, 7, 9, 11] },
  { id: 'dorian', name: 'Dorian', iv: [0, 2, 3, 5, 7, 9, 10] },
  { id: 'phrygian', name: 'Phrygian', iv: [0, 1, 3, 5, 7, 8, 10] },
  { id: 'lydian', name: 'Lydian', iv: [0, 2, 4, 6, 7, 9, 11] },
  { id: 'mixolydian', name: 'Mixolydian', iv: [0, 2, 4, 5, 7, 9, 10] },
  { id: 'locrian', name: 'Locrian', iv: [0, 1, 3, 5, 6, 8, 10] },
  { id: 'major-pentatonic', name: 'Major pentatonic', iv: [0, 2, 4, 7, 9] },
  { id: 'minor-pentatonic', name: 'Minor pentatonic', iv: [0, 3, 5, 7, 10] },
  { id: 'blues', name: 'Blues', iv: [0, 3, 5, 6, 7, 10] },
  { id: 'whole-tone', name: 'Whole tone', iv: [0, 2, 4, 6, 8, 10] },
  { id: 'dim-wh', name: 'Diminished (whole-half)', iv: [0, 2, 3, 5, 6, 8, 9, 11] },
  { id: 'dim-hw', name: 'Diminished (half-whole)', iv: [0, 1, 3, 4, 6, 7, 9, 10] },
  { id: 'phrygian-dominant', name: 'Phrygian dominant', iv: [0, 1, 4, 5, 7, 8, 10] },
  { id: 'double-harmonic', name: 'Double harmonic', iv: [0, 1, 4, 5, 7, 8, 11] },
  { id: 'hungarian-minor', name: 'Hungarian minor', iv: [0, 2, 3, 6, 7, 8, 11] },
  { id: 'hirajoshi', name: 'Hirajoshi', iv: [0, 2, 3, 7, 8] },
];
export const SCALE_BY_ID = new Map(SCALES.map((s) => [s.id, s]));

export const CHORDS = [
  { id: 'maj', name: 'Major', sym: '', iv: [0, 4, 7] },
  { id: 'min', name: 'Minor', sym: 'm', iv: [0, 3, 7] },
  { id: 'dim', name: 'Diminished', sym: 'dim', iv: [0, 3, 6] },
  { id: 'aug', name: 'Augmented', sym: 'aug', iv: [0, 4, 8] },
  { id: 'sus2', name: 'Suspended 2nd', sym: 'sus2', iv: [0, 2, 7] },
  { id: 'sus4', name: 'Suspended 4th', sym: 'sus4', iv: [0, 5, 7] },
  { id: '5', name: 'Power chord', sym: '5', iv: [0, 7] },
  { id: '6', name: 'Major 6th', sym: '6', iv: [0, 4, 7, 9] },
  { id: 'm6', name: 'Minor 6th', sym: 'm6', iv: [0, 3, 7, 9] },
  { id: '7', name: 'Dominant 7th', sym: '7', iv: [0, 4, 7, 10] },
  { id: 'maj7', name: 'Major 7th', sym: 'maj7', iv: [0, 4, 7, 11] },
  { id: 'm7', name: 'Minor 7th', sym: 'm7', iv: [0, 3, 7, 10] },
  { id: 'mmaj7', name: 'Minor major 7th', sym: 'mMaj7', iv: [0, 3, 7, 11] },
  { id: 'dim7', name: 'Diminished 7th', sym: 'dim7', iv: [0, 3, 6, 9] },
  { id: 'm7b5', name: 'Half-diminished', sym: 'm7b5', iv: [0, 3, 6, 10] },
  { id: '7sus4', name: 'Dominant 7 sus4', sym: '7sus4', iv: [0, 5, 7, 10] },
  { id: 'add9', name: 'Add 9', sym: 'add9', iv: [0, 4, 7, 14] },
  { id: 'madd9', name: 'Minor add 9', sym: 'm(add9)', iv: [0, 3, 7, 14] },
  { id: '9', name: 'Dominant 9th', sym: '9', iv: [0, 4, 7, 10, 14] },
  { id: 'maj9', name: 'Major 9th', sym: 'maj9', iv: [0, 4, 7, 11, 14] },
  { id: 'm9', name: 'Minor 9th', sym: 'm9', iv: [0, 3, 7, 10, 14] },
  { id: '11', name: 'Dominant 11th', sym: '11', iv: [0, 4, 7, 10, 14, 17] },
  { id: 'm11', name: 'Minor 11th', sym: 'm11', iv: [0, 3, 7, 10, 14, 17] },
  { id: '13', name: 'Dominant 13th', sym: '13', iv: [0, 4, 7, 10, 14, 21] },
];
export const CHORD_BY_ID = new Map(CHORDS.map((c) => [c.id, c]));

const mod12 = (n) => ((n % 12) + 12) % 12;

// pitch classes (0..11) of a scale built on `root` (0 = C)
export function scalePitchClasses(root, scaleId) {
  const s = SCALE_BY_ID.get(scaleId) || SCALE_BY_ID.get('major');
  return s.iv.map((i) => mod12(root + i));
}

export function inScale(key, root, scaleId) {
  const rel = mod12(key - root);
  return (SCALE_BY_ID.get(scaleId) || SCALE_BY_ID.get('major')).iv.includes(rel);
}

// nearest scale key to `key` (ties go down)
export function snapToScale(key, root, scaleId) {
  if (inScale(key, root, scaleId)) return key;
  for (let d = 1; d < 7; d++) {
    if (inScale(key - d, root, scaleId)) return key - d;
    if (inScale(key + d, root, scaleId)) return key + d;
  }
  return key;
}

// move `key` by `steps` scale degrees (negative = down); `key` is first snapped into the scale
export function scaleStep(key, steps, root, scaleId) {
  let k = snapToScale(key, root, scaleId);
  const dir = steps < 0 ? -1 : 1;
  for (let i = 0; i < Math.abs(steps); i++) {
    do { k += dir; } while (!inScale(k, root, scaleId) && k > -24 && k < 160);
  }
  return k;
}

// Chord keys: root key + intervals, then inversion (rotate the lowest note up an octave per step;
// negative inversions drop the top note an octave) and an optional octave doubling of the root.
export function chordKeys(rootKey, chordId, { inversion = 0, spread = false, bass = false } = {}) {
  const c = CHORD_BY_ID.get(chordId) || CHORD_BY_ID.get('maj');
  let ks = c.iv.map((i) => rootKey + i);
  for (let n = 0; n < inversion; n++) { const k = ks.shift(); ks.push(k + 12); }
  for (let n = 0; n > inversion; n--) { const k = ks.pop(); ks.unshift(k - 12); }
  if (spread && ks.length > 2) ks = ks.map((k, i) => (i % 2 === 1 ? k + 12 : k)).sort((a, b) => a - b);
  if (bass) ks.unshift(Math.min(...ks) - 12);
  return ks;
}

// Diatonic chord on a scale degree (0-based): stacked thirds taken from the scale itself.
// `octaveKey` is the key of C in the octave the tonic sits in (60 = C5).
export function diatonicChord(root, scaleId, degree, size = 3, octaveKey = 60) {
  const s = SCALE_BY_ID.get(scaleId) || SCALE_BY_ID.get('major');
  const n = s.iv.length;
  const out = [];
  for (let i = 0; i < size; i++) {
    const idx = degree + i * 2;
    const oct = Math.floor(idx / n);
    out.push(octaveKey + root + s.iv[((idx % n) + n) % n] + oct * 12);
  }
  return out;
}

// Name a set of keys if it matches a known chord on some root (returns e.g. "Cm7") else null.
export function identifyChord(keys) {
  const pcs = [...new Set(keys.map(mod12))].sort((a, b) => a - b);
  if (pcs.length < 2) return null;
  const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const bass = mod12(Math.min(...keys));
  let found = null;
  for (const root of pcs) {
    const rel = pcs.map((p) => mod12(p - root)).sort((a, b) => a - b);
    for (const c of CHORDS) {
      const civ = [...new Set(c.iv.map(mod12))].sort((a, b) => a - b);
      if (civ.length === rel.length && civ.every((v, i) => v === rel[i])) {
        const name = NAMES[root] + c.sym + (root !== bass ? `/${NAMES[bass]}` : '');
        if (!found || root === bass) found = name;
      }
    }
  }
  return found;
}
