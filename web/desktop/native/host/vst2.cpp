// VST 2.x plugins through the binary interface described in common/vst2abi.h: the plugin's entry function, its
// dispatcher, the host callback (time info, automation from the editor, window size, I/O changes), MIDI events,
// processReplacing, state as a chunk (or the parameter values), shell files that hold several plugins, and the editor
// in a host window. VST2 has no sample-accurate parameters: changes apply at the start of the block.
#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstring>
#include <map>
#include <memory>
#include <vector>

#include "../common/vst2abi.h"
#include "module.h"
#include "platform.h"
#include "plugin.h"
#include "util.h"

namespace {

using namespace vst2;

struct Vst2Module {
  mod::Library lib;
  Entry entry = nullptr;
  std::string path;
};
std::map<std::string, std::shared_ptr<Vst2Module>> gModules;

class Vst2Plugin;
thread_local Vst2Plugin* tCreating = nullptr;       // the instance whose entry call is running (it has no AEffect yet)
thread_local int32_t tShellId = 0;                  // the plugin a shell file should create (audioMasterCurrentId)

constexpr int kMaxChannels = 32;
constexpr int kMaxEvents = 512;

bool is32bit(const std::string& error) {
  return error.find("error 193") != std::string::npos || error.find("ELFCLASS32") != std::string::npos || error.find("wrong ELF class") != std::string::npos
      || error.find("incompatible architecture") != std::string::npos;
}

#ifdef _WIN32
// a folder of VST2 plugins also holds the DLLs they use: look at the exports without running the DLL's code
bool exportsEntry(const std::string& path) {
  HMODULE h = LoadLibraryExW(mod::wide(path).c_str(), nullptr, DONT_RESOLVE_DLL_REFERENCES);
  if (!h) return true;                               // the real load says why
  bool yes = GetProcAddress(h, "VSTPluginMain") || GetProcAddress(h, "main");
  FreeLibrary(h);
  return yes;
}
#elif !defined(__APPLE__)
// the same on Linux: a lazy load needs no other library to be complete just to look at the symbols
bool exportsEntry(const std::string& path) {
  void* h = dlopen(path.c_str(), RTLD_LAZY | RTLD_LOCAL);
  if (!h) return true;
  bool yes = dlsym(h, "VSTPluginMain") || dlsym(h, "main");
  dlclose(h);
  return yes;
}
#endif

// a .vst bundle on macOS; elsewhere the library itself or (some Linux plugins) a <name>.vst folder holding <name>.so
std::string binaryPath(const std::string& path) {
#ifndef __APPLE__
  if (mod::isDir(path)) {
    std::string inner = path + (path.back() == '/' || path.back() == '\\' ? "" : "/") + mod::stem(path);
#ifdef _WIN32
    inner += ".dll";
#else
    inner += ".so";
#endif
    if (mod::exists(inner)) return inner;
  }
#endif
  return path;
}

std::shared_ptr<Vst2Module> openModule(const std::string& path, std::string& error, bool* notPlugin = nullptr) {
  auto it = gModules.find(path);
  if (it != gModules.end()) return it->second;
  std::string bin = binaryPath(path);
#ifndef __APPLE__
  if (!exportsEntry(bin)) { if (notPlugin) *notPlugin = true; error = "Not a VST2 plugin"; return nullptr; }
#endif
  auto m = std::make_shared<Vst2Module>();
  m->path = path;
  if (!m->lib.open(bin, error)) {
    if (is32bit(error)) error = "A 32-bit plugin: FL LUA runs 64-bit plugins only";
    return nullptr;
  }
  void* e = m->lib.symbol("VSTPluginMain");
  if (!e) e = m->lib.symbol("main");
#ifdef __APPLE__
  if (!e) e = m->lib.symbol("main_macho");
#endif
  if (!e) { if (notPlugin) *notPlugin = true; error = "Not a VST2 plugin (no VSTPluginMain)"; return nullptr; }
  m->entry = reinterpret_cast<Entry>(e);
  gModules[path] = m;
  return m;
}

const char* categoryName(intptr_t c) {
  switch (c) {
    case kPlugCategEffect: return "Fx";
    case kPlugCategSynth: return "Instrument|Synth";
    case kPlugCategAnalysis: return "Fx|Analyzer";
    case kPlugCategMastering: return "Fx|Mastering";
    case kPlugCategSpacializer: return "Fx|Spatial";
    case kPlugCategRoomFx: return "Fx|Reverb";
    case kPlugSurroundFx: return "Fx|Surround";
    case kPlugCategRestoration: return "Fx|Restoration";
    case kPlugCategGenerator: return "Instrument|Generator";
    default: return "";
  }
}

intptr_t VST2_CALL hostCallback(AEffect* e, int32_t op, int32_t index, intptr_t value, void* ptr, float opt);

class Vst2Plugin : public Plugin {
 public:
  ~Vst2Plugin() override {
    closeEditor();
    deactivate();
    if (e_) { e_->dispatcher(e_, effClose, 0, 0, nullptr, 0); e_ = nullptr; }
  }

