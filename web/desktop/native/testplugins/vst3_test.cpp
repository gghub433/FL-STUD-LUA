// Test plugins for FL LUA's plugin host (not shipped). One VST3 module with two classes:
//   "FLLUA Test Synth"  instrument: a sine/saw voice per note; parameters Gain (0) and Tone (1); an editor window that
//                       turns Tone to 0.75 by itself (as if a person did) so the editor -> host path can be tested
//   "FLLUA Test Gain"   effect: multiplies the input by 2 * Gain; reports 64 samples of latency (delays by 64)
// Written against pluginterfaces only, in the simplest single-component form.
#include <atomic>
#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <map>

#include "pluginterfaces/base/funknown.h"
#include "pluginterfaces/base/ibstream.h"
#include "pluginterfaces/base/ipluginbase.h"
#include "pluginterfaces/gui/iplugview.h"
#include "pluginterfaces/vst/ivstaudioprocessor.h"
#include "pluginterfaces/vst/ivstcomponent.h"
#include "pluginterfaces/vst/ivsteditcontroller.h"
#include "pluginterfaces/vst/ivstevents.h"
#include "pluginterfaces/vst/ivstparameterchanges.h"
#include "pluginterfaces/vst/ivstprocesscontext.h"

#if defined(__linux__)
#include <X11/Xlib.h>
#elif defined(_WIN32)
#include <windows.h>
#endif

using namespace Steinberg;
using namespace Steinberg::Vst;

#if defined(_WIN32)
#define EXPORT extern "C" __declspec(dllexport)
#else
#define EXPORT extern "C" __attribute__((visibility("default")))
#endif

namespace {

static const FUID kSynthUID(0x464C4C55, 0x41545354, 0x53594E54, 0x48000001);
static const FUID kGainUID(0x464C4C55, 0x41545354, 0x4741494E, 0x00000002);

void str16(const char* s, String128 out) {
  int i = 0;
  for (; s[i] && i < 127; i++) out[i] = (TChar)s[i];
  out[i] = 0;
}

class TestView : public IPlugView {
 public:
  explicit TestView(IComponentHandler** handler) : handler_(handler) {}
  virtual ~TestView() = default;
  tresult PLUGIN_API queryInterface(const TUID _iid, void** obj) override {
    if (FUnknownPrivate::iidEqual(_iid, IPlugView::iid) || FUnknownPrivate::iidEqual(_iid, FUnknown::iid)) { addRef(); *obj = this; return kResultOk; }
    *obj = nullptr;
    return kNoInterface;
  }
  uint32 PLUGIN_API addRef() override { return ++rc_; }
  uint32 PLUGIN_API release() override { uint32 r = --rc_; if (!r) delete this; return r; }
  tresult PLUGIN_API isPlatformTypeSupported(FIDString type) override {
#if defined(__linux__)
    return std::strcmp(type, kPlatformTypeX11EmbedWindowID) == 0 ? kResultTrue : kResultFalse;
#elif defined(_WIN32)
    return std::strcmp(type, kPlatformTypeHWND) == 0 ? kResultTrue : kResultFalse;
#else
    (void)type;
    return kResultFalse;
#endif
  }
  tresult PLUGIN_API attached(void* parent, FIDString) override {
#if defined(__linux__)
    dpy_ = XOpenDisplay(nullptr);
    if (!dpy_) return kResultFalse;
    win_ = XCreateSimpleWindow(dpy_, (Window)(uintptr_t)parent, 0, 0, 320, 200, 0, 0, 0x2a7fff);
    XMapWindow(dpy_, win_);
    XFlush(dpy_);
#elif defined(_WIN32)
    hwnd_ = CreateWindowExW(0, L"STATIC", L"FLLUA Test Synth", WS_CHILD | WS_VISIBLE, 0, 0, 320, 200, (HWND)parent, nullptr, nullptr, nullptr);
#endif
    // "a person turns the Tone knob"
    if (handler_ && *handler_) { (*handler_)->beginEdit(1); (*handler_)->performEdit(1, 0.75); (*handler_)->endEdit(1); }
    return kResultOk;
  }
  tresult PLUGIN_API removed() override {
#if defined(__linux__)
    if (dpy_) { XDestroyWindow(dpy_, win_); XCloseDisplay(dpy_); dpy_ = nullptr; }
#elif defined(_WIN32)
    if (hwnd_) DestroyWindow(hwnd_);
    hwnd_ = nullptr;
#endif
    return kResultOk;
  }
  tresult PLUGIN_API onWheel(float) override { return kResultFalse; }
  tresult PLUGIN_API onKeyDown(char16, int16, int16) override { return kResultFalse; }
  tresult PLUGIN_API onKeyUp(char16, int16, int16) override { return kResultFalse; }
  tresult PLUGIN_API getSize(ViewRect* r) override { *r = ViewRect(0, 0, 320, 200); return kResultOk; }
  tresult PLUGIN_API onSize(ViewRect*) override { return kResultOk; }
  tresult PLUGIN_API onFocus(TBool) override { return kResultOk; }
  tresult PLUGIN_API setFrame(IPlugFrame*) override { return kResultOk; }
  tresult PLUGIN_API canResize() override { return kResultFalse; }
  tresult PLUGIN_API checkSizeConstraint(ViewRect*) override { return kResultOk; }

