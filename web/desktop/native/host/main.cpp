// fllua-plughost: runs VST3 and CLAP plugins for FL LUA in a process of its own, so a plugin that crashes takes
// only this process down.
//   fllua-plughost --scan <file>          prints the plugins in one file as a JSON line and exits
//   fllua-plughost --serve <shm name>     creates the shared memory (common/layout.h) and reads commands as JSON lines
//                                         on stdin; answers and events are JSON lines on stdout
// Audio: the bridge in FL LUA's page process copies a block into the shared memory and rings `reqSeq`; the audio
// thread here processes every slot the engine used in that block and rings `doneSeq`.
#include <atomic>
#include <cstdio>
#include <cstring>
#include <iostream>
#include <map>
#include <memory>
#include <mutex>
#include <string>
#include <thread>

#include "../common/ipc.h"
#include "../common/layout.h"
#include "json.h"
#include "platform.h"
#include "plugin.h"

#ifdef _WIN32
#include <avrt.h>
#include <fcntl.h>
#include <io.h>
#else
#include <pthread.h>
#endif

namespace {

thread_local bool tAudio = false;
std::mutex outMu;

void emit(const json::Value& v) {
  std::string s = json::stringify(v);
  std::lock_guard<std::mutex> l(outMu);
  std::fwrite(s.data(), 1, s.size(), stdout);
  std::fputc('\n', stdout);
  std::fflush(stdout);
}

struct Instance {
  int id = 0;
  int slot = -1;
  std::unique_ptr<Plugin> plugin;
};

fl::SharedMemory shm;
fl::ShmHeader* hdr = nullptr;
fl::Frame* frame = nullptr;
fl::Doorbell reqBell, doneBell;
std::atomic<Plugin*> bySlot[fl::SLOTS];
std::mutex procMu;                     // held by the audio thread while it processes; the main thread takes it for lifecycle changes
std::map<int, std::unique_ptr<Instance>> instances;
int nextInst = 1;
double sampleRate = 48000;
std::atomic<bool> running{true};
std::thread audioThread;

void raisePriority() {
#ifdef _WIN32
  DWORD task = 0;
  AvSetMmThreadCharacteristicsW(L"Pro Audio", &task);
  SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_TIME_CRITICAL);
#elif defined(__APPLE__)
  pthread_set_qos_class_self_np(QOS_CLASS_USER_INTERACTIVE, 0);
#else
  sched_param sp{};
  sp.sched_priority = 10;
  pthread_setschedparam(pthread_self(), SCHED_FIFO, &sp);     // allowed only with rtprio; fine if refused
#endif
}

void audioLoop() {
  tAudio = true;
  raisePriority();
  uint32_t seen = reqBell.load();
  while (running.load()) {
    if (!reqBell.wait(seen, 100)) continue;
    uint32_t seq = reqBell.load();
    seen = seq;
    fl::Frame& f = *frame;
    {
      std::unique_lock<std::mutex> lk(procMu, std::try_to_lock);
      for (int s = 0; s < fl::SLOTS; s++) {
        fl::Slot& sl = f.slots[s];
        if (sl.seq != f.seq || f.seq == 0) continue;
        Plugin* p = bySlot[s].load(std::memory_order_acquire);
        if (p && lk.owns_lock()) { p->process(f, sl); sl.status = 0; }
        else { std::memset(sl.out, 0, sizeof sl.out); sl.status = p ? 2 : 1; }
        sl.outSeq = f.seq;
      }
    }
    doneBell.ring(seq);
  }
}

Instance* find(const json::Value& m) {
  auto it = instances.find((int)m["inst"].i64(-1));
  return it == instances.end() ? nullptr : it->second.get();
}

json::Value paramList(Plugin* p) {
  json::Value list = json::Value::array(), values = json::Value::object();
  for (auto& pi : p->params()) {
    list.push(pi.toJson());
    values.set(std::to_string(pi.id), p->paramValue(pi.id));
  }
  json::Value v = json::Value::object();
  v.set("params", list).set("values", values);
  return v;
}

void wire(Instance* in) {
  int id = in->id;
  Plugin* p = in->plugin.get();
  p->events.paramFromEditor = [id](uint32_t pid, double v) { json::Value e = json::Value::object(); e.set("ev", "param").set("inst", id).set("id", (double)pid).set("value", v); emit(e); };
  p->events.dirty = [id] { json::Value e = json::Value::object(); e.set("ev", "dirty").set("inst", id); emit(e); };
  p->events.paramsChanged = [id, p] { json::Value e = paramList(p); e.set("ev", "params").set("inst", id); emit(e); };
  p->events.latencyChanged = [id, p] { json::Value e = json::Value::object(); e.set("ev", "latency").set("inst", id).set("samples", (double)p->latency()); emit(e); };
  p->events.editorClosed = [id] { json::Value e = json::Value::object(); e.set("ev", "editorClosed").set("inst", id); emit(e); };
  p->events.log = [id](const std::string& m) { json::Value e = json::Value::object(); e.set("ev", "log").set("inst", id).set("msg", m); emit(e); };
}