  bool init(std::shared_ptr<Vst2Module> m, int32_t shellId, std::string& error) {
    module_ = m;
    tCreating = this;
    tShellId = shellId;
    AEffect* e = m->entry(&hostCallback);
    tCreating = nullptr;
    tShellId = 0;
    if (!e || e->magic != kMagic) { error = "Not a VST2 plugin (it did not create a plugin)"; return false; }
    e_ = e;
    e_->resvd1 = reinterpret_cast<intptr_t>(this);
    dispatch(effOpen);
    info.format = "vst2";
    info.path = m->path;
    info.uid = std::to_string(e_->uniqueID);
    info.name = str(effGetEffectName);
    if (info.name.empty()) info.name = str(effGetProductString);
    if (info.name.empty()) info.name = mod::stem(m->path);
    info.vendor = str(effGetVendorString);
    intptr_t ver = dispatch(effGetVendorVersion);
    info.version = ver > 0 ? std::to_string(ver) : "";
    category_ = dispatch(effGetPlugCategory);
    info.instrument = (e_->flags & effFlagsIsSynth) != 0 || category_ == kPlugCategSynth || category_ == kPlugCategGenerator;
    info.category = categoryName(category_);
    hasInput = e_->numInputs > 0;
    outChannels = std::min(2, std::max(0, e_->numOutputs));
    // VST2 has no default values: what the plugin starts with is its default
    for (int i = 0; i < e_->numParams; i++) defaults_.push_back(e_->getParameter(e_, i));
    for (int c = 0; c < kMaxChannels; c++) { ins_[c] = &inBuf_[c * fl::MAX_FRAMES]; outs_[c] = &outBuf_[c * fl::MAX_FRAMES]; }
    for (int i = 0; i < kMaxEvents; i++) events_.events[i] = reinterpret_cast<VstEvent*>(&midi_[i]);
    return true;
  }

  intptr_t category() const { return category_; }
  intptr_t dispatch(int32_t op, int32_t index = 0, intptr_t value = 0, void* ptr = nullptr, float opt = 0) {
    return e_ ? e_->dispatcher(e_, op, index, value, ptr, opt) : 0;
  }
  std::string str(int32_t op, int32_t index = 0) {
    char buf[512] = {0};
    dispatch(op, index, 0, buf);
    buf[sizeof buf - 1] = 0;
    std::string s = buf;
    while (!s.empty() && (s.back() == ' ' || s.back() == '\t')) s.pop_back();
    return s;
  }

  // ------------------------------------------------------------------ host callback
  intptr_t hostCall(int32_t op, int32_t index, intptr_t value, void* ptr, float opt) {
    switch (op) {
      case audioMasterAutomate:                       // a knob turned in the plugin's window (or by the plugin itself)
        toMain_.push({(uint32_t)index, (double)opt});
        dirty_ = true;
        return 0;
      case audioMasterVersion: return 2400;
      case audioMasterCurrentId: return tShellId;
      case audioMasterGetTime: return reinterpret_cast<intptr_t>(&time_);
      case audioMasterIOChanged: latencyChanged_ = true; return 1;
      case audioMasterSizeWindow:
        reqW_ = index; reqH_ = (int)value; resize_ = true;
        if (plat::isMainThread()) applyResize();
        return 1;
      case audioMasterGetSampleRate: return (intptr_t)sr_;
      case audioMasterGetBlockSize: return fl::MAX_FRAMES;
      case audioMasterGetInputLatency: case audioMasterGetOutputLatency: return 0;
      case audioMasterGetCurrentProcessLevel: return isAudioThread() ? (offline_ ? kVstProcessLevelOffline : kVstProcessLevelRealtime) : kVstProcessLevelUser;
      case audioMasterGetAutomationState: return 4;   // read and write
      case audioMasterGetVendorString: case audioMasterGetProductString:
        if (ptr) std::strcpy(static_cast<char*>(ptr), "FL LUA");
        return 1;
      case audioMasterGetVendorVersion: return 700;
      case audioMasterCanDo: {
        const char* s = static_cast<const char*>(ptr);
        if (!s) return 0;
        for (const char* yes : {"sendVstEvents", "sendVstMidiEvent", "sendVstTimeInfo", "sizeWindow", "startStopProcess", "supportShell", "shellCategory"})
          if (!std::strcmp(s, yes)) return 1;
        return 0;
      }
      case audioMasterGetLanguage: return 1;
      case audioMasterUpdateDisplay: paramsChanged_ = true; dirty_ = true; return 1;
      case audioMasterBeginEdit: return 1;
      case audioMasterEndEdit: dirty_ = true; return 1;
      default: return 0;
    }
  }

