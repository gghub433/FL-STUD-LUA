// The SharedArrayBuffer shared with the desktop app's plugin bridge (VST3 / CLAP plugins in a separate host process).
// Mirrors desktop/native/common/layout.h; the bridge reports its numbers (bridge.layout()) and they must match.
//   SabHeader (64 bytes) | Frame × RING
//   Frame: 80-byte header (block number, transport) | Slot × SLOTS
//   Slot:  seq, nEvents, outSeq, status | events[MAX_EVENTS] (24 bytes each) | in[2][128] | out[2][128]
export const LAYOUT_VERSION = 1;
export const SLOTS = 64;
export const RING = 8;
export const MAX_FRAMES = 128;
export const MAX_EVENTS = 256;
export const EVENT_SIZE = 24;
export const HEADER_SIZE = 64;
export const FRAME_HEADER = 80;
export const SLOT_EVENTS = 16;
export const SLOT_IN = SLOT_EVENTS + MAX_EVENTS * EVENT_SIZE;      // 6160
export const SLOT_OUT = SLOT_IN + 2 * MAX_FRAMES * 4;              // 7184
export const SLOT_SIZE = SLOT_OUT + 2 * MAX_FRAMES * 4;            // 8208
export const FRAME_SIZE = FRAME_HEADER + SLOTS * SLOT_SIZE;        // 525392
export const SAB_SIZE = HEADER_SIZE + RING * FRAME_SIZE;

// header fields (Uint32 indices)
export const H = { magic: 0, version: 1, reqSeq: 2, doneSeq: 3, nextSeq: 4, hostState: 5, xruns: 6, latencyBlocks: 7 };
export const EV = { NOTE_ON: 1, NOTE_OFF: 2, CC: 3, PITCH: 4, CHAN_PRESSURE: 5, POLY_PRESSURE: 6, PARAM: 7, ALL_OFF: 8, RESET: 9 };
export const FLAG = { PLAYING: 1, LOOP: 2, OFFLINE: 4 };

export function matches(layout) {
  return !!layout && layout.version === LAYOUT_VERSION && layout.slots === SLOTS && layout.ring === RING && layout.maxFrames === MAX_FRAMES
    && layout.maxEvents === MAX_EVENTS && layout.sabSize === SAB_SIZE && layout.frameSize === FRAME_SIZE && layout.slotsOffset === FRAME_HEADER
    && layout.slotSize === SLOT_SIZE && layout.eventsOffset === SLOT_EVENTS && layout.inOffset === SLOT_IN && layout.outOffset === SLOT_OUT && layout.eventSize === EVENT_SIZE;
}

// typed views over the buffer; all offsets are multiples of 8
export function views(sab) {
  return {
    u8: new Uint8Array(sab), u16: new Uint16Array(sab), u32: new Uint32Array(sab), i32: new Int32Array(sab),
    f32: new Float32Array(sab), f64: new Float64Array(sab),
  };
}

export const frameOffset = (seq) => HEADER_SIZE + (seq % RING) * FRAME_SIZE;
export const slotOffset = (seq, slot) => frameOffset(seq) + FRAME_HEADER + slot * SLOT_SIZE;

// writes the block header: transport position for tempo-synced plugins
export function writeFrame(v, seq, frames, sampleRate, t) {
  const o = frameOffset(seq);
  const u = o >> 2, d = o >> 3;
  v.u32[u] = seq; v.u32[u + 1] = frames; v.u32[u + 2] = t.flags || 0; v.u32[u + 3] = sampleRate;
  v.f64[d + 2] = t.tempo || 120; v.f64[d + 3] = t.ppq || 0; v.f64[d + 4] = t.samplePos || 0; v.f64[d + 5] = t.barPpq || 0;
  v.u32[u + 12] = t.tsNum || 4; v.u32[u + 13] = t.tsDen || 4;
  v.f64[d + 7] = t.loopStart || 0; v.f64[d + 8] = t.loopEnd || 0;
}

// a slot used in block `seq`: resets its events (call before adding events or input)
export function beginSlot(v, seq, slot) {
  const o = slotOffset(seq, slot) >> 2;
  v.u32[o] = seq; v.u32[o + 1] = 0;
}

export function addEvent(v, seq, slot, offset, type, channel, key, noteId, param, value) {
  const so = slotOffset(seq, slot);
  const n = v.u32[(so >> 2) + 1];
  if (n >= MAX_EVENTS) return false;
  const e = so + SLOT_EVENTS + n * EVENT_SIZE;
  v.u32[e >> 2] = offset;
  v.u16[(e >> 1) + 2] = type;
  v.u8[e + 6] = channel; v.u8[e + 7] = key;
  v.i32[(e >> 2) + 2] = noteId; v.u32[(e >> 2) + 3] = param;
  v.f64[(e >> 3) + 2] = value;
  v.u32[(so >> 2) + 1] = n + 1;
  return true;
}

export const inIndex = (seq, slot, ch) => (slotOffset(seq, slot) + SLOT_IN + ch * MAX_FRAMES * 4) >> 2;     // Float32 index
export const outIndex = (seq, slot, ch) => (slotOffset(seq, slot) + SLOT_OUT + ch * MAX_FRAMES * 4) >> 2;
export const outSeqOf = (v, seq, slot) => Atomics.load(v.u32, (slotOffset(seq, slot) >> 2) + 2);
export const statusOf = (v, seq, slot) => v.u32[(slotOffset(seq, slot) >> 2) + 3];