// lifecycle changes wait for the audio thread to finish its block; it then skips (silence) until the change is done
struct Hold {
  std::unique_lock<std::mutex> lk;
  Hold() : lk(procMu) { setAudioThread(true); }
  ~Hold() { setAudioThread(false); }
};

json::Value handle(const json::Value& m) {
  std::string cmd = m["cmd"].str();
  json::Value r = json::Value::object();
  r.set("ok", true);
  if (cmd == "hello") {
    r.set("version", 1).set("slots", fl::SLOTS).set("frameSize", (double)sizeof(fl::Frame)).set("layout", fl::VERSION);
  } else if (cmd == "setRate") {
    sampleRate = m["sampleRate"].num(48000);
    Hold h;
    for (auto& kv : instances) { kv.second->plugin->deactivate(); kv.second->plugin->activate(sampleRate, fl::MAX_FRAMES); }
  } else if (cmd == "load") {
    int slot = (int)m["slot"].i64(-1);
    if (slot < 0 || slot >= fl::SLOTS || bySlot[slot].load()) { r.set("ok", false).set("error", "No free plugin slot"); return r; }
    std::string error, format = m["format"].str(), path = m["path"].str(), uid = m["uid"].str();
    if (m.has("sampleRate")) sampleRate = m["sampleRate"].num(sampleRate);
    std::unique_ptr<Plugin> p = format == "clap" ? loadClap(path, uid, error) : loadVst3(path, uid, error);
    if (!p) { r.set("ok", false).set("error", error.empty() ? "Could not load the plugin" : error); return r; }
    std::string state = json::unbase64(m["state"].str());
    if (!state.empty() && !p->loadState(state)) r.set("stateError", "The saved settings could not be restored");
    if (!p->activate(sampleRate, fl::MAX_FRAMES)) { r.set("ok", false).set("error", "The plugin could not start at " + std::to_string((int)sampleRate) + " Hz"); return r; }
    auto in = std::make_unique<Instance>();
    in->id = nextInst++;
    in->slot = slot;
    in->plugin = std::move(p);
    wire(in.get());
    Plugin* pp = in->plugin.get();
    json::Value pl = paramList(pp);
    r.set("inst", in->id).set("info", pp->info.toJson()).set("params", pl["params"]).set("values", pl["values"])
     .set("latency", (double)pp->latency()).set("hasEditor", pp->hasEditor()).set("hasInput", pp->hasInput).set("outChannels", pp->outChannels);
    bySlot[slot].store(pp, std::memory_order_release);
    instances[in->id] = std::move(in);
  } else if (cmd == "unload") {
    Instance* in = find(m);
    if (!in) return r;
    in->plugin->closeEditor();
    bySlot[in->slot].store(nullptr, std::memory_order_release);
    {
      Hold h;
      in->plugin->stopProcessing();
      in->plugin->deactivate();
    }
    instances.erase(in->id);
  } else if (cmd == "params") {
    Instance* in = find(m);
    if (!in) { r.set("ok", false).set("error", "No such plugin"); return r; }
    json::Value pl = paramList(in->plugin.get());
    r.set("params", pl["params"]).set("values", pl["values"]);
  } else if (cmd == "paramText") {
    Instance* in = find(m);
    if (!in) { r.set("ok", false); return r; }
    json::Value texts = json::Value::array();
    for (auto& q : m["items"].a) texts.push(in->plugin->paramText((uint32_t)q["id"].i64(), q["value"].num()));
    r.set("texts", texts);
  } else if (cmd == "setParam") {
    Instance* in = find(m);
    if (in) in->plugin->setParamFromHost((uint32_t)m["id"].i64(), m["value"].num());
  } else if (cmd == "getState") {
    Instance* in = find(m);
    std::string data;
    if (!in || !in->plugin->saveState(data)) { r.set("ok", false).set("error", "The plugin did not give its settings"); return r; }
    r.set("data", json::base64(data));
  } else if (cmd == "setState") {
    Instance* in = find(m);
    if (!in) { r.set("ok", false); return r; }
    bool ok;
    { Hold h; ok = in->plugin->loadState(json::unbase64(m["data"].str())); }
    r.set("ok", ok);
    json::Value pl = paramList(in->plugin.get());
    r.set("values", pl["values"]);
  } else if (cmd == "editor") {
    Instance* in = find(m);
    if (!in) { r.set("ok", false); return r; }
    if (m["show"].truthy()) {
      uint64_t owner = (uint64_t)m["owner"].num(0);
      r.set("ok", in->plugin->openEditor(m["title"].str(in->plugin->info.name), owner));
    } else in->plugin->closeEditor();
    r.set("open", in->plugin->editorOpen());
  } else if (cmd == "latency") {
    Instance* in = find(m);
    r.set("samples", in ? (double)in->plugin->latency() : 0.0);
  } else if (cmd == "quit") {
    plat::quit();
  } else {
    r.set("ok", false).set("error", "Unknown command " + cmd);
  }
  return r;
}

