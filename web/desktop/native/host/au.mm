// Audio Units on macOS: every unit registered on the Mac is found through the component manager (no files to scan);
// a unit runs with AudioUnitRender (effects pull their input through a render callback), notes go in with
// MusicDeviceMIDIEvent, parameters are the global-scope ones, the host callbacks give tempo / beat / transport,
// the state is the unit's ClassInfo property list, and the editor is the unit's own Cocoa view or CoreAudioKit's
// generic view. Changes made in the editor come back through an AUEventListener.
// uid: "<type>:<subtype>:<manufacturer>" as three 8-digit hex numbers (the four-character codes).
#import <AudioToolbox/AudioToolbox.h>
#import <AudioUnit/AUCocoaUIView.h>
#import <Cocoa/Cocoa.h>
#import <CoreAudioKit/CoreAudioKit.h>

#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <map>
#include <memory>
#include <string>
#include <vector>

#include "platform.h"
#include "plugin.h"
#include "util.h"

namespace {

std::string fourcc(OSType t) {
  char s[5] = {(char)(t >> 24), (char)(t >> 16), (char)(t >> 8), (char)t, 0};
  return s;
}
std::string uidOf(const AudioComponentDescription& d) {
  char b[32];
  std::snprintf(b, sizeof b, "%08x:%08x:%08x", (unsigned)d.componentType, (unsigned)d.componentSubType, (unsigned)d.componentManufacturer);
  return b;
}
bool parseUid(const std::string& uid, AudioComponentDescription& d) {
  unsigned t = 0, s = 0, m = 0;
  if (std::sscanf(uid.c_str(), "%x:%x:%x", &t, &s, &m) != 3) return false;
  d = {};
  d.componentType = t; d.componentSubType = s; d.componentManufacturer = m;
  return true;
}
std::string str(CFStringRef s) {
  if (!s) return "";
  char buf[1024];
  if (CFStringGetCString(s, buf, sizeof buf, kCFStringEncodingUTF8)) return buf;
  return "";
}
bool hostable(OSType type) { return type == kAudioUnitType_MusicDevice || type == kAudioUnitType_Effect || type == kAudioUnitType_MusicEffect; }

ClassInfo infoOf(AudioComponent c) {
  AudioComponentDescription d{};
  AudioComponentGetDescription(c, &d);
  ClassInfo ci;
  ci.format = "au";
  ci.path = "AudioUnit";
  ci.uid = uidOf(d);
  CFStringRef name = nullptr;
  std::string full;
  if (AudioComponentCopyName(c, &name) == noErr && name) { full = str(name); CFRelease(name); }
  size_t colon = full.find(": ");                    // "Manufacturer: Name"
  if (colon != std::string::npos) { ci.vendor = full.substr(0, colon); ci.name = full.substr(colon + 2); }
  else { ci.name = full.empty() ? fourcc(d.componentSubType) : full; ci.vendor = fourcc(d.componentManufacturer); }
  UInt32 ver = 0;
  if (AudioComponentGetVersion(c, &ver) == noErr) ci.version = std::to_string(ver >> 16) + "." + std::to_string((ver >> 8) & 0xff) + "." + std::to_string(ver & 0xff);
  ci.instrument = d.componentType == kAudioUnitType_MusicDevice;
  ci.category = d.componentType == kAudioUnitType_MusicDevice ? "Instrument" : d.componentType == kAudioUnitType_MusicEffect ? "Fx|MIDI" : "Fx";
  return ci;
}

std::string unitName(AudioUnitParameterUnit u) {
  switch (u) {
    case kAudioUnitParameterUnit_Percent: return "%";
    case kAudioUnitParameterUnit_Seconds: return "s";
    case kAudioUnitParameterUnit_Milliseconds: return "ms";
    case kAudioUnitParameterUnit_Hertz: return "Hz";
    case kAudioUnitParameterUnit_Decibels: return "dB";
    case kAudioUnitParameterUnit_Cents: return "ct";
    case kAudioUnitParameterUnit_RelativeSemiTones: return "st";
    case kAudioUnitParameterUnit_BPM: return "BPM";
    case kAudioUnitParameterUnit_Degrees: return "°";
    case kAudioUnitParameterUnit_Beats: return "beats";
    default: return "";
  }
}

class AuPlugin;
OSStatus inputProc(void* ref, AudioUnitRenderActionFlags*, const AudioTimeStamp*, UInt32, UInt32 frames, AudioBufferList* io);
OSStatus beatAndTempo(void* ref, Float64* beat, Float64* tempo);
OSStatus musicalTime(void* ref, UInt32* toNextBeat, Float32* tsNum, UInt32* tsDen, Float64* downBeat);
OSStatus transportState(void* ref, Boolean* playing, Boolean* changed, Float64* sample, Boolean* cycling, Float64* cycleStart, Float64* cycleEnd);
void propertyChanged(void* ref, AudioUnit, AudioUnitPropertyID id, AudioUnitScope, AudioUnitElement);
void editorEvent(void* ref, void*, const AudioUnitEvent* ev, UInt64, AudioUnitParameterValue value);

struct Range { double min = 0, max = 1; bool log = false; };

class AuPlugin : public Plugin {
 public:
  ~AuPlugin() override {
    closeEditor();
    if (listener_) { AUListenerDispose(listener_); listener_ = nullptr; }
    deactivate();
    if (unit_) { AudioComponentInstanceDispose(unit_); unit_ = nullptr; }
  }

