// fllua_bridge.node: loaded by the desktop app's preload script in the page process. It connects the engine's
// SharedArrayBuffer (written by the AudioWorklet, see src/core/plugin-link.js) with the plugin host's shared memory:
// a thread here watches the SharedArrayBuffer for new blocks, copies the slots the engine used into the host's frame,
// rings the host, waits for it, and copies the results back. Layout: ../common/layout.h.
#include <node_api.h>

#include <atomic>
#include <chrono>
#include <cstring>
#include <string>
#include <thread>

#include "../common/ipc.h"
#include "../common/layout.h"

namespace {

using fl::Frame;
using fl::Slot;

struct Bridge {
  fl::SharedMemory shm;
  fl::ShmHeader* hdr = nullptr;
  Frame* hostFrame = nullptr;
  fl::Doorbell req, done;
  uint8_t* sab = nullptr;
  napi_ref sabRef = nullptr;
  std::thread thread;
  std::atomic<bool> running{false};
  std::atomic<uint32_t> cycles{0}, timeouts{0}, lateBlocks{0};
  std::atomic<double> lastMs{0}, maxMs{0};

  fl::SabHeader* sabHeader() { return reinterpret_cast<fl::SabHeader*>(sab); }
  Frame* sabFrame(uint32_t seq) { return reinterpret_cast<Frame*>(sab + sizeof(fl::SabHeader) + (seq % fl::RING) * sizeof(Frame)); }
};

Bridge* gBridge = nullptr;

inline std::atomic<uint32_t>& at(uint32_t& v) { return fl::word(&v); }

void copyIn(Slot& dst, const Slot& src) {
  dst.seq = src.seq;
  uint32_t n = src.nEvents > (uint32_t)fl::MAX_EVENTS ? (uint32_t)fl::MAX_EVENTS : src.nEvents;
  dst.nEvents = n;
  dst.status = 0;
  if (n) std::memcpy(dst.events, src.events, n * sizeof(fl::Event));
  std::memcpy(dst.in, src.in, sizeof src.in);
}

void run(Bridge* b) {
  fl::SabHeader* sh = b->sabHeader();
  uint32_t last = at(sh->reqSeq).load(std::memory_order_acquire);
  int idle = 0;
  while (b->running.load()) {
    uint32_t req = at(sh->reqSeq).load(std::memory_order_acquire);
    if (req == last) {
      // the next block comes within a few milliseconds; look often, sleep a little longer when nothing happens
      fl::shortSleep(idle < 2000 ? 150 : 2000);
      idle++;
      continue;
    }
    idle = 0;
    // never more than RING - 2 blocks behind: older ones are dropped (the engine plays silence for them)
    uint32_t from = last + 1;
    if ((int32_t)(req - from) > fl::RING - 2) { b->lateBlocks += (req - from) - (fl::RING - 2); from = req - (fl::RING - 2); }
    for (uint32_t seq = from; (int32_t)(seq - req) <= 0 && b->running.load(); seq++) {
      Frame* src = b->sabFrame(seq);
      if (src->seq != seq) continue;
      auto t0 = std::chrono::steady_clock::now();
      Frame* dst = b->hostFrame;
      std::memcpy(dst, src, offsetof(Frame, slots));
      bool any = false;
      for (int s = 0; s < fl::SLOTS; s++) {
        if (src->slots[s].seq == seq) { copyIn(dst->slots[s], src->slots[s]); any = true; }
        else dst->slots[s].seq = 0;
      }
      if (any) {
        b->req.ring(seq);
        bool ok = true;
        auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(400);
        while (b->done.load() != seq) {
          if (std::chrono::steady_clock::now() > deadline || !b->hdr->hostAlive) { ok = false; break; }
          b->done.wait(b->done.load(), 20);
        }
        if (!ok) { b->timeouts++; at(sh->hostState).store(2, std::memory_order_release); }
        else {
          for (int s = 0; s < fl::SLOTS; s++) {
            if (src->slots[s].seq != seq) continue;
            Slot& o = src->slots[s];
            std::memcpy(o.out, dst->slots[s].out, sizeof o.out);
            o.status = dst->slots[s].status;
            at(o.outSeq).store(seq, std::memory_order_release);
          }
        }
      }
      double ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
      b->lastMs = ms;
      if (ms > b->maxMs.load()) b->maxMs = ms;
      b->cycles++;
      at(sh->doneSeq).store(seq, std::memory_order_release);
    }
    last = req;
  }
}

// ------------------------------------------------------------------------------------------------ N-API
napi_value num(napi_env env, double v) { napi_value r; napi_create_double(env, v, &r); return r; }
void setNum(napi_env env, napi_value o, const char* k, double v) { napi_set_named_property(env, o, k, num(env, v)); }
napi_value err(napi_env env, const std::string& m) {
  napi_value o, s;
  napi_create_object(env, &o);
  napi_get_boolean(env, false, &s);
  napi_set_named_property(env, o, "ok", s);
  napi_create_string_utf8(env, m.c_str(), m.size(), &s);
  napi_set_named_property(env, o, "error", s);
  return o;
}

void stop() {
  if (!gBridge) return;
  gBridge->running = false;
  if (gBridge->thread.joinable()) gBridge->thread.join();
}

// open(shmName, uint8ArrayOverTheSab)
napi_value Open(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  if (argc < 2) return err(env, "open(name, view)");
  char name[256];
  size_t len = 0;
  if (napi_get_value_string_utf8(env, argv[0], name, sizeof name, &len) != napi_ok) return err(env, "bad name");
  napi_typedarray_type type;
  size_t elems = 0, offset = 0;
  void* data = nullptr;
  napi_value ab;
  if (napi_get_typedarray_info(env, argv[1], &type, &elems, &data, &ab, &offset) != napi_ok || !data) return err(env, "bad buffer");
  if (type != napi_uint8_array || elems < fl::SAB_SIZE || offset != 0) return err(env, "the buffer must be a Uint8Array over the whole SharedArrayBuffer");
  stop();
  if (gBridge) { if (gBridge->sabRef) napi_delete_reference(env, gBridge->sabRef); delete gBridge; gBridge = nullptr; }
  auto* b = new Bridge();
  std::string n(name, len);
  if (!b->shm.open(n, fl::SHM_SIZE, false)) { delete b; return err(env, "Could not open the plugin host's shared memory"); }
  b->shm.unlinkName();
  b->hdr = static_cast<fl::ShmHeader*>(b->shm.data());
  if (b->hdr->magic != fl::MAGIC || b->hdr->version != fl::VERSION || b->hdr->frameSize != sizeof(Frame)) { delete b; return err(env, "The plugin host is a different version"); }
  b->hostFrame = reinterpret_cast<Frame*>(static_cast<char*>(b->shm.data()) + sizeof(fl::ShmHeader));
  if (!b->req.open(&b->hdr->reqSeq, n + "-req", false) || !b->done.open(&b->hdr->doneSeq, n + "-done", false)) { delete b; return err(env, "Could not open the plugin host's doorbells"); }
  b->sab = static_cast<uint8_t*>(data);
  napi_create_reference(env, argv[1], 1, &b->sabRef);
  fl::SabHeader* sh = b->sabHeader();
  sh->magic = fl::MAGIC;
  sh->version = fl::VERSION;
  sh->ring = fl::RING;
  sh->slots = fl::SLOTS;
  sh->frameSize = (uint32_t)sizeof(Frame);
  sh->layoutVersion = fl::VERSION;
  at(sh->hostState).store(1, std::memory_order_release);
  b->running = true;
  b->thread = std::thread(run, b);
  gBridge = b;
  napi_value o, t;
  napi_create_object(env, &o);
  napi_get_boolean(env, true, &t);
  napi_set_named_property(env, o, "ok", t);
  setNum(env, o, "frameSize", (double)sizeof(Frame));
  return o;
}

napi_value Close(napi_env env, napi_callback_info) {
  stop();
  if (gBridge) {
    if (gBridge->sab) at(gBridge->sabHeader()->hostState).store(0, std::memory_order_release);
    if (gBridge->sabRef) napi_delete_reference(env, gBridge->sabRef);
    delete gBridge;
    gBridge = nullptr;
  }
  return nullptr;
}

napi_value Layout(napi_env env, napi_callback_info) {
  napi_value o;
  napi_create_object(env, &o);
  setNum(env, o, "version", fl::VERSION);
  setNum(env, o, "slots", fl::SLOTS);
  setNum(env, o, "ring", fl::RING);
  setNum(env, o, "maxFrames", fl::MAX_FRAMES);
  setNum(env, o, "maxEvents", fl::MAX_EVENTS);
  setNum(env, o, "sabSize", (double)fl::SAB_SIZE);
  setNum(env, o, "headerSize", sizeof(fl::SabHeader));
  setNum(env, o, "frameSize", sizeof(Frame));
  setNum(env, o, "slotsOffset", offsetof(Frame, slots));
  setNum(env, o, "slotSize", sizeof(Slot));
  setNum(env, o, "eventsOffset", offsetof(Slot, events));
  setNum(env, o, "inOffset", offsetof(Slot, in));
  setNum(env, o, "outOffset", offsetof(Slot, out));
  setNum(env, o, "eventSize", sizeof(fl::Event));
  return o;
}

napi_value Stats(napi_env env, napi_callback_info) {
  napi_value o;
  napi_create_object(env, &o);
  if (gBridge) {
    setNum(env, o, "cycles", gBridge->cycles.load());
    setNum(env, o, "timeouts", gBridge->timeouts.load());
    setNum(env, o, "lateBlocks", gBridge->lateBlocks.load());
    setNum(env, o, "lastMs", gBridge->lastMs.load());
    setNum(env, o, "maxMs", gBridge->maxMs.load());
    gBridge->maxMs = 0;
  }
  return o;
}

napi_value Init(napi_env env, napi_value exports) {
  napi_property_descriptor props[] = {
      {"open", nullptr, Open, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"close", nullptr, Close, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"layout", nullptr, Layout, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"stats", nullptr, Stats, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  napi_define_properties(env, exports, sizeof props / sizeof props[0], props);
  return exports;
}

}  // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