int scanMain(const std::string& path) {
  std::string error;
  std::vector<ClassInfo> list;
  std::string lower = path;
  for (auto& c : lower) c = (char)std::tolower((unsigned char)c);
  while (!lower.empty() && (lower.back() == '/' || lower.back() == '\\')) lower.pop_back();
  bool clap = lower.size() > 5 && lower.compare(lower.size() - 5, 5, ".clap") == 0;
  list = clap ? scanClap(path, error) : scanVst3(path, error);
  json::Value v = json::Value::object(), arr = json::Value::array();
  for (auto& c : list) arr.push(c.toJson());
  v.set("ok", !list.empty()).set("plugins", arr);
  if (list.empty()) v.set("error", error.empty() ? "No plugins found" : error);
  emit(v);
  std::fflush(stdout);
  std::_Exit(0);          // skip static destructors of plugins that misbehave on unload
}

}  // namespace

bool isAudioThread() { return tAudio; }
void setAudioThread(bool on) { tAudio = on; }

int main(int argc, char** argv) {
#ifdef _WIN32
  _setmode(_fileno(stdin), _O_BINARY);
  _setmode(_fileno(stdout), _O_BINARY);
  SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
#endif
  std::string mode = argc > 1 ? argv[1] : "";
  if (mode == "--version") { std::printf("fllua-plughost 1 layout %u\n", fl::VERSION); return 0; }
  plat::init();
  if (mode == "--scan" && argc > 2) return scanMain(argv[2]);
  if (mode != "--serve" || argc < 3) { std::fprintf(stderr, "usage: fllua-plughost --scan <file> | --serve <shm-name>\n"); return 2; }

  std::string name = argv[2];
  if (!shm.open(name, fl::SHM_SIZE, true)) { json::Value e = json::Value::object(); e.set("ev", "fatal").set("error", "Could not create shared memory " + name); emit(e); return 1; }
  hdr = static_cast<fl::ShmHeader*>(shm.data());
  frame = reinterpret_cast<fl::Frame*>(static_cast<char*>(shm.data()) + sizeof(fl::ShmHeader));
  hdr->magic = fl::MAGIC;
  hdr->version = fl::VERSION;
  hdr->frameSize = (uint32_t)sizeof(fl::Frame);
  hdr->hostAlive = 1;
  if (!reqBell.open(&hdr->reqSeq, name + "-req", true) || !doneBell.open(&hdr->doneSeq, name + "-done", true)) {
    json::Value e = json::Value::object(); e.set("ev", "fatal").set("error", "Could not create the doorbells"); emit(e); return 1;
  }
  for (auto& s : bySlot) s.store(nullptr);
  audioThread = std::thread(audioLoop);

  // commands arrive on stdin; each one runs on the main thread
  std::thread([] {
    std::string line;
    while (std::getline(std::cin, line)) {
      if (!line.empty() && line.back() == '\r') line.pop_back();
      if (line.empty()) continue;
      plat::post([line] {
        json::Value m;
        if (!json::parse(line, m)) { json::Value e = json::Value::object(); e.set("ev", "log").set("msg", "bad command"); emit(e); return; }
        json::Value r = handle(m);
        if (m.has("id")) { r.set("id", m["id"]); emit(r); }
      });
    }
    plat::post([] { plat::quit(); });          // FL LUA went away
  }).detach();

  plat::addTimer(33, [] { for (auto& kv : instances) kv.second->plugin->idle(); });
  json::Value ready = json::Value::object();
  ready.set("ev", "ready").set("shm", name).set("frameSize", (double)sizeof(fl::Frame)).set("layout", fl::VERSION);
  emit(ready);
  plat::run();

  // shut down: plugins first, then the audio thread
  for (auto& s : bySlot) s.store(nullptr);
  {
    std::lock_guard<std::mutex> l(procMu);
    setAudioThread(true);
    for (auto& kv : instances) { kv.second->plugin->closeEditor(); kv.second->plugin->stopProcessing(); kv.second->plugin->deactivate(); }
    setAudioThread(false);
  }
  instances.clear();
  running = false;
  reqBell.ring(reqBell.load());
  if (audioThread.joinable()) audioThread.join();
  hdr->hostAlive = 0;
  shm.close();
  std::fflush(stdout);
  std::_Exit(0);
}