  bool init(const std::string& uid, std::string& error) {
    AudioComponentDescription d{};
    if (!parseUid(uid, d)) { error = "Not an Audio Unit id: " + uid; return false; }
    AudioComponent c = AudioComponentFindNext(nullptr, &d);
    if (!c) { error = "No plugin " + uid + " on this Mac"; return false; }
    info = infoOf(c);
    type_ = d.componentType;
    OSStatus st = AudioComponentInstanceNew(c, &unit_);
    if (st != noErr || !unit_) { error = "Could not create the Audio Unit (error " + std::to_string((int)st) + ")"; unit_ = nullptr; return false; }
    hasInput = type_ != kAudioUnitType_MusicDevice;
    outChannels = 2;
    AURenderCallbackStruct rc{inputProc, this};
    if (hasInput) AudioUnitSetProperty(unit_, kAudioUnitProperty_SetRenderCallback, kAudioUnitScope_Input, 0, &rc, sizeof rc);
    HostCallbackInfo hc{};
    hc.hostUserData = this;
    hc.beatAndTempoProc = beatAndTempo;
    hc.musicalTimeLocationProc = musicalTime;
    hc.transportStateProc = transportState;
    AudioUnitSetProperty(unit_, kAudioUnitProperty_HostCallbacks, kAudioUnitScope_Global, 0, &hc, sizeof hc);
    AudioUnitAddPropertyListener(unit_, kAudioUnitProperty_Latency, propertyChanged, this);
    AudioUnitAddPropertyListener(unit_, kAudioUnitProperty_ParameterList, propertyChanged, this);
    cacheRanges();
    // knobs turned in the unit's own window (and gestures: begin / end of an edit)
    if (AUEventListenerCreate(editorEvent, this, CFRunLoopGetMain(), kCFRunLoopDefaultMode, 0.03f, 0.03f, &listener_) != noErr) listener_ = nullptr;
    listenToParams();
    return true;
  }

  void listenToParams() {
    if (!listener_) return;
    for (auto& kv : ranges_) {
      for (AudioUnitEventType t : {kAudioUnitEvent_ParameterValueChange, kAudioUnitEvent_EndParameterChangeGesture}) {
        AudioUnitEvent ev{};
        ev.mEventType = t;
        ev.mArgument.mParameter = {unit_, kv.first, kAudioUnitScope_Global, 0};
        AUEventListenerAddEventType(listener_, this, &ev);
      }
    }
  }