  // ------------------------------------------------------------------ lifecycle
  bool activate(double sr, int maxFrames) override {
    if (active_) deactivate();
    sr_ = sr;
    dispatch(effSetSampleRate, 0, 0, nullptr, (float)sr);
    dispatch(effSetBlockSize, 0, maxFrames);
    dispatch(effSetProcessPrecision, 0, 0);          // 32-bit float
    dispatch(effMainsChanged, 0, 1);
    active_ = true;
    return true;
  }
  void deactivate() override {
    if (!active_) return;
    stopProcessing();
    dispatch(effMainsChanged, 0, 0);
    active_ = false;
  }
  void stopProcessing() override {
    if (processing_) { dispatch(effStopProcess); processing_ = false; }
  }

  // ------------------------------------------------------------------ parameters
  std::vector<ParamInfo> params() override {
    std::vector<ParamInfo> out;
    if (!e_) return out;
    for (int i = 0; i < e_->numParams; i++) {
      ParamInfo p;
      p.id = (uint32_t)i;
      p.name = str(effGetParamName, i);
      VstParameterProperties pp{};
      if (dispatch(effGetParameterProperties, i, 0, &pp) == 1) {
        std::string label = trimNul(pp.label, sizeof pp.label);
        if (label.size() > p.name.size()) p.name = label;
        if (pp.flags & kVstParameterIsSwitch) p.steps = 1;
        else if ((pp.flags & kVstParameterUsesIntegerMinMax) && pp.maxInteger > pp.minInteger && pp.maxInteger - pp.minInteger <= 1000) p.steps = pp.maxInteger - pp.minInteger;
        if (pp.flags & kVstParameterSupportsDisplayCategory) p.group = trimNul(pp.categoryLabel, sizeof pp.categoryLabel);
      }
      if (p.name.empty()) p.name = "Param " + std::to_string(i + 1);
      p.unit = str(effGetParamLabel, i);
      p.def = i < (int)defaults_.size() ? defaults_[(size_t)i] : 0;
      out.push_back(p);
    }
    return out;
  }
  double paramValue(uint32_t id) override { return e_ && (int)id < e_->numParams ? e_->getParameter(e_, (int32_t)id) : 0; }
  // VST2 only describes the value a parameter has now
  std::string paramText(uint32_t id, double norm) override {
    if (!e_ || (int)id >= e_->numParams || std::fabs(e_->getParameter(e_, (int32_t)id) - norm) > 1e-4) return "";
    std::string t = str(effGetParamDisplay, (int32_t)id), u = str(effGetParamLabel, (int32_t)id);
    size_t a = t.find_first_not_of(' ');
    t = a == std::string::npos ? "" : t.substr(a);
    return u.empty() || t.empty() ? t : t + " " + u;
  }
  void setParamFromHost(uint32_t, double) override {}      // the editor reads the values itself