 private:
  std::atomic<uint32> rc_{1};
  IComponentHandler** handler_;
#if defined(__linux__)
  Display* dpy_ = nullptr;
  Window win_ = 0;
#elif defined(_WIN32)
  HWND hwnd_ = nullptr;
#endif
};

class TestPlugin : public IComponent, public IAudioProcessor, public IEditController {
 public:
  explicit TestPlugin(bool synth) : synth_(synth) { p_[0] = 0.5; p_[1] = 0.25; }
  virtual ~TestPlugin() = default;
  tresult PLUGIN_API queryInterface(const TUID _iid, void** obj) override {
    if (FUnknownPrivate::iidEqual(_iid, IComponent::iid) || FUnknownPrivate::iidEqual(_iid, IPluginBase::iid) || FUnknownPrivate::iidEqual(_iid, FUnknown::iid)) { addRef(); *obj = static_cast<IComponent*>(this); return kResultOk; }
    if (FUnknownPrivate::iidEqual(_iid, IAudioProcessor::iid)) { addRef(); *obj = static_cast<IAudioProcessor*>(this); return kResultOk; }
    if (FUnknownPrivate::iidEqual(_iid, IEditController::iid)) { addRef(); *obj = static_cast<IEditController*>(this); return kResultOk; }
    *obj = nullptr;
    return kNoInterface;
  }
  uint32 PLUGIN_API addRef() override { return ++rc_; }
  uint32 PLUGIN_API release() override { uint32 r = --rc_; if (!r) delete this; return r; }
  tresult PLUGIN_API initialize(FUnknown*) override { return kResultOk; }
  tresult PLUGIN_API terminate() override { return kResultOk; }

  // IComponent
  tresult PLUGIN_API getControllerClassId(TUID) override { return kResultFalse; }
  tresult PLUGIN_API setIoMode(IoMode) override { return kResultOk; }
  int32 PLUGIN_API getBusCount(MediaType type, BusDirection dir) override {
    if (type == kAudio) return dir == kOutput ? 1 : (synth_ ? 0 : 1);
    if (type == kEvent) return dir == kInput && synth_ ? 1 : 0;
    return 0;
  }
  tresult PLUGIN_API getBusInfo(MediaType type, BusDirection dir, int32 index, BusInfo& bus) override {
    if (index != 0) return kResultFalse;
    bus.mediaType = type; bus.direction = dir; bus.busType = kMain; bus.flags = BusInfo::kDefaultActive;
    bus.channelCount = type == kAudio ? 2 : 16;
    str16(type == kAudio ? (dir == kInput ? "In" : "Out") : "Notes", bus.name);
    return kResultOk;
  }
  tresult PLUGIN_API getRoutingInfo(RoutingInfo&, RoutingInfo&) override { return kNotImplemented; }
  tresult PLUGIN_API activateBus(MediaType, BusDirection, int32, TBool) override { return kResultOk; }
  tresult PLUGIN_API setActive(TBool) override { std::memset(voices_, 0, sizeof voices_); std::memset(dl_, 0, sizeof dl_); return kResultOk; }
  tresult PLUGIN_API setState(IBStream* s) override {
    double v[2];
    int32 got = 0;
    if (!s || s->read(v, sizeof v, &got) != kResultOk || got != (int32)sizeof v) return kResultFalse;
    p_[0] = v[0]; p_[1] = v[1];
    return kResultOk;
  }
  tresult PLUGIN_API getState(IBStream* s) override {
    double v[2] = {p_[0], p_[1]};
    return s && s->write(v, sizeof v, nullptr) == kResultOk ? kResultOk : kResultFalse;
  }