  std::vector<AudioUnitParameterID> paramIds() {
    UInt32 size = 0;
    if (AudioUnitGetPropertyInfo(unit_, kAudioUnitProperty_ParameterList, kAudioUnitScope_Global, 0, &size, nullptr) != noErr || !size) return {};
    std::vector<AudioUnitParameterID> ids(size / sizeof(AudioUnitParameterID));
    if (AudioUnitGetProperty(unit_, kAudioUnitProperty_ParameterList, kAudioUnitScope_Global, 0, ids.data(), &size) != noErr) return {};
    ids.resize(size / sizeof(AudioUnitParameterID));
    return ids;
  }
  bool paramInfo(AudioUnitParameterID id, AudioUnitParameterInfo& pi) {
    UInt32 size = sizeof pi;
    std::memset(&pi, 0, sizeof pi);
    return AudioUnitGetProperty(unit_, kAudioUnitProperty_ParameterInfo, kAudioUnitScope_Global, id, &pi, &size) == noErr;
  }
  void cacheRanges() {
    std::map<uint32_t, Range> r;
    for (auto id : paramIds()) {
      AudioUnitParameterInfo pi;
      if (!paramInfo(id, pi)) continue;
      Range g;
      g.min = pi.minValue; g.max = pi.maxValue;
      g.log = (pi.flags & kAudioUnitParameterFlag_DisplayLogarithmic) && pi.minValue > 0 && pi.maxValue > pi.minValue;
      r[id] = g;
      if ((pi.flags & kAudioUnitParameterFlag_HasCFNameString) && (pi.flags & kAudioUnitParameterFlag_CFNameRelease) && pi.cfNameString) CFRelease(pi.cfNameString);
      if (pi.unit == kAudioUnitParameterUnit_CustomUnit && pi.unitName) CFRelease(pi.unitName);
    }
    ranges_.swap(r);
  }
  double toPlain(uint32_t id, double n) const {
    auto it = ranges_.find(id);
    if (it == ranges_.end()) return n;
    const Range& g = it->second;
    n = std::clamp(n, 0.0, 1.0);
    return g.log ? g.min * std::pow(g.max / g.min, n) : g.min + n * (g.max - g.min);
  }
  double toNorm(uint32_t id, double v) const {
    auto it = ranges_.find(id);
    if (it == ranges_.end()) return v;
    const Range& g = it->second;
    if (g.max == g.min) return 0;
    double n = g.log ? std::log(std::max(v, g.min) / g.min) / std::log(g.max / g.min) : (v - g.min) / (g.max - g.min);
    return std::clamp(n, 0.0, 1.0);
  }

  // ------------------------------------------------------------------ lifecycle
  bool setFormat(AudioUnitScope scope, double sr) {
    AudioStreamBasicDescription f{};
    f.mSampleRate = sr;
    f.mFormatID = kAudioFormatLinearPCM;
    f.mFormatFlags = kAudioFormatFlagsNativeFloatPacked | kAudioFormatFlagIsNonInterleaved;
    f.mBytesPerPacket = 4; f.mFramesPerPacket = 1; f.mBytesPerFrame = 4; f.mChannelsPerFrame = 2; f.mBitsPerChannel = 32;
    return AudioUnitSetProperty(unit_, kAudioUnitProperty_StreamFormat, scope, 0, &f, sizeof f) == noErr;
  }
  bool activate(double sr, int maxFrames) override {
    if (active_) deactivate();
    sr_ = sr;
    if (!setFormat(kAudioUnitScope_Output, sr)) return false;
    if (hasInput && !setFormat(kAudioUnitScope_Input, sr)) return false;
    UInt32 maxF = (UInt32)std::max(maxFrames, 1024);
    AudioUnitSetProperty(unit_, kAudioUnitProperty_MaximumFramesPerSlice, kAudioUnitScope_Global, 0, &maxF, sizeof maxF);
    if (AudioUnitInitialize(unit_) != noErr) return false;
    active_ = true;
    return true;
  }
  void deactivate() override {
    if (!active_) return;
    AudioUnitUninitialize(unit_);
    active_ = false;
  }
  void stopProcessing() override {}