  // ------------------------------------------------------------------ state: "FLV2" + 'C' (chunk) or 'P' (values)
  bool saveState(std::string& out) override {
    if (!e_) return false;
    int32_t prog = (int32_t)dispatch(effGetProgram);
    out = "FLV2";
    if (e_->flags & effFlagsProgramChunks) {
      void* data = nullptr;
      intptr_t n = dispatch(effGetChunk, 0, 0, &data);
      if (n > 0 && data) {
        out += 'C';
        out.append(reinterpret_cast<const char*>(&prog), 4);
        out.append(static_cast<const char*>(data), (size_t)n);
        return true;
      }
    }
    out += 'P';
    out.append(reinterpret_cast<const char*>(&prog), 4);
    int32_t n = e_->numParams;
    out.append(reinterpret_cast<const char*>(&n), 4);
    for (int32_t i = 0; i < n; i++) { float v = e_->getParameter(e_, i); out.append(reinterpret_cast<const char*>(&v), 4); }
    return true;
  }
  bool loadState(const std::string& d) override {
    if (!e_ || d.size() < 9 || d.compare(0, 4, "FLV2") != 0) return false;
    int32_t prog;
    std::memcpy(&prog, d.data() + 5, 4);
    if (d[4] == 'C') {
      chunk_.assign(d.begin() + 9, d.end());       // some plugins keep the pointer until the next call
      dispatch(effBeginSetProgram);
      intptr_t r = dispatch(effSetChunk, 0, (intptr_t)chunk_.size(), chunk_.data());
      dispatch(effEndSetProgram);
      (void)r;                                      // many plugins return 0 even when they took it
      return true;
    }
    if (d[4] != 'P' || d.size() < 13) return false;
    if (prog >= 0 && prog < e_->numPrograms) dispatch(effSetProgram, 0, prog);
    int32_t n;
    std::memcpy(&n, d.data() + 9, 4);
    for (int32_t i = 0; i < n && i < e_->numParams && 13 + (size_t)i * 4 + 4 <= d.size(); i++) {
      float v;
      std::memcpy(&v, d.data() + 13 + (size_t)i * 4, 4);
      e_->setParameter(e_, i, v);
    }
    return true;
  }
  uint32_t latency() override { return e_ ? (uint32_t)std::max(0, e_->initialDelay) : 0; }

  // ------------------------------------------------------------------ editor
  bool hasEditor() override { return e_ && (e_->flags & effFlagsHasEditor) != 0; }
  bool openEditor(const std::string& title, uint64_t owner) override {
    if (editorOpen_) { if (win_) plat::show(win_); return true; }
    if (!hasEditor()) return false;
    int w = 400, h = 300;
    rectSize(w, h);
    win_ = plat::createWindow(title, w, h, false, owner, {[this] { closeEditor(); if (events.editorClosed) events.editorClosed(); }, nullptr});
    if (!win_) return false;
    dispatch(effEditOpen, 0, 0, plat::nativeHandle(win_));      // the return value is not reliable
    editorOpen_ = true;
    int w2 = w, h2 = h;
    if (rectSize(w2, h2) && (w2 != w || h2 != h)) plat::setContentSize(win_, w2, h2);
    plat::show(win_);
    return true;
  }
  void closeEditor() override {
    if (editorOpen_) { dispatch(effEditClose); editorOpen_ = false; }
    if (win_) { plat::destroyWindow(win_); win_ = nullptr; }
  }
  bool editorOpen() override { return editorOpen_; }
  bool rectSize(int& w, int& h) {
    ERect* r = nullptr;
    dispatch(effEditGetRect, 0, 0, &r);
    if (!r || r->right - r->left <= 0 || r->bottom - r->top <= 0) return false;
    w = r->right - r->left;
    h = r->bottom - r->top;
    return true;
  }
  void applyResize() {
    if (!resize_.exchange(false) || !win_) return;
    if (reqW_ > 0 && reqH_ > 0) plat::setContentSize(win_, reqW_, reqH_);
  }

  void idle() override {
    // knobs turned in the plugin's window go to FL LUA
    ParamMsg m;
    std::map<uint32_t, double> last;
    while (toMain_.pop(m)) last[m.id] = m.value;
    for (auto& kv : last) if (events.paramFromEditor) events.paramFromEditor(kv.first, kv.second);
    if (editorOpen_) dispatch(effEditIdle);
    applyResize();
    if (latencyChanged_.exchange(false) && events.latencyChanged) events.latencyChanged();
    // program changes and the like: tell FL LUA at most twice a second
    auto now = std::chrono::steady_clock::now();
    if (paramsChanged_ && now - lastParams_ > std::chrono::milliseconds(500)) {
      paramsChanged_ = false;
      lastParams_ = now;
      if (events.paramsChanged) events.paramsChanged();
    }
    if (dirty_.exchange(false) && events.dirty) events.dirty();
  }

