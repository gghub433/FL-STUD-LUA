// Shared memory layout between the engine (AudioWorklet, through a SharedArrayBuffer), the bridge in the page
// process (bridge/bridge.cc) and the plugin host process (host/). The same Frame structure is used in both the
// SharedArrayBuffer (a ring of RING frames) and the host's shared memory (one frame), so the bridge copies bytes.
// src/core/plugin-layout.js mirrors these numbers; bridge.layout() reports them so a mismatch is caught at start.
#pragma once
#include <cstddef>
#include <cstdint>

namespace fl {

constexpr uint32_t MAGIC = 0x464C5048;   // 'FLPH'
constexpr uint32_t VERSION = 1;
constexpr int SLOTS = 64;                 // plugin instances that can run at the same time
constexpr int MAX_FRAMES = 128;           // one engine block (AudioWorklet render quantum)
constexpr int MAX_EVENTS = 256;           // events per slot per block
constexpr int RING = 8;                   // blocks in flight between the engine and the host

enum EventType : uint16_t {
  EV_NOTE_ON = 1, EV_NOTE_OFF = 2, EV_CC = 3, EV_PITCH = 4, EV_CHAN_PRESSURE = 5, EV_POLY_PRESSURE = 6,
  EV_PARAM = 7,       // param = parameter id, value = normalized 0..1
  EV_ALL_OFF = 8,
  EV_RESET = 9,       // start from silence (an export): voices, tails and delay lines from before are dropped
};

struct Event {           // 24 bytes
  uint32_t offset;       // frame inside the block
  uint16_t type;
  uint8_t channel;       // MIDI channel 0..15
  uint8_t key;           // note / controller number
  int32_t noteId;        // -1 when unknown
  uint32_t param;
  double value;          // velocity 0..1, controller 0..1, pitch bend -1..1, parameter 0..1
};

struct Slot {
  uint32_t seq;          // block this slot was used in by the engine (0 = not used in this frame)
  uint32_t nEvents;
  uint32_t outSeq;       // block whose output is in out[] (set by the host / bridge)
  uint32_t status;       // host: 0 processed, 1 no plugin in this slot, 2 plugin busy
  Event events[MAX_EVENTS];
  float in[2][MAX_FRAMES];
  float out[2][MAX_FRAMES];
};

enum FrameFlags : uint32_t { FRAME_PLAYING = 1, FRAME_LOOP = 2, FRAME_OFFLINE = 4 };

struct Frame {
  uint32_t seq;          // block number
  uint32_t frames;       // frames in this block (<= MAX_FRAMES)
  uint32_t flags;
  uint32_t sampleRate;
  double tempo;          // BPM
  double ppq;            // song position at the block start, in quarter notes
  double samplePos;      // song position at the block start, in samples
  double barPpq;         // position of the last bar start, in quarter notes
  uint32_t tsNum, tsDen;
  double loopStartPpq, loopEndPpq;
  uint32_t pad[2];
  Slot slots[SLOTS];
};

// SharedArrayBuffer: SabHeader, then RING frames
struct SabHeader {       // 64 bytes
  uint32_t magic, version;
  uint32_t reqSeq;       // last block the engine finished writing (engine → bridge)
  uint32_t doneSeq;      // last block whose output is back (bridge → engine)
  uint32_t nextSeq;      // block numbers are taken from here (live engine and export share them)
  uint32_t hostState;    // 0 none, 1 running, 2 lost (crashed)
  uint32_t xruns;        // blocks the host was late for
  uint32_t latencyBlocks;
  uint32_t ring, slots, frameSize, layoutVersion;
  uint32_t pad[4];
};

// host shared memory: ShmHeader, then one Frame
struct ShmHeader {       // 64 bytes
  uint32_t magic, version;
  uint32_t reqSeq;       // bridge → host: a frame is ready (futex word)
  uint32_t doneSeq;      // host → bridge: the frame is processed (futex word)
  uint32_t hostAlive;
  uint32_t frameSize;
  uint32_t pad[10];
};

static_assert(sizeof(Event) == 24, "Event layout");
static_assert(sizeof(SabHeader) == 64 && sizeof(ShmHeader) == 64, "header layout");
static_assert(sizeof(Slot) == 16 + MAX_EVENTS * 24 + 4 * MAX_FRAMES * 4, "Slot layout");
static_assert(sizeof(Frame) % 8 == 0 && offsetof(Frame, slots) == 80, "Frame layout");

constexpr size_t SAB_SIZE = sizeof(SabHeader) + RING * sizeof(Frame);
constexpr size_t SHM_SIZE = sizeof(ShmHeader) + sizeof(Frame);

}  // namespace fl