  // ------------------------------------------------------------------ parameters
  std::vector<ParamInfo> params() override {
    std::vector<ParamInfo> out;
    cacheRanges();
    for (auto id : paramIds()) {
      AudioUnitParameterInfo pi;
      if (!paramInfo(id, pi)) continue;
      ParamInfo p;
      p.id = id;
      p.name = (pi.flags & kAudioUnitParameterFlag_HasCFNameString) && pi.cfNameString ? str(pi.cfNameString) : trimNul(pi.name, sizeof pi.name);
      p.unit = pi.unit == kAudioUnitParameterUnit_CustomUnit && pi.unitName ? str(pi.unitName) : unitName(pi.unit);
      p.def = toNorm(id, pi.defaultValue);
      if (pi.unit == kAudioUnitParameterUnit_Boolean) p.steps = 1;
      else if (pi.unit == kAudioUnitParameterUnit_Indexed && pi.maxValue > pi.minValue && pi.maxValue - pi.minValue <= 1000) p.steps = (int)std::lround(pi.maxValue - pi.minValue);
      p.readOnly = !(pi.flags & kAudioUnitParameterFlag_IsWritable);
      p.automatable = !(pi.flags & kAudioUnitParameterFlag_NonRealTime);
      if (pi.clumpID) p.group = "Group " + std::to_string(pi.clumpID);
      if ((pi.flags & kAudioUnitParameterFlag_HasCFNameString) && (pi.flags & kAudioUnitParameterFlag_CFNameRelease) && pi.cfNameString) CFRelease(pi.cfNameString);
      if (pi.unit == kAudioUnitParameterUnit_CustomUnit && pi.unitName) CFRelease(pi.unitName);
      out.push_back(p);
    }
    return out;
  }
  double paramValue(uint32_t id) override {
    AudioUnitParameterValue v = 0;
    if (AudioUnitGetParameter(unit_, id, kAudioUnitScope_Global, 0, &v) != noErr) return 0;
    return toNorm(id, v);
  }
  std::string paramText(uint32_t id, double norm) override {
    Float32 v = (Float32)toPlain(id, norm);
    AudioUnitParameterStringFromValue sv{};
    sv.inParamID = id;
    sv.inValue = &v;
    UInt32 size = sizeof sv;
    if (AudioUnitGetProperty(unit_, kAudioUnitProperty_ParameterStringFromValue, kAudioUnitScope_Global, 0, &sv, &size) == noErr && sv.outString) {
      std::string s = str(sv.outString);
      CFRelease(sv.outString);
      if (!s.empty()) return s;
    }
    AudioUnitParameterInfo pi;
    if (!paramInfo(id, pi)) return "";
    if ((pi.flags & kAudioUnitParameterFlag_HasCFNameString) && (pi.flags & kAudioUnitParameterFlag_CFNameRelease) && pi.cfNameString) CFRelease(pi.cfNameString);
    std::string u = pi.unit == kAudioUnitParameterUnit_CustomUnit && pi.unitName ? str(pi.unitName) : unitName(pi.unit);
    if (pi.unit == kAudioUnitParameterUnit_CustomUnit && pi.unitName) CFRelease(pi.unitName);
    // indexed parameters have names for their values
    if (pi.unit == kAudioUnitParameterUnit_Indexed) {
      CFArrayRef names = nullptr;
      UInt32 sz = sizeof names;
      if (AudioUnitGetProperty(unit_, kAudioUnitProperty_ParameterValueStrings, kAudioUnitScope_Global, id, &names, &sz) == noErr && names) {
        CFIndex i = (CFIndex)std::lround(v - pi.minValue);
        std::string s = i >= 0 && i < CFArrayGetCount(names) ? str((CFStringRef)CFArrayGetValueAtIndex(names, i)) : "";
        CFRelease(names);
        if (!s.empty()) return s;
      }
    }
    if (pi.unit == kAudioUnitParameterUnit_Boolean) return v >= 0.5f ? "On" : "Off";
    char b[64];
    std::snprintf(b, sizeof b, std::fabs(v) >= 100 ? "%.0f" : std::fabs(v) >= 10 ? "%.1f" : "%.2f", v);
    return u.empty() ? b : std::string(b) + " " + u;
  }
  void setParamFromHost(uint32_t, double) override {}