  // ------------------------------------------------------------------ audio
  void process(const fl::Frame& f, fl::Slot& s) override {
    uint32_t frames = std::min<uint32_t>(f.frames, fl::MAX_FRAMES);
    if (!active_ || !e_) { std::memset(s.out, 0, sizeof s.out); return; }
    if (!processing_) { dispatch(effStartProcess); processing_ = true; }
    offline_ = (f.flags & fl::FRAME_OFFLINE) != 0;
    fillTime(f);
    int n = 0;
    auto midi = [&](uint32_t t, uint8_t st, uint8_t d1, uint8_t d2) {
      if (n >= kMaxEvents) return;
      VstMidiEvent& ev = midi_[n++];
      std::memset(&ev, 0, sizeof ev);
      ev.type = kVstMidiType;
      ev.byteSize = (int32_t)sizeof ev;
      ev.deltaFrames = (int32_t)t;
      ev.flags = kVstMidiEventIsRealtime;
      ev.midiData[0] = (char)st; ev.midiData[1] = (char)d1; ev.midiData[2] = (char)d2;
    };
    for (uint32_t i = 0; i < s.nEvents && i < (uint32_t)fl::MAX_EVENTS; i++) {
      const fl::Event& e = s.events[i];
      uint32_t t = std::min<uint32_t>(e.offset, frames ? frames - 1 : 0);
      uint8_t ch = e.channel & 15, key = e.key & 127;
      auto v7 = [](double v) { return (uint8_t)std::lround(std::clamp(v, 0.0, 1.0) * 127); };
      switch (e.type) {
        case fl::EV_NOTE_ON: midi(t, 0x90 | ch, key, (uint8_t)std::max(1, (int)v7(e.value))); held_[ch][key] = true; break;
        case fl::EV_NOTE_OFF: midi(t, 0x80 | ch, key, v7(e.value)); held_[ch][key] = false; break;
        case fl::EV_CC: midi(t, 0xB0 | ch, key, v7(e.value)); break;
        case fl::EV_PITCH: { int v = std::clamp((int)std::lround((std::clamp(e.value, -1.0, 1.0) + 1) * 8191.5), 0, 16383); midi(t, 0xE0 | ch, (uint8_t)(v & 127), (uint8_t)(v >> 7)); break; }
        case fl::EV_CHAN_PRESSURE: midi(t, 0xD0 | ch, v7(e.value), 0); break;
        case fl::EV_POLY_PRESSURE: midi(t, 0xA0 | ch, key, v7(e.value)); break;
        case fl::EV_PARAM: if ((int)e.param < e_->numParams) e_->setParameter(e_, (int32_t)e.param, (float)std::clamp(e.value, 0.0, 1.0)); break;
        case fl::EV_RESET:                          // an export starts: suspend and resume clears voices and tails
          std::memset(held_, 0, sizeof held_);
          n = 0;
          dispatch(effStopProcess);
          dispatch(effMainsChanged, 0, 0);
          dispatch(effMainsChanged, 0, 1);
          dispatch(effStartProcess);
          break;
        case fl::EV_ALL_OFF:
          for (int c = 0; c < 16; c++)
            for (int k = 0; k < 128; k++)
              if (held_[c][k]) { held_[c][k] = false; midi(t, (uint8_t)(0x80 | c), (uint8_t)k, 0); }
          break;
      }
    }
    if (n) {
      events_.numEvents = n;
      events_.reserved = 0;
      dispatch(effProcessEvents, 0, 0, &events_);
    }
    int ni = std::clamp(e_->numInputs, 0, kMaxChannels), no = std::clamp(e_->numOutputs, 0, kMaxChannels);
    for (int c = 0; c < ni; c++) {
      if (c < 2) std::memcpy(ins_[c], s.in[c], frames * sizeof(float));
      else std::memset(ins_[c], 0, frames * sizeof(float));
    }
    for (int c = 0; c < no; c++) std::memset(outs_[c], 0, frames * sizeof(float));
    if ((e_->flags & effFlagsCanReplacing) && e_->processReplacing) e_->processReplacing(e_, ins_, outs_, (int32_t)frames);
    else if (e_->process) e_->process(e_, ins_, outs_, (int32_t)frames);
    if (no > 0) {
      std::memcpy(s.out[0], outs_[0], frames * sizeof(float));
      std::memcpy(s.out[1], outs_[no > 1 ? 1 : 0], frames * sizeof(float));
    } else std::memset(s.out, 0, sizeof s.out);
  }