  // IAudioProcessor
  tresult PLUGIN_API setBusArrangements(SpeakerArrangement*, int32, SpeakerArrangement*, int32) override { return kResultTrue; }
  tresult PLUGIN_API getBusArrangement(BusDirection, int32, SpeakerArrangement& a) override { a = SpeakerArr::kStereo; return kResultOk; }
  tresult PLUGIN_API canProcessSampleSize(int32 s) override { return s == kSample32 ? kResultTrue : kResultFalse; }
  uint32 PLUGIN_API getLatencySamples() override { return synth_ ? 0 : 64; }
  tresult PLUGIN_API setupProcessing(ProcessSetup& s) override { sr_ = s.sampleRate; return kResultOk; }
  tresult PLUGIN_API setProcessing(TBool on) override { if (!on) { std::memset(voices_, 0, sizeof voices_); std::memset(dl_, 0, sizeof dl_); } return kResultOk; }
  uint32 PLUGIN_API getTailSamples() override { return 0; }
  tresult PLUGIN_API process(ProcessData& d) override {
    if (d.inputParameterChanges) {
      int32 n = d.inputParameterChanges->getParameterCount();
      for (int32 i = 0; i < n; i++) {
        IParamValueQueue* q = d.inputParameterChanges->getParameterData(i);
        int32 pts = q ? q->getPointCount() : 0, off;
        ParamValue v;
        if (pts && q->getPoint(pts - 1, off, v) == kResultOk && q->getParameterId() < 2) p_[q->getParameterId()] = v;
      }
    }
    if (d.numOutputs < 1 || d.outputs[0].numChannels < 2) return kResultOk;
    float* L = d.outputs[0].channelBuffers32[0];
    float* R = d.outputs[0].channelBuffers32[1];
    int32 n = d.numSamples;
    if (!synth_) {
      float g = (float)(2 * p_[0]);
      const float* il = d.numInputs > 0 ? d.inputs[0].channelBuffers32[0] : nullptr;
      const float* ir = d.numInputs > 0 ? d.inputs[0].channelBuffers32[1] : nullptr;
      for (int32 i = 0; i < n; i++) {
        float a = il ? il[i] : 0, b = ir ? ir[i] : 0;
        L[i] = dl_[0][dp_] * g; R[i] = dl_[1][dp_] * g;
        dl_[0][dp_] = a; dl_[1][dp_] = b;
        dp_ = (dp_ + 1) % 64;
      }
      return kResultOk;
    }
    std::memset(L, 0, (size_t)n * sizeof(float));
    std::memset(R, 0, (size_t)n * sizeof(float));
    int32 ne = d.inputEvents ? d.inputEvents->getEventCount() : 0, ei = 0;
    for (int32 i = 0; i < n; i++) {
      while (ei < ne) {
        Event e{};
        d.inputEvents->getEvent(ei, e);
        if (e.sampleOffset > i) break;
        if (e.type == Event::kNoteOnEvent) { Voice& v = voices_[e.noteOn.pitch & 127]; v.on = true; v.vel = e.noteOn.velocity; v.ph = 0; v.env = 0; }
        if (e.type == Event::kNoteOffEvent) voices_[e.noteOff.pitch & 127].on = false;
        ei++;
      }
      float s = 0;
      for (int k = 0; k < 128; k++) {
        Voice& v = voices_[k];
        if (!v.on && v.env < 1e-4f) continue;
        v.env += ((v.on ? 1.f : 0.f) - v.env) * (v.on ? 0.01f : 0.002f);
        double f = 440.0 * std::pow(2.0, (k - 69) / 12.0);
        v.ph += f / sr_;
        if (v.ph >= 1) v.ph -= 1;
        double sine = std::sin(v.ph * 6.283185307), saw = 2 * v.ph - 1;
        s += (float)((sine * (1 - p_[1]) + saw * p_[1]) * v.env * v.vel * 0.3);
      }
      L[i] = R[i] = s * (float)(2 * p_[0]);
    }
    return kResultOk;
  }

  // IEditController
  tresult PLUGIN_API setComponentState(IBStream* s) override {
    double v[2];
    int32 got = 0;
    if (s && s->read(v, sizeof v, &got) == kResultOk && got == (int32)sizeof v) { p_[0] = v[0]; p_[1] = v[1]; }
    return kResultOk;
  }
  int32 PLUGIN_API getParameterCount() override { return 2; }
  tresult PLUGIN_API getParameterInfo(int32 i, ParameterInfo& info) override {
    if (i < 0 || i > 1) return kResultFalse;
    std::memset(&info, 0, sizeof info);
    info.id = (ParamID)i;
    str16(i == 0 ? "Gain" : "Tone", info.title);
    str16(i == 0 ? "Gain" : "Tone", info.shortTitle);
    str16(i == 0 ? "dB" : "%", info.units);
    info.defaultNormalizedValue = i == 0 ? 0.5 : 0.25;
    info.flags = ParameterInfo::kCanAutomate;
    return kResultOk;
  }
  tresult PLUGIN_API getParamStringByValue(ParamID id, ParamValue v, String128 s) override {
    char b[64];
    if (id == 0) std::snprintf(b, sizeof b, "%.1f dB", 20 * std::log10(std::max(1e-6, 2 * v)));
    else std::snprintf(b, sizeof b, "%d%%", (int)std::lround(v * 100));
    str16(b, s);
    return kResultOk;
  }
  tresult PLUGIN_API getParamValueByString(ParamID, TChar*, ParamValue&) override { return kResultFalse; }
  ParamValue PLUGIN_API normalizedParamToPlain(ParamID, ParamValue v) override { return v; }
  ParamValue PLUGIN_API plainParamToNormalized(ParamID, ParamValue v) override { return v; }
  ParamValue PLUGIN_API getParamNormalized(ParamID id) override { return id < 2 ? p_[id] : 0; }
  tresult PLUGIN_API setParamNormalized(ParamID id, ParamValue v) override { if (id < 2) p_[id] = v; return kResultOk; }
  tresult PLUGIN_API setComponentHandler(IComponentHandler* h) override { handler_ = h; return kResultOk; }
  IPlugView* PLUGIN_API createView(FIDString name) override {
    if (!synth_ || !name || std::strcmp(name, ViewType::kEditor) != 0) return nullptr;
    return new TestView(&handler_);
  }