  // ------------------------------------------------------------------ state: "FLAU" + the ClassInfo property list
  bool saveState(std::string& out) override {
    CFPropertyListRef plist = nullptr;
    UInt32 size = sizeof plist;
    if (AudioUnitGetProperty(unit_, kAudioUnitProperty_ClassInfo, kAudioUnitScope_Global, 0, &plist, &size) != noErr || !plist) return false;
    CFDataRef data = CFPropertyListCreateData(nullptr, plist, kCFPropertyListBinaryFormat_v1_0, 0, nullptr);
    CFRelease(plist);
    if (!data) return false;
    out = "FLAU";
    out.append(reinterpret_cast<const char*>(CFDataGetBytePtr(data)), (size_t)CFDataGetLength(data));
    CFRelease(data);
    return true;
  }
  bool loadState(const std::string& d) override {
    if (d.size() < 5 || d.compare(0, 4, "FLAU") != 0) return false;
    CFDataRef data = CFDataCreate(nullptr, reinterpret_cast<const UInt8*>(d.data() + 4), (CFIndex)(d.size() - 4));
    if (!data) return false;
    CFPropertyListRef plist = CFPropertyListCreateWithData(nullptr, data, kCFPropertyListImmutable, nullptr, nullptr);
    CFRelease(data);
    if (!plist) return false;
    OSStatus st = AudioUnitSetProperty(unit_, kAudioUnitProperty_ClassInfo, kAudioUnitScope_Global, 0, &plist, sizeof plist);
    CFRelease(plist);
    // the unit's window shows the new values
    AudioUnitParameter all{unit_, kAUParameterListener_AnyParameter, kAudioUnitScope_Global, 0};
    AUParameterListenerNotify(nullptr, nullptr, &all);
    return st == noErr;
  }
  uint32_t latency() override {
    Float64 s = 0;
    UInt32 size = sizeof s;
    if (AudioUnitGetProperty(unit_, kAudioUnitProperty_Latency, kAudioUnitScope_Global, 0, &s, &size) != noErr) return 0;
    return (uint32_t)std::max(0.0, std::round(s * sr_));
  }