  void fillTime(const fl::Frame& f) {
    bool playing = (f.flags & fl::FRAME_PLAYING) != 0;
    VstTimeInfo& t = time_;
    t.samplePos = f.samplePos;
    t.sampleRate = sr_;
    t.nanoSeconds = (double)std::chrono::duration_cast<std::chrono::nanoseconds>(std::chrono::steady_clock::now().time_since_epoch()).count();
    t.ppqPos = f.ppq;
    t.tempo = f.tempo > 0 ? f.tempo : 120;
    t.barStartPos = f.barPpq;
    t.cycleStartPos = f.loopStartPpq;
    t.cycleEndPos = f.loopEndPpq;
    t.timeSigNumerator = (int32_t)(f.tsNum ? f.tsNum : 4);
    t.timeSigDenominator = (int32_t)(f.tsDen ? f.tsDen : 4);
    t.smpteOffset = 0; t.smpteFrameRate = 0; t.samplesToNextClock = 0;
    t.flags = kVstNanosValid | kVstPpqPosValid | kVstTempoValid | kVstBarsValid | kVstCyclePosValid | kVstTimeSigValid;
    if (playing) t.flags |= kVstTransportPlaying;
    if (f.flags & fl::FRAME_LOOP) t.flags |= kVstTransportCycleActive;
    if (playing != wasPlaying_) t.flags |= kVstTransportChanged;
    wasPlaying_ = playing;
  }

 private:
  std::shared_ptr<Vst2Module> module_;
  AEffect* e_ = nullptr;
  intptr_t category_ = 0;
  std::vector<float> defaults_;
  std::vector<char> chunk_;
  float inBuf_[kMaxChannels * fl::MAX_FRAMES] = {};
  float outBuf_[kMaxChannels * fl::MAX_FRAMES] = {};
  float* ins_[kMaxChannels] = {};
  float* outs_[kMaxChannels] = {};
  VstMidiEvent midi_[kMaxEvents] = {};
  VstEventsN<kMaxEvents> events_{};
  VstTimeInfo time_{};
  SpscQueue<ParamMsg, 4096> toMain_;
  std::atomic<bool> dirty_{false}, paramsChanged_{false}, latencyChanged_{false}, resize_{false};
  std::atomic<int> reqW_{0}, reqH_{0};
  std::chrono::steady_clock::time_point lastParams_{};
  bool held_[16][128] = {};
  double sr_ = 48000;
  bool active_ = false, processing_ = false, editorOpen_ = false, offline_ = false, wasPlaying_ = false;
  plat::Window* win_ = nullptr;
};

intptr_t VST2_CALL hostCallback(AEffect* e, int32_t op, int32_t index, intptr_t value, void* ptr, float opt) {
  Vst2Plugin* p = e && e->resvd1 ? reinterpret_cast<Vst2Plugin*>(e->resvd1) : tCreating;
  if (p) return p->hostCall(op, index, value, ptr, opt);
  if (op == audioMasterVersion) return 2400;
  if (op == audioMasterCurrentId) return tShellId;
  return 0;
}

}  // namespace

std::vector<ClassInfo> scanVst2(const std::string& path, std::string& error, bool& notPlugin) {
  auto m = openModule(path, error, &notPlugin);
  if (!m) return {};
  auto p = std::make_unique<Vst2Plugin>();
  if (!p->init(m, 0, error)) return {};
  if (p->category() != kPlugCategShell) return {p->info};
  // a shell: one file, many plugins (asked for one by one through audioMasterCurrentId)
  std::vector<std::pair<int32_t, std::string>> subs;
  for (int i = 0; i < 4096; i++) {
    char name[256] = {0};
    intptr_t id = p->dispatch(effShellGetNextPlugin, 0, 0, name);
    if (!id) break;
    subs.push_back({(int32_t)id, trimNul(name, sizeof name)});
  }
  std::vector<ClassInfo> out;
  for (auto& s : subs) {
    auto sp = std::make_unique<Vst2Plugin>();
    std::string err;
    ClassInfo c;
    if (sp->init(m, s.first, err)) c = sp->info;
    else { c.format = "vst2"; c.path = path; c.vendor = p->info.vendor; }
    c.uid = std::to_string(s.first);
    if (!s.second.empty()) c.name = s.second;
    out.push_back(c);
  }
  if (out.empty()) error = "No plugins in this shell file";
  return out;
}

std::unique_ptr<Plugin> loadVst2(const std::string& path, const std::string& uid, std::string& error) {
  auto m = openModule(path, error);
  if (!m) return nullptr;
  int32_t id = 0;
  try { id = (int32_t)std::stoll(uid); } catch (...) { id = 0; }
  auto p = std::make_unique<Vst2Plugin>();
  if (!p->init(m, id, error)) return nullptr;
  if (p->category() == kPlugCategShell) { error = "The plugin " + uid + " is not in this file any more"; return nullptr; }
  return p;
}