 private:
  struct Voice { bool on; float vel; double ph; float env; };
  std::atomic<uint32> rc_{1};
  bool synth_;
  double p_[2];
  double sr_ = 48000;
  Voice voices_[128] = {};
  float dl_[2][64] = {};
  int dp_ = 0;
  IComponentHandler* handler_ = nullptr;
};

class Factory : public IPluginFactory2 {
 public:
  tresult PLUGIN_API queryInterface(const TUID _iid, void** obj) override {
    if (FUnknownPrivate::iidEqual(_iid, IPluginFactory2::iid) || FUnknownPrivate::iidEqual(_iid, IPluginFactory::iid) || FUnknownPrivate::iidEqual(_iid, FUnknown::iid)) { *obj = this; return kResultOk; }
    *obj = nullptr;
    return kNoInterface;
  }
  uint32 PLUGIN_API addRef() override { return 1; }
  uint32 PLUGIN_API release() override { return 1; }
  tresult PLUGIN_API getFactoryInfo(PFactoryInfo* info) override {
    std::memset(info, 0, sizeof *info);
    std::strcpy(info->vendor, "FL LUA Tests");
    info->flags = PFactoryInfo::kUnicode;
    return kResultOk;
  }
  int32 PLUGIN_API countClasses() override { return 2; }
  tresult PLUGIN_API getClassInfo(int32 i, PClassInfo* info) override {
    if (i < 0 || i > 1) return kResultFalse;
    std::memset(info, 0, sizeof *info);
    (i == 0 ? kSynthUID : kGainUID).toTUID(info->cid);
    info->cardinality = PClassInfo::kManyInstances;
    std::strcpy(info->category, kVstAudioEffectClass);
    std::strcpy(info->name, i == 0 ? "FLLUA Test Synth" : "FLLUA Test Gain");
    return kResultOk;
  }
  tresult PLUGIN_API getClassInfo2(int32 i, PClassInfo2* info) override {
    if (i < 0 || i > 1) return kResultFalse;
    std::memset(info, 0, sizeof *info);
    (i == 0 ? kSynthUID : kGainUID).toTUID(info->cid);
    info->cardinality = PClassInfo::kManyInstances;
    std::strcpy(info->category, kVstAudioEffectClass);
    std::strcpy(info->name, i == 0 ? "FLLUA Test Synth" : "FLLUA Test Gain");
    std::strcpy(info->subCategories, i == 0 ? "Instrument|Synth" : "Fx|Dynamics");
    std::strcpy(info->vendor, "FL LUA Tests");
    std::strcpy(info->version, "1.0.0");
    std::strcpy(info->sdkVersion, "VST 3.8.1");
    return kResultOk;
  }
  tresult PLUGIN_API createInstance(FIDString cid, FIDString _iid, void** obj) override {
    bool synth = FUnknownPrivate::iidEqual(cid, kSynthUID.toTUID());
    if (!synth && !FUnknownPrivate::iidEqual(cid, kGainUID.toTUID())) { *obj = nullptr; return kResultFalse; }
    auto* p = new TestPlugin(synth);
    tresult r = p->queryInterface(_iid, obj);
    p->release();
    return r;
  }
};
Factory gFactory;

}  // namespace

EXPORT IPluginFactory* PLUGIN_API GetPluginFactory() { return &gFactory; }
#if defined(__linux__)
EXPORT bool ModuleEntry(void*) { return true; }
EXPORT bool ModuleExit() { return true; }
#elif defined(_WIN32)
EXPORT bool PLUGIN_API InitDll() { return true; }
EXPORT bool PLUGIN_API ExitDll() { return true; }
#else
EXPORT bool bundleEntry(void*) { return true; }
EXPORT bool bundleExit() { return true; }
#endif