  // ------------------------------------------------------------------ editor
  bool hasEditor() override { return true; }            // the generic view works for every unit
  NSView* makeView() {
    // the unit's own Cocoa view
    UInt32 size = 0;
    Boolean writable = false;
    if (AudioUnitGetPropertyInfo(unit_, kAudioUnitProperty_CocoaUI, kAudioUnitScope_Global, 0, &size, &writable) == noErr && size >= sizeof(AudioUnitCocoaViewInfo)) {
      std::vector<char> buf(size);
      auto* vi = reinterpret_cast<AudioUnitCocoaViewInfo*>(buf.data());
      if (AudioUnitGetProperty(unit_, kAudioUnitProperty_CocoaUI, kAudioUnitScope_Global, 0, vi, &size) == noErr) {
        NSView* view = nil;
        NSURL* url = (__bridge NSURL*)vi->mCocoaAUViewBundleLocation;
        NSString* cls = (__bridge NSString*)vi->mCocoaAUViewClass[0];
        NSBundle* bundle = url ? [NSBundle bundleWithURL:url] : nil;
        Class factoryClass = bundle && cls ? [bundle classNamed:cls] : nil;
        if (factoryClass && [factoryClass conformsToProtocol:@protocol(AUCocoaUIBase)]) {
          id<AUCocoaUIBase> factory = [[factoryClass alloc] init];
          view = [factory uiViewForAudioUnit:unit_ withSize:NSMakeSize(500, 300)];
        }
        if (vi->mCocoaAUViewBundleLocation) CFRelease(vi->mCocoaAUViewBundleLocation);
        UInt32 n = (size - sizeof(CFURLRef)) / sizeof(CFStringRef);
        for (UInt32 i = 0; i < n; i++) if (vi->mCocoaAUViewClass[i]) CFRelease(vi->mCocoaAUViewClass[i]);
        if (view) return view;
      }
    }
    // otherwise the generic one: a slider for every parameter
    AUGenericView* g = [[AUGenericView alloc] initWithAudioUnit:unit_ displayFlags:(AUViewTitleDisplayFlag | AUViewPropertiesDisplayFlag | AUViewParametersDisplayFlag)];
    [g setShowsExpertParameters:YES];
    return g;
  }
  bool openEditor(const std::string& title, uint64_t owner) override {
    if (win_) { plat::show(win_); return true; }
    view_ = makeView();
    if (!view_) return false;
    NSSize sz = view_.frame.size;
    if (sz.width < 50 || sz.height < 50) sz = NSMakeSize(500, 300);
    win_ = plat::createWindow(title, (int)sz.width, (int)sz.height, false, owner, {[this] { closeEditor(); if (events.editorClosed) events.editorClosed(); }, nullptr});
    if (!win_) { view_ = nil; return false; }
    NSView* content = (__bridge NSView*)plat::nativeHandle(win_);
    [view_ setFrameOrigin:NSZeroPoint];
    [content addSubview:view_];
    // units resize their own views: the window follows
    [view_ setPostsFrameChangedNotifications:YES];
    plat::Window* w = win_;
    __weak NSView* v = view_;
    resizeObserver_ = [[NSNotificationCenter defaultCenter] addObserverForName:NSViewFrameDidChangeNotification object:view_ queue:nil usingBlock:^(NSNotification*) {
      NSView* sv = v;
      if (sv) plat::setContentSize(w, (int)sv.frame.size.width, (int)sv.frame.size.height);
    }];
    plat::show(win_);
    return true;
  }
  void closeEditor() override {
    if (resizeObserver_) { [[NSNotificationCenter defaultCenter] removeObserver:resizeObserver_]; resizeObserver_ = nil; }
    if (view_) { [view_ removeFromSuperview]; view_ = nil; }
    if (win_) { plat::destroyWindow(win_); win_ = nullptr; }
  }
  bool editorOpen() override { return win_ != nullptr; }

  void fromEditor(const AudioUnitEvent* ev, AudioUnitParameterValue value) {
    if (ev->mEventType == kAudioUnitEvent_EndParameterChangeGesture) { if (events.dirty) events.dirty(); return; }
    uint32_t id = ev->mArgument.mParameter.mParameterID;
    double n = toNorm(id, value);
    if (events.paramFromEditor) events.paramFromEditor(id, n);
  }
  void changed(AudioUnitPropertyID id) {
    if (id == kAudioUnitProperty_Latency) latencyChanged_ = true;
    if (id == kAudioUnitProperty_ParameterList) paramsChanged_ = true;
  }
  void idle() override {
    if (latencyChanged_.exchange(false) && events.latencyChanged) events.latencyChanged();
    if (paramsChanged_.exchange(false)) { cacheRanges(); listenToParams(); if (events.paramsChanged) events.paramsChanged(); }
  }

