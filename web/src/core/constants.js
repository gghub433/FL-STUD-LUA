// Shared constants. Everything in src/core is pure JS (no DOM, no Web Audio) so the
// same code runs inside the AudioWorklet, in a render Worker and under Node tests.

export const PPQ = 96;             // ticks per beat (quarter note)
export const BEAT = PPQ;
export const STEP = PPQ / 4;       // ticks per 1/16 note (one step in the step sequencer)
export const BLOCK = 128;          // engine block size = AudioWorklet quantum

export const MAX_INSERT = 125;     // mixer inserts 1..125, track 0 = master
export const FX_SLOTS = 10;
export const KEY_MAX = 120;        // piano roll range C0..C10 (key 60 = C5, FL naming)
export const MIDDLE_C = 60;
export const PLAYLIST_TRACKS = 500;
export const MAX_PATTERNS = 999;

export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

export function keyName(k) {
  return NOTE_NAMES[((k % 12) + 12) % 12] + Math.floor(k / 12);
}

export function isBlackKey(k) {
  const n = ((k % 12) + 12) % 12;
  return n === 1 || n === 3 || n === 6 || n === 8 || n === 10;
}

// Snap values in ticks (PPQ 96 keeps every FL snap value an integer).
export const SNAP = {
  none: 1, sixthStep: 4, quarterStep: 6, thirdStep: 8, halfStep: 12, step: 24,
  sixthBeat: 16, quarterBeat: 24, thirdBeat: 32, halfBeat: 48, beat: 96, bar: 384,
};