  // ------------------------------------------------------------------ audio
  void process(const fl::Frame& f, fl::Slot& s) override {
    uint32_t frames = std::min<uint32_t>(f.frames, fl::MAX_FRAMES);
    if (!active_ || !frames) { std::memset(s.out, 0, sizeof s.out); return; }
    ppq_ = f.ppq; tempo_ = f.tempo > 0 ? f.tempo : 120; barPpq_ = f.barPpq;
    tsNum_ = f.tsNum ? f.tsNum : 4; tsDen_ = f.tsDen ? f.tsDen : 4;
    bool playing = (f.flags & fl::FRAME_PLAYING) != 0;
    playChanged_ = playing != playing_;
    playing_ = playing;
    looping_ = (f.flags & fl::FRAME_LOOP) != 0;
    loopStart_ = f.loopStartPpq; loopEnd_ = f.loopEndPpq;
    samplePos_ = f.samplePos;
    bool midi = type_ != kAudioUnitType_Effect;
    for (uint32_t i = 0; i < s.nEvents && i < (uint32_t)fl::MAX_EVENTS; i++) {
      const fl::Event& e = s.events[i];
      UInt32 t = std::min<uint32_t>(e.offset, frames - 1);
      uint8_t ch = e.channel & 15, key = e.key & 127;
      auto v7 = [](double v) { return (UInt32)std::lround(std::clamp(v, 0.0, 1.0) * 127); };
      switch (e.type) {
        case fl::EV_NOTE_ON: if (midi) MusicDeviceMIDIEvent(unit_, 0x90 | ch, key, std::max<UInt32>(1, v7(e.value)), t); held_[ch][key] = true; break;
        case fl::EV_NOTE_OFF: if (midi) MusicDeviceMIDIEvent(unit_, 0x80 | ch, key, v7(e.value), t); held_[ch][key] = false; break;
        case fl::EV_CC: if (midi) MusicDeviceMIDIEvent(unit_, 0xB0 | ch, key, v7(e.value), t); break;
        case fl::EV_PITCH: if (midi) { int v = std::clamp((int)std::lround((std::clamp(e.value, -1.0, 1.0) + 1) * 8191.5), 0, 16383); MusicDeviceMIDIEvent(unit_, 0xE0 | ch, (UInt32)(v & 127), (UInt32)(v >> 7), t); } break;
        case fl::EV_CHAN_PRESSURE: if (midi) MusicDeviceMIDIEvent(unit_, 0xD0 | ch, v7(e.value), 0, t); break;
        case fl::EV_POLY_PRESSURE: if (midi) MusicDeviceMIDIEvent(unit_, 0xA0 | ch, key, v7(e.value), t); break;
        case fl::EV_PARAM: AudioUnitSetParameter(unit_, e.param, kAudioUnitScope_Global, 0, (AudioUnitParameterValue)toPlain(e.param, e.value), t); break;
        case fl::EV_RESET: std::memset(held_, 0, sizeof held_); AudioUnitReset(unit_, kAudioUnitScope_Global, 0); break;
        case fl::EV_ALL_OFF:
          for (int c = 0; c < 16; c++)
            for (int k = 0; k < 128; k++)
              if (held_[c][k]) { held_[c][k] = false; if (midi) MusicDeviceMIDIEvent(unit_, (UInt32)(0x80 | c), (UInt32)k, 0, t); }
          break;
      }
    }
    if (hasInput) { std::memcpy(inBuf_[0], s.in[0], frames * sizeof(float)); std::memcpy(inBuf_[1], s.in[1], frames * sizeof(float)); }
    struct { UInt32 n; AudioBuffer b[2]; } abl;
    abl.n = 2;
    for (int c = 0; c < 2; c++) { abl.b[c].mNumberChannels = 1; abl.b[c].mDataByteSize = frames * sizeof(float); abl.b[c].mData = s.out[c]; }
    AudioUnitRenderActionFlags flags = 0;
    AudioTimeStamp ts{};
    ts.mSampleTime = sampleTime_;
    ts.mFlags = kAudioTimeStampSampleTimeValid;
    OSStatus st = AudioUnitRender(unit_, &flags, &ts, 0, frames, reinterpret_cast<AudioBufferList*>(&abl));
    sampleTime_ += frames;
    if (st != noErr) { std::memset(s.out, 0, sizeof s.out); return; }
    // a unit may answer with its own buffers
    for (int c = 0; c < 2; c++) if (abl.b[c].mData && abl.b[c].mData != s.out[c]) std::memcpy(s.out[c], abl.b[c].mData, frames * sizeof(float));
  }

  // render callback: the effect's input
  OSStatus pullInput(UInt32 frames, AudioBufferList* io) {
    for (UInt32 b = 0; b < io->mNumberBuffers; b++) {
      const float* src = inBuf_[b < 2 ? b : 1];
      UInt32 n = std::min<UInt32>(frames, fl::MAX_FRAMES);
      if (!io->mBuffers[b].mData) io->mBuffers[b].mData = const_cast<float*>(src);
      else std::memcpy(io->mBuffers[b].mData, src, n * sizeof(float));
      io->mBuffers[b].mDataByteSize = n * sizeof(float);
    }
    return noErr;
  }

  // what the host callbacks report (set at the start of each block on the audio thread)
  double ppq_ = 0, tempo_ = 120, barPpq_ = 0, loopStart_ = 0, loopEnd_ = 0, samplePos_ = 0, sr_ = 48000;
  uint32_t tsNum_ = 4, tsDen_ = 4;
  bool playing_ = false, playChanged_ = false, looping_ = false;

 private:
  AudioComponentInstance unit_ = nullptr;
  OSType type_ = 0;
  AUEventListenerRef listener_ = nullptr;
  std::map<uint32_t, Range> ranges_;
  float inBuf_[2][fl::MAX_FRAMES] = {};
  double sampleTime_ = 0;
  bool active_ = false;
  bool held_[16][128] = {};
  std::atomic<bool> latencyChanged_{false}, paramsChanged_{false};
  plat::Window* win_ = nullptr;
  NSView* view_ = nil;
  id resizeObserver_ = nil;
};

OSStatus inputProc(void* ref, AudioUnitRenderActionFlags*, const AudioTimeStamp*, UInt32, UInt32 frames, AudioBufferList* io) {
  return static_cast<AuPlugin*>(ref)->pullInput(frames, io);
}
OSStatus beatAndTempo(void* ref, Float64* beat, Float64* tempo) {
  auto* p = static_cast<AuPlugin*>(ref);
  if (beat) *beat = p->ppq_;
  if (tempo) *tempo = p->tempo_;
  return noErr;
}
OSStatus musicalTime(void* ref, UInt32* toNextBeat, Float32* tsNum, UInt32* tsDen, Float64* downBeat) {
  auto* p = static_cast<AuPlugin*>(ref);
  if (toNextBeat) { double frac = p->ppq_ - std::floor(p->ppq_); *toNextBeat = (UInt32)std::lround((frac > 0 ? 1 - frac : 0) * 60.0 / p->tempo_ * p->sr_); }
  if (tsNum) *tsNum = (Float32)p->tsNum_;
  if (tsDen) *tsDen = p->tsDen_;
  if (downBeat) *downBeat = p->barPpq_;
  return noErr;
}
OSStatus transportState(void* ref, Boolean* playing, Boolean* changed, Float64* sample, Boolean* cycling, Float64* cycleStart, Float64* cycleEnd) {
  auto* p = static_cast<AuPlugin*>(ref);
  if (playing) *playing = p->playing_;
  if (changed) *changed = p->playChanged_;
  if (sample) *sample = p->samplePos_;
  if (cycling) *cycling = p->looping_;
  if (cycleStart) *cycleStart = p->loopStart_;
  if (cycleEnd) *cycleEnd = p->loopEnd_;
  return noErr;
}
void propertyChanged(void* ref, AudioUnit, AudioUnitPropertyID id, AudioUnitScope, AudioUnitElement) { static_cast<AuPlugin*>(ref)->changed(id); }
void editorEvent(void* ref, void*, const AudioUnitEvent* ev, UInt64, AudioUnitParameterValue value) { static_cast<AuPlugin*>(ref)->fromEditor(ev, value); }

}  // namespace

std::vector<ClassInfo> scanAu(std::string& error) {
  std::vector<ClassInfo> out;
  AudioComponentDescription any{};
  AudioComponent c = nullptr;
  while ((c = AudioComponentFindNext(c, &any))) {
    AudioComponentDescription d{};
    if (AudioComponentGetDescription(c, &d) != noErr || !hostable(d.componentType)) continue;
    out.push_back(infoOf(c));
  }
  if (out.empty()) error = "No Audio Units on this Mac";
  return out;
}

std::unique_ptr<Plugin> loadAu(const std::string& uid, std::string& error) {
  auto p = std::make_unique<AuPlugin>();
  if (!p->init(uid, error)) return nullptr;
  return p;
}
