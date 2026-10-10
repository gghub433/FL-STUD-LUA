// VST3 plugins (Steinberg VST3 interfaces, MIT). A minimal host written against pluginterfaces only:
// module loading, class scan, component + controller (single or separate, connected), buses, realtime processing
// with events and parameter changes, MIDI controller mapping, state, the plugin's editor window and the Linux run loop.
#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstring>
#include <map>
#include <memory>
#include <mutex>
#include <set>
#include <vector>

#include "module.h"
#include "platform.h"
#include "plugin.h"
#include "util.h"

#include "pluginterfaces/base/funknown.h"
#include "pluginterfaces/base/ibstream.h"
#include "pluginterfaces/base/ipluginbase.h"
#include "pluginterfaces/gui/iplugview.h"
#include "pluginterfaces/gui/iplugviewcontentscalesupport.h"
#include "pluginterfaces/vst/ivstattributes.h"
#include "pluginterfaces/vst/ivstaudioprocessor.h"
#include "pluginterfaces/vst/ivstcomponent.h"
#include "pluginterfaces/vst/ivsteditcontroller.h"
#include "pluginterfaces/vst/ivstevents.h"
#include "pluginterfaces/vst/ivsthostapplication.h"
#include "pluginterfaces/vst/ivstmessage.h"
#include "pluginterfaces/vst/ivstmidicontrollers.h"
#include "pluginterfaces/vst/ivstparameterchanges.h"
#include "pluginterfaces/vst/ivstpluginterfacesupport.h"
#include "pluginterfaces/vst/ivstprocesscontext.h"

using namespace Steinberg;
using namespace Steinberg::Vst;

namespace {

#define FL_QI(Iface)                                                  \
  if (FUnknownPrivate::iidEqual(_iid, Iface::iid)) {                  \
    addRef();                                                         \
    *obj = static_cast<Iface*>(this);                                 \
    return kResultOk;                                                 \
  }

// host objects owned by C++ code: reference counts are kept but they are never deleted through release()
#define FL_STATIC_REFCOUNT                                            \
  uint32 PLUGIN_API addRef() override { return ++rc_; }               \
  uint32 PLUGIN_API release() override { return --rc_; }             \
  std::atomic<uint32> rc_{1};

#define FL_HEAP_REFCOUNT                                              \
  uint32 PLUGIN_API addRef() override { return ++rc_; }               \
  uint32 PLUGIN_API release() override {                              \
    uint32 r = --rc_;                                                 \
    if (r == 0) delete this;                                          \
    return r;                                                         \
  }                                                                   \
  std::atomic<uint32> rc_{1};

std::string uidString(const TUID cid) {
  char buf[40] = {0};
  FUID::fromTUID(cid).toString(buf);
  return buf;
}
bool uidFromString(const std::string& s, TUID out) {
  FUID f;
  if (!f.fromString(s.c_str())) return false;
  f.toTUID(out);
  return true;
}

// ---------------------------------------------------------------------------------------------- attribute list
class HostAttributeList : public IAttributeList {
 public:
  virtual ~HostAttributeList() = default;
  tresult PLUGIN_API queryInterface(const TUID _iid, void** obj) override {
    FL_QI(IAttributeList)
    FL_QI(FUnknown)
    *obj = nullptr;
    return kNoInterface;
  }
  FL_HEAP_REFCOUNT
  tresult PLUGIN_API setInt(AttrID id, int64 v) override { ints_[id] = v; return kResultOk; }
  tresult PLUGIN_API getInt(AttrID id, int64& v) override { auto it = ints_.find(id); if (it == ints_.end()) return kResultFalse; v = it->second; return kResultOk; }
  tresult PLUGIN_API setFloat(AttrID id, double v) override { floats_[id] = v; return kResultOk; }
  tresult PLUGIN_API getFloat(AttrID id, double& v) override { auto it = floats_.find(id); if (it == floats_.end()) return kResultFalse; v = it->second; return kResultOk; }
  tresult PLUGIN_API setString(AttrID id, const TChar* s) override {
    std::u16string v;
    for (size_t i = 0; s && s[i]; i++) v += s[i];
    strings_[id] = v;
    return kResultOk;
  }
  tresult PLUGIN_API getString(AttrID id, TChar* s, uint32 sizeInBytes) override {
    auto it = strings_.find(id);
    if (it == strings_.end() || sizeInBytes < 2) return kResultFalse;
    size_t n = std::min<size_t>(it->second.size(), sizeInBytes / 2 - 1);
    std::memcpy(s, it->second.data(), n * 2);
    s[n] = 0;
    return kResultOk;
  }
  tresult PLUGIN_API setBinary(AttrID id, const void* data, uint32 size) override {
    binaries_[id] = std::string(static_cast<const char*>(data), size);
    return kResultOk;
  }
  tresult PLUGIN_API getBinary(AttrID id, const void*& data, uint32& size) override {
    auto it = binaries_.find(id);
    if (it == binaries_.end()) return kResultFalse;
    data = it->second.data();
    size = (uint32)it->second.size();
    return kResultOk;
  }

 private:
  std::map<std::string, int64> ints_;
  std::map<std::string, double> floats_;
  std::map<std::string, std::u16string> strings_;
  std::map<std::string, std::string> binaries_;
};

class HostMessage : public IMessage {
 public:
  virtual ~HostMessage() { if (attrs_) attrs_->release(); }
  tresult PLUGIN_API queryInterface(const TUID _iid, void** obj) override {
    FL_QI(IMessage)
    FL_QI(FUnknown)
    *obj = nullptr;
    return kNoInterface;
  }
  FL_HEAP_REFCOUNT
  FIDString PLUGIN_API getMessageID() override { return id_.c_str(); }
  void PLUGIN_API setMessageID(FIDString id) override { id_ = id ? id : ""; }
  IAttributeList* PLUGIN_API getAttributes() override {
    if (!attrs_) attrs_ = new HostAttributeList();
    return attrs_;
  }

 private:
  std::string id_;
  HostAttributeList* attrs_ = nullptr;
};

// ---------------------------------------------------------------------------------------------- memory stream
class MemStream : public IBStream, public ISizeableStream {
 public:
  MemStream() {}
  explicit MemStream(const std::string& d) : data_(d) {}
  tresult PLUGIN_API queryInterface(const TUID _iid, void** obj) override {
    FL_QI(IBStream)
    FL_QI(ISizeableStream)
    if (FUnknownPrivate::iidEqual(_iid, FUnknown::iid)) { addRef(); *obj = static_cast<IBStream*>(this); return kResultOk; }
    *obj = nullptr;
    return kNoInterface;
  }
  FL_STATIC_REFCOUNT
  tresult PLUGIN_API read(void* buffer, int32 n, int32* got) override {
    int64 left = (int64)data_.size() - pos_;
    int32 k = (int32)std::max<int64>(0, std::min<int64>(n, left));
    if (k > 0) std::memcpy(buffer, data_.data() + pos_, (size_t)k);
    pos_ += k;
    if (got) *got = k;
    return kResultOk;
  }
  tresult PLUGIN_API write(void* buffer, int32 n, int32* written) override {
    if (n < 0) return kInvalidArgument;
    if ((size_t)(pos_ + n) > data_.size()) data_.resize((size_t)(pos_ + n));
    std::memcpy(&data_[(size_t)pos_], buffer, (size_t)n);
    pos_ += n;
    if (written) *written = n;
    return kResultOk;
  }
  tresult PLUGIN_API seek(int64 p, int32 mode, int64* result) override {
    int64 np = mode == kIBSeekSet ? p : mode == kIBSeekCur ? pos_ + p : (int64)data_.size() + p;
    if (np < 0) return kResultFalse;
    pos_ = np;
    if (result) *result = pos_;
    return kResultOk;
  }
  tresult PLUGIN_API tell(int64* p) override { if (p) *p = pos_; return kResultOk; }
  tresult PLUGIN_API getStreamSize(int64& size) override { size = (int64)data_.size(); return kResultOk; }
  tresult PLUGIN_API setStreamSize(int64 size) override { data_.resize((size_t)std::max<int64>(0, size)); return kResultOk; }
  const std::string& data() const { return data_; }
  void rewind() { pos_ = 0; }

 private:
  std::string data_;
  int64 pos_ = 0;
};

// ---------------------------------------------------------------------------------------------- run loop (Linux)
#ifdef __linux__
class RunLoop : public Linux::IRunLoop {
 public:
  tresult PLUGIN_API queryInterface(const TUID _iid, void** obj) override {
    FL_QI(Linux::IRunLoop)
    FL_QI(FUnknown)
    *obj = nullptr;
    return kNoInterface;
  }
  FL_STATIC_REFCOUNT
  tresult PLUGIN_API registerEventHandler(Linux::IEventHandler* h, Linux::FileDescriptor fd) override {
    if (!h) return kInvalidArgument;
    h->addRef();
    uint64_t id = plat::addFd(fd, 1, [h, fd](int) { h->onFDIsSet(fd); });
    fds_.insert({h, id});
    return kResultOk;
  }
  tresult PLUGIN_API unregisterEventHandler(Linux::IEventHandler* h) override {
    auto r = fds_.equal_range(h);
    for (auto it = r.first; it != r.second; ++it) { plat::removeFd(it->second); h->release(); }
    fds_.erase(r.first, r.second);
    return kResultOk;
  }
  tresult PLUGIN_API registerTimer(Linux::ITimerHandler* h, Linux::TimerInterval ms) override {
    if (!h) return kInvalidArgument;
    h->addRef();
    uint64_t id = plat::addTimer((int)ms, [h] { h->onTimer(); });
    timers_.insert({h, id});
    return kResultOk;
  }
  tresult PLUGIN_API unregisterTimer(Linux::ITimerHandler* h) override {
    auto r = timers_.equal_range(h);
    for (auto it = r.first; it != r.second; ++it) { plat::removeTimer(it->second); h->release(); }
    timers_.erase(r.first, r.second);
    return kResultOk;
  }

 private:
  std::multimap<Linux::IEventHandler*, uint64_t> fds_;
  std::multimap<Linux::ITimerHandler*, uint64_t> timers_;
};
RunLoop gRunLoop;
#endif

// ---------------------------------------------------------------------------------------------- host application
class HostApp : public IHostApplication, public IPlugInterfaceSupport {
 public:
  tresult PLUGIN_API queryInterface(const TUID _iid, void** obj) override {
    FL_QI(IHostApplication)
    FL_QI(IPlugInterfaceSupport)
#ifdef __linux__
    if (FUnknownPrivate::iidEqual(_iid, Linux::IRunLoop::iid)) { gRunLoop.addRef(); *obj = static_cast<Linux::IRunLoop*>(&gRunLoop); return kResultOk; }
#endif
    if (FUnknownPrivate::iidEqual(_iid, FUnknown::iid)) { addRef(); *obj = static_cast<IHostApplication*>(this); return kResultOk; }
    *obj = nullptr;
    return kNoInterface;
  }
  FL_STATIC_REFCOUNT
  tresult PLUGIN_API getName(String128 name) override { toUtf16("FL LUA", reinterpret_cast<char16_t*>(name), 128); return kResultOk; }
  tresult PLUGIN_API createInstance(TUID cid, TUID _iid, void** obj) override {
    if (FUnknownPrivate::iidEqual(cid, IMessage::iid) && FUnknownPrivate::iidEqual(_iid, IMessage::iid)) { *obj = static_cast<IMessage*>(new HostMessage()); return kResultOk; }
    if (FUnknownPrivate::iidEqual(cid, IAttributeList::iid) && FUnknownPrivate::iidEqual(_iid, IAttributeList::iid)) { *obj = static_cast<IAttributeList*>(new HostAttributeList()); return kResultOk; }
    *obj = nullptr;
    return kResultFalse;
  }
  tresult PLUGIN_API isPlugInterfaceSupported(const TUID _iid) override {
    if (FUnknownPrivate::iidEqual(_iid, IComponent::iid) || FUnknownPrivate::iidEqual(_iid, IAudioProcessor::iid) ||
        FUnknownPrivate::iidEqual(_iid, IEditController::iid) || FUnknownPrivate::iidEqual(_iid, IConnectionPoint::iid) ||
        FUnknownPrivate::iidEqual(_iid, IMidiMapping::iid) || FUnknownPrivate::iidEqual(_iid, IPlugView::iid) ||
        FUnknownPrivate::iidEqual(_iid, IPlugViewContentScaleSupport::iid))
      return kResultTrue;
    return kResultFalse;
  }
};
HostApp gHostApp;

// ---------------------------------------------------------------------------------------------- realtime lists
class ParamQueue : public IParamValueQueue {
 public:
  tresult PLUGIN_API queryInterface(const TUID _iid, void** obj) override {
    FL_QI(IParamValueQueue)
    FL_QI(FUnknown)
    *obj = nullptr;
    return kNoInterface;
  }
  FL_STATIC_REFCOUNT
  ParamID PLUGIN_API getParameterId() override { return id; }
  int32 PLUGIN_API getPointCount() override { return n; }
  tresult PLUGIN_API getPoint(int32 i, int32& offset, ParamValue& value) override {
    if (i < 0 || i >= n) return kResultFalse;
    offset = pts[i].offset; value = pts[i].value;
    return kResultOk;
  }
  tresult PLUGIN_API addPoint(int32 offset, ParamValue value, int32& index) override {
    // keep the points ordered; a point at the same offset replaces the earlier one
    int32 i = n;
    while (i > 0 && pts[i - 1].offset > offset) i--;
    if (i > 0 && pts[i - 1].offset == offset) { pts[i - 1].value = value; index = i - 1; return kResultOk; }
    if (n >= kMax) { index = n - 1; pts[n - 1] = {offset, value}; return kResultOk; }
    for (int32 k = n; k > i; k--) pts[k] = pts[k - 1];
    pts[i] = {offset, value};
    n++;
    index = i;
    return kResultOk;
  }
  static constexpr int32 kMax = 64;
  struct Pt { int32 offset; ParamValue value; };
  ParamID id = 0;
  int32 n = 0;
  Pt pts[kMax];
};

class ParamChanges : public IParameterChanges {
 public:
  tresult PLUGIN_API queryInterface(const TUID _iid, void** obj) override {
    FL_QI(IParameterChanges)
    FL_QI(FUnknown)
    *obj = nullptr;
    return kNoInterface;
  }
  FL_STATIC_REFCOUNT
  int32 PLUGIN_API getParameterCount() override { return n; }
  IParamValueQueue* PLUGIN_API getParameterData(int32 i) override { return i >= 0 && i < n ? &q[i] : nullptr; }
  IParamValueQueue* PLUGIN_API addParameterData(const ParamID& id, int32& index) override {
    for (int32 i = 0; i < n; i++) if (q[i].id == id) { index = i; return &q[i]; }
    if (n >= kMax) { index = -1; return nullptr; }
    q[n].id = id; q[n].n = 0;
    index = n;
    return &q[n++];
  }
  void clear() { n = 0; }
  void add(ParamID id, int32 offset, ParamValue v) {
    int32 idx, pi;
    if (auto* p = addParameterData(id, idx)) p->addPoint(offset, v, pi);
  }
  static constexpr int32 kMax = 512;
  int32 n = 0;
  ParamQueue q[kMax];
};

class EventList : public IEventList {
 public:
  tresult PLUGIN_API queryInterface(const TUID _iid, void** obj) override {
    FL_QI(IEventList)
    FL_QI(FUnknown)
    *obj = nullptr;
    return kNoInterface;
  }
  FL_STATIC_REFCOUNT
  int32 PLUGIN_API getEventCount() override { return n; }
  tresult PLUGIN_API getEvent(int32 i, Event& e) override {
    if (i < 0 || i >= n) return kResultFalse;
    e = ev[i];
    return kResultOk;
  }
  tresult PLUGIN_API addEvent(Event& e) override {
    if (n >= kMax) return kResultFalse;
    ev[n++] = e;
    return kResultOk;
  }
  void clear() { n = 0; }
  static constexpr int32 kMax = 1024;
  int32 n = 0;
  Event ev[kMax];
};

// ---------------------------------------------------------------------------------------------- modules
struct Module {
  mod::Library lib;
  IPluginFactory* factory = nullptr;
  std::string path;
  int refs = 0;
  void* exitFn = nullptr;
  ~Module() {
    if (factory) factory->release();
    factory = nullptr;
    if (exitFn) {
#ifdef __APPLE__
      reinterpret_cast<bool (*)()>(exitFn)();
#elif defined(_WIN32)
      reinterpret_cast<bool(PLUGIN_API*)()>(exitFn)();
#else
      reinterpret_cast<bool (*)()>(exitFn)();
#endif
    }
  }
};

std::map<std::string, std::shared_ptr<Module>> gModules;

std::string binaryPath(const std::string& path) {
  if (!mod::isDir(path)) return path;                  // a single-file plugin
#ifdef __APPLE__
  return path;                                         // the bundle itself
#elif defined(_WIN32)
  return path + "\\Contents\\x86_64-win\\" + mod::stem(path) + ".vst3";
#else
#if defined(__aarch64__)
  return path + "/Contents/aarch64-linux/" + mod::stem(path) + ".so";
#else
  return path + "/Contents/x86_64-linux/" + mod::stem(path) + ".so";
#endif
#endif
}

std::shared_ptr<Module> openModule(const std::string& path, std::string& error) {
  auto it = gModules.find(path);
  if (it != gModules.end()) return it->second;
  auto m = std::make_shared<Module>();
  m->path = path;
  std::string bin = binaryPath(path);
  if (!mod::exists(bin)) { error = "The plugin has no binary for this computer: " + bin; return nullptr; }
  if (!m->lib.open(bin, error)) return nullptr;
#ifdef __APPLE__
  if (auto entry = reinterpret_cast<bool (*)(CFBundleRef)>(m->lib.symbol("bundleEntry"))) {
    if (!entry(m->lib.bundle())) { error = "bundleEntry failed"; return nullptr; }
    m->exitFn = m->lib.symbol("bundleExit");
  }
#elif defined(_WIN32)
  if (auto entry = reinterpret_cast<bool(PLUGIN_API*)()>(m->lib.symbol("InitDll"))) {
    if (!entry()) { error = "InitDll failed"; return nullptr; }
    m->exitFn = m->lib.symbol("ExitDll");
  }
#else
  if (auto entry = reinterpret_cast<bool (*)(void*)>(m->lib.symbol("ModuleEntry"))) {
    if (!entry(m->lib.handle())) { error = "ModuleEntry failed"; return nullptr; }
    m->exitFn = m->lib.symbol("ModuleExit");
  }
#endif
  auto get = reinterpret_cast<IPluginFactory*(PLUGIN_API*)()>(m->lib.symbol("GetPluginFactory"));
  if (!get) { error = "Not a VST3 plugin (no GetPluginFactory)"; return nullptr; }
  m->factory = get();
  if (!m->factory) { error = "The plugin returned no factory"; return nullptr; }
  IPluginFactory3* f3 = nullptr;
  if (m->factory->queryInterface(IPluginFactory3::iid, (void**)&f3) == kResultOk && f3) {
    f3->setHostContext(static_cast<IHostApplication*>(&gHostApp));
    f3->release();
  }
  gModules[path] = m;
  return m;
}

void dropModule(const std::string& path) {
  auto it = gModules.find(path);
  if (it != gModules.end() && --it->second->refs <= 0) gModules.erase(it);
}

std::vector<ClassInfo> classesOf(IPluginFactory* f, const std::string& path) {
  std::vector<ClassInfo> out;
  PFactoryInfo fi{};
  f->getFactoryInfo(&fi);
  IPluginFactory2* f2 = nullptr;
  f->queryInterface(IPluginFactory2::iid, (void**)&f2);
  int32 n = f->countClasses();
  for (int32 i = 0; i < n; i++) {
    PClassInfo ci{};
    if (f->getClassInfo(i, &ci) != kResultOk) continue;
    if (std::strcmp(ci.category, kVstAudioEffectClass) != 0) continue;
    ClassInfo c;
    c.format = "vst3";
    c.path = path;
    c.uid = uidString(ci.cid);
    c.name = trimNul(ci.name, sizeof ci.name);
    c.vendor = trimNul(fi.vendor, sizeof fi.vendor);
    PClassInfo2 c2{};
    if (f2 && f2->getClassInfo2(i, &c2) == kResultOk) {
      std::string sub = trimNul(c2.subCategories, sizeof c2.subCategories);
      c.category = sub;
      c.instrument = sub.find("Instrument") != std::string::npos;
      std::string v = trimNul(c2.vendor, sizeof c2.vendor);
      if (!v.empty()) c.vendor = v;
      c.version = trimNul(c2.version, sizeof c2.version);
    }
    out.push_back(c);
  }
  if (f2) f2->release();
  return out;
}

// moduleinfo.json (VST 3.7+) describes the classes without loading the binary
std::vector<ClassInfo> classesFromModuleInfo(const std::string& path) {
  std::vector<ClassInfo> out;
  if (!mod::isDir(path)) return out;
  std::string text = mod::readFile(path + "/Contents/Resources/moduleinfo.json");
  json::Value v;
  if (text.empty() || !json::parse(text, v)) return out;
  std::string vendor = v["Factory Info"]["Vendor"].str();
  for (auto& c : v["Classes"].a) {
    if (c["Category"].str() != kVstAudioEffectClass) continue;
    ClassInfo ci;
    ci.format = "vst3";
    ci.path = path;
    ci.uid = c["CID"].str();
    ci.name = c["Name"].str();
    ci.vendor = c["Vendor"].str(vendor);
    if (ci.vendor.empty()) ci.vendor = vendor;
    ci.version = c["Version"].str();
    std::string sub;
    for (auto& s : c["Sub Categories"].a) { if (!sub.empty()) sub += "|"; sub += s.str(); }
    ci.category = sub;
    ci.instrument = sub.find("Instrument") != std::string::npos;
    if (ci.uid.size() == 32) out.push_back(ci);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------- the plugin
class Vst3Plugin;

class ComponentHandler : public IComponentHandler, public IComponentHandler2 {
 public:
  explicit ComponentHandler(Vst3Plugin* p) : p_(p) {}
  tresult PLUGIN_API queryInterface(const TUID _iid, void** obj) override {
    FL_QI(IComponentHandler)
    FL_QI(IComponentHandler2)
    if (FUnknownPrivate::iidEqual(_iid, FUnknown::iid)) { addRef(); *obj = static_cast<IComponentHandler*>(this); return kResultOk; }
    *obj = nullptr;
    return kNoInterface;
  }
  FL_STATIC_REFCOUNT
  tresult PLUGIN_API beginEdit(ParamID) override { return kResultOk; }
  tresult PLUGIN_API performEdit(ParamID id, ParamValue v) override;
  tresult PLUGIN_API endEdit(ParamID) override { return kResultOk; }
  tresult PLUGIN_API restartComponent(int32 flags) override;
  tresult PLUGIN_API setDirty(TBool) override;
  tresult PLUGIN_API requestOpenEditor(FIDString) override { return kResultFalse; }
  tresult PLUGIN_API startGroupEdit() override { return kResultOk; }
  tresult PLUGIN_API finishGroupEdit() override { return kResultOk; }

 private:
  Vst3Plugin* p_;
};

class PlugFrame : public IPlugFrame {
 public:
  explicit PlugFrame(Vst3Plugin* p) : p_(p) {}
  tresult PLUGIN_API queryInterface(const TUID _iid, void** obj) override {
    FL_QI(IPlugFrame)
#ifdef __linux__
    if (FUnknownPrivate::iidEqual(_iid, Linux::IRunLoop::iid)) { gRunLoop.addRef(); *obj = static_cast<Linux::IRunLoop*>(&gRunLoop); return kResultOk; }
#endif
    FL_QI(FUnknown)
    *obj = nullptr;
    return kNoInterface;
  }
  FL_STATIC_REFCOUNT
  tresult PLUGIN_API resizeView(IPlugView* view, ViewRect* r) override;

 private:
  Vst3Plugin* p_;
};

class Vst3Plugin : public Plugin {
 public:
  Vst3Plugin() : handler_(this), frame_(this) {}
  ~Vst3Plugin() override {
    closeEditor();
    deactivate();
    if (ctrl_) ctrl_->setComponentHandler(nullptr);
    if (cpComp_ && cpCtrl_) { cpComp_->disconnect(cpCtrl_); cpCtrl_->disconnect(cpComp_); }
    if (cpComp_) cpComp_->release();
    if (cpCtrl_) cpCtrl_->release();
    if (midi_) midi_->release();
    if (proc_) proc_->release();
    if (ctrl_) { if (separate_) ctrl_->terminate(); ctrl_->release(); }
    if (comp_) { comp_->terminate(); comp_->release(); }
    if (module_) { module_.reset(); dropModule(info.path); }
  }

  bool init(std::shared_ptr<Module> m, const std::string& uid, std::string& error) {
    module_ = m;
    m->refs++;
    TUID cid;
    if (!uidFromString(uid, cid)) { error = "Bad class id"; return false; }
    for (auto& c : classesOf(m->factory, m->path)) if (c.uid == uid) info = c;
    if (info.uid.empty()) { error = "The plugin file has no class " + uid; return false; }
    if (m->factory->createInstance(cid, IComponent::iid, (void**)&comp_) != kResultOk || !comp_) { error = "Could not create the plugin"; return false; }
    if (comp_->initialize(static_cast<IHostApplication*>(&gHostApp)) != kResultOk) { error = "The plugin did not initialize"; return false; }
    if (comp_->queryInterface(IEditController::iid, (void**)&ctrl_) != kResultOk) {
      ctrl_ = nullptr;
      TUID ccid;
      if (comp_->getControllerClassId(ccid) == kResultOk && m->factory->createInstance(ccid, IEditController::iid, (void**)&ctrl_) == kResultOk && ctrl_) {
        if (ctrl_->initialize(static_cast<IHostApplication*>(&gHostApp)) != kResultOk) { ctrl_->release(); ctrl_ = nullptr; }
        else separate_ = true;
      }
    }
    if (comp_->queryInterface(IAudioProcessor::iid, (void**)&proc_) != kResultOk || !proc_) { error = "The plugin has no audio processor"; return false; }
    if (separate_) {
      comp_->queryInterface(IConnectionPoint::iid, (void**)&cpComp_);
      ctrl_->queryInterface(IConnectionPoint::iid, (void**)&cpCtrl_);
      if (cpComp_ && cpCtrl_) { cpComp_->connect(cpCtrl_); cpCtrl_->connect(cpComp_); }
    }
    if (ctrl_) {
      MemStream s;
      if (comp_->getState(&s) == kResultOk) { s.rewind(); ctrl_->setComponentState(&s); }
      ctrl_->setComponentHandler(&handler_);
      ctrl_->queryInterface(IMidiMapping::iid, (void**)&midi_);
    }
    setupBuses();
    mapMidi();
    return true;
  }

  // ------------------------------------------------------------------ buses
  void setupBuses() {
    nIn_ = comp_->getBusCount(kAudio, kInput);
    nOut_ = comp_->getBusCount(kAudio, kOutput);
    int32 nEv = comp_->getBusCount(kEvent, kInput);
    std::vector<SpeakerArrangement> ins((size_t)nIn_), outs((size_t)nOut_);
    for (int32 i = 0; i < nIn_; i++) { proc_->getBusArrangement(kInput, i, ins[(size_t)i]); }
    for (int32 i = 0; i < nOut_; i++) { proc_->getBusArrangement(kOutput, i, outs[(size_t)i]); }
    if (nIn_ > 0) ins[0] = SpeakerArr::kStereo;
    if (nOut_ > 0) outs[0] = SpeakerArr::kStereo;
    if (proc_->setBusArrangements(ins.data(), nIn_, outs.data(), nOut_) != kResultTrue) {
      for (int32 i = 0; i < nIn_; i++) proc_->getBusArrangement(kInput, i, ins[(size_t)i]);
      for (int32 i = 0; i < nOut_; i++) proc_->getBusArrangement(kOutput, i, outs[(size_t)i]);
    }
    for (int32 i = 0; i < nIn_; i++) comp_->activateBus(kAudio, kInput, i, i == 0);
    for (int32 i = 0; i < nOut_; i++) comp_->activateBus(kAudio, kOutput, i, i == 0);
    for (int32 i = 0; i < nEv; i++) comp_->activateBus(kEvent, kInput, i, i == 0);
    hasEvents_ = nEv > 0;
    inBufs_.assign((size_t)nIn_, AudioBusBuffers{});
    outBufs_.assign((size_t)nOut_, AudioBusBuffers{});
    size_t ch = 0;
    for (int32 i = 0; i < nIn_; i++) { inBufs_[(size_t)i].numChannels = SpeakerArr::getChannelCount(ins[(size_t)i]); ch += (size_t)inBufs_[(size_t)i].numChannels; }
    for (int32 i = 0; i < nOut_; i++) { outBufs_[(size_t)i].numChannels = SpeakerArr::getChannelCount(outs[(size_t)i]); ch += (size_t)outBufs_[(size_t)i].numChannels; }
    scratch_.assign(ch * fl::MAX_FRAMES, 0.f);
    ptrs_.assign(ch, nullptr);
    size_t k = 0;
    for (int32 i = 0; i < nIn_; i++) { inBufs_[(size_t)i].channelBuffers32 = &ptrs_[k]; for (int32 c = 0; c < inBufs_[(size_t)i].numChannels; c++, k++) ptrs_[k] = &scratch_[k * fl::MAX_FRAMES]; }
    for (int32 i = 0; i < nOut_; i++) { outBufs_[(size_t)i].channelBuffers32 = &ptrs_[k]; for (int32 c = 0; c < outBufs_[(size_t)i].numChannels; c++, k++) ptrs_[k] = &scratch_[k * fl::MAX_FRAMES]; }
    hasInput = nIn_ > 0 && inBufs_[0].numChannels > 0;
    outChannels = nOut_ > 0 ? outBufs_[0].numChannels : 0;
  }

  void mapMidi() {
    std::memset(ccMap_, 0xff, sizeof ccMap_);
    if (!midi_) return;
    for (int ch = 0; ch < 16; ch++)
      for (int cc = 0; cc < 130; cc++) {
        ParamID id;
        if (midi_->getMidiControllerAssignment(0, (int16)ch, (CtrlNumber)cc, id) == kResultTrue) ccMap_[ch][cc] = id;
      }
  }

  // ------------------------------------------------------------------ lifecycle
  bool activate(double sr, int maxFrames) override {
    if (active_) deactivate();
    ProcessSetup ps{kRealtime, kSample32, maxFrames, sr};
    if (proc_->canProcessSampleSize(kSample32) != kResultTrue) return false;
    if (proc_->setupProcessing(ps) != kResultOk) return false;
    if (comp_->setActive(true) != kResultOk) return false;
    sr_ = sr;
    active_ = true;
    return true;
  }
  void deactivate() override {
    if (!active_) return;
    stopProcessing();
    comp_->setActive(false);
    active_ = false;
  }
  void stopProcessing() override {
    if (processing_) { proc_->setProcessing(false); processing_ = false; }
  }

  // ------------------------------------------------------------------ parameters
  std::vector<ParamInfo> params() override {
    std::vector<ParamInfo> out;
    if (!ctrl_) return out;
    int32 n = ctrl_->getParameterCount();
    for (int32 i = 0; i < n; i++) {
      ParameterInfo pi{};
      if (ctrl_->getParameterInfo(i, pi) != kResultOk) continue;
      ParamInfo p;
      p.id = pi.id;
      p.name = utf8(reinterpret_cast<const char16_t*>(pi.title), 128);
      p.unit = utf8(reinterpret_cast<const char16_t*>(pi.units), 128);
      p.def = pi.defaultNormalizedValue;
      p.steps = pi.stepCount;
      p.automatable = (pi.flags & ParameterInfo::kCanAutomate) != 0;
      p.readOnly = (pi.flags & ParameterInfo::kIsReadOnly) != 0;
      p.hidden = (pi.flags & ParameterInfo::kIsHidden) != 0;
      p.bypass = (pi.flags & ParameterInfo::kIsBypass) != 0;
      out.push_back(p);
    }
    return out;
  }
  double paramValue(uint32_t id) override { return ctrl_ ? ctrl_->getParamNormalized(id) : 0; }
  std::string paramText(uint32_t id, double v) override {
    if (!ctrl_) return "";
    String128 s{};
    if (ctrl_->getParamStringByValue(id, v, s) != kResultOk) return "";
    return utf8(reinterpret_cast<const char16_t*>(s), 128);
  }
  void setParamFromHost(uint32_t id, double v) override { if (ctrl_) ctrl_->setParamNormalized(id, v); }

  // from the editor (main thread)
  void editorEdit(ParamID id, ParamValue v) {
    toAudio_.push({id, v});
    if (events.paramFromEditor) events.paramFromEditor(id, v);
  }

  // ------------------------------------------------------------------ state
  bool saveState(std::string& out) override {
    MemStream a, b;
    if (comp_->getState(&a) != kResultOk) return false;
    if (ctrl_ && separate_) ctrl_->getState(&b);
    else if (ctrl_) ctrl_->getState(&b);
    out = "FLV3";
    auto put = [&](const std::string& s) { uint32_t n = (uint32_t)s.size(); out.append(reinterpret_cast<const char*>(&n), 4); out += s; };
    put(a.data());
    put(b.data());
    return true;
  }
  bool loadState(const std::string& d) override {
    if (d.size() < 8 || d.compare(0, 4, "FLV3") != 0) return false;
    size_t p = 4;
    auto get = [&](std::string& s) { if (p + 4 > d.size()) return false; uint32_t n; std::memcpy(&n, d.data() + p, 4); p += 4; if (p + n > d.size()) return false; s = d.substr(p, n); p += n; return true; };
    std::string a, b;
    if (!get(a) || !get(b)) return false;
    MemStream sa(a);
    if (comp_->setState(&sa) != kResultOk) return false;
    if (ctrl_) {
      MemStream sc(a);
      ctrl_->setComponentState(&sc);
      if (!b.empty()) { MemStream sb(b); ctrl_->setState(&sb); }
    }
    return true;
  }

  uint32_t latency() override { return proc_ ? proc_->getLatencySamples() : 0; }

  // ------------------------------------------------------------------ editor
  bool hasEditor() override {
    if (!ctrl_) return false;
    if (hasEditor_ < 0) {
      IPlugView* v = ctrl_->createView(ViewType::kEditor);
      hasEditor_ = v && v->isPlatformTypeSupported(plat::vst3PlatformType()) == kResultTrue ? 1 : 0;
      if (v) v->release();
    }
    return hasEditor_ == 1;
  }
  bool openEditor(const std::string& title, uint64_t owner) override {
    if (view_) { plat::show(win_); return true; }
    if (!ctrl_) return false;
    view_ = ctrl_->createView(ViewType::kEditor);
    if (!view_) return false;
    if (view_->isPlatformTypeSupported(plat::vst3PlatformType()) != kResultTrue) { view_->release(); view_ = nullptr; return false; }
    view_->setFrame(&frame_);
    ViewRect r{};
    view_->getSize(&r);
    bool resizable = view_->canResize() == kResultTrue;
    win_ = plat::createWindow(title, std::max(1, r.getWidth()), std::max(1, r.getHeight()), resizable, owner,
                              {[this] { closeEditor(); if (events.editorClosed) events.editorClosed(); },
                               [this](int w, int h) { windowResized(w, h); }});
    if (!win_) { view_->release(); view_ = nullptr; return false; }
    IPlugViewContentScaleSupport* sc = nullptr;
    if (view_->queryInterface(IPlugViewContentScaleSupport::iid, (void**)&sc) == kResultOk && sc) {
      sc->setContentScaleFactor((IPlugViewContentScaleSupport::ScaleFactor)plat::scaleFactor(win_));
      sc->release();
    }
    if (view_->attached(plat::nativeHandle(win_), plat::vst3PlatformType()) != kResultOk) {
      view_->release(); view_ = nullptr;
      plat::destroyWindow(win_); win_ = nullptr;
      return false;
    }
    // the size may change once attached
    ViewRect r2{};
    if (view_->getSize(&r2) == kResultOk && (r2.getWidth() != r.getWidth() || r2.getHeight() != r.getHeight())) plat::setContentSize(win_, r2.getWidth(), r2.getHeight());
    plat::show(win_);
    return true;
  }
  void closeEditor() override {
    if (view_) { view_->removed(); view_->setFrame(nullptr); view_->release(); view_ = nullptr; }
    if (win_) { plat::destroyWindow(win_); win_ = nullptr; }
  }
  bool editorOpen() override { return view_ != nullptr; }

  tresult resizeFromPlugin(IPlugView* view, ViewRect* r) {
    if (!r || !win_ || view != view_) return kInvalidArgument;
    resizing_ = true;
    plat::setContentSize(win_, r->getWidth(), r->getHeight());
    resizing_ = false;
    view_->onSize(r);
    return kResultTrue;
  }
  void windowResized(int w, int h) {
    if (!view_ || resizing_) return;
    ViewRect r(0, 0, w, h);
    if (view_->canResize() == kResultTrue) {
      view_->checkSizeConstraint(&r);
      if (r.getWidth() != w || r.getHeight() != h) { resizing_ = true; plat::setContentSize(win_, r.getWidth(), r.getHeight()); resizing_ = false; }
      view_->onSize(&r);
    }
  }

  void idle() override {
    // parameter values from automation and from the processor reach the controller (and so the editor);
    // only the last value of each parameter matters
    ParamValueMsg m;
    std::map<ParamID, ParamValue> last;
    while (toMain_.pop(m)) last[m.id] = m.value;
    if (ctrl_) for (auto& kv : last) ctrl_->setParamNormalized(kv.first, kv.second);
  }

  void restart(int32 flags) {
    if (flags & (kReloadComponent | kIoChanged | kLatencyChanged)) {
      if (active_) { double sr = sr_; deactivate(); if (flags & kIoChanged) setupBuses(); activate(sr, fl::MAX_FRAMES); }
      if ((flags & kLatencyChanged) && events.latencyChanged) events.latencyChanged();
    }
    if (flags & (kParamValuesChanged | kParamTitlesChanged)) { if (events.paramsChanged) events.paramsChanged(); }
    if (flags & kMidiCCAssignmentChanged) mapMidi();
  }

  // ------------------------------------------------------------------ audio
  void process(const fl::Frame& f, fl::Slot& s) override {
    uint32_t frames = std::min<uint32_t>(f.frames, fl::MAX_FRAMES);
    if (!active_) { std::memset(s.out, 0, sizeof s.out); return; }
    if (!processing_) { proc_->setProcessing(true); processing_ = true; }
    events_.clear();
    inParams_.clear();
    outParams_.clear();
    ParamValueMsg m;
    while (toAudio_.pop(m)) inParams_.add(m.id, 0, m.value);
    for (uint32_t i = 0; i < s.nEvents && i < (uint32_t)fl::MAX_EVENTS; i++) {
      const fl::Event& e = s.events[i];
      int32 off = (int32)std::min<uint32_t>(e.offset, frames ? frames - 1 : 0);
      Event ev{};
      ev.busIndex = 0;
      ev.sampleOffset = off;
      ev.flags = Event::kIsLive;
      int ch = e.channel & 15;
      switch (e.type) {
        case fl::EV_NOTE_ON:
          ev.type = Event::kNoteOnEvent;
          ev.noteOn = {(int16)ch, (int16)e.key, 0.f, (float)e.value, 0, e.noteId};
          held_[ch][e.key] = true;
          if (hasEvents_) events_.addEvent(ev);
          break;
        case fl::EV_NOTE_OFF:
          ev.type = Event::kNoteOffEvent;
          ev.noteOff = {(int16)ch, (int16)e.key, (float)e.value, e.noteId, 0.f};
          held_[ch][e.key] = false;
          if (hasEvents_) events_.addEvent(ev);
          break;
        case fl::EV_POLY_PRESSURE:
          ev.type = Event::kPolyPressureEvent;
          ev.polyPressure = {(int16)ch, (int16)e.key, (float)e.value, e.noteId};
          if (hasEvents_) events_.addEvent(ev);
          break;
        case fl::EV_CC: if (e.key < 128 && ccMap_[ch][e.key] != 0xffffffff) inParams_.add(ccMap_[ch][e.key], off, e.value); break;
        case fl::EV_CHAN_PRESSURE: if (ccMap_[ch][kAfterTouch] != 0xffffffff) inParams_.add(ccMap_[ch][kAfterTouch], off, e.value); break;
        case fl::EV_PITCH: if (ccMap_[ch][kPitchBend] != 0xffffffff) inParams_.add(ccMap_[ch][kPitchBend], off, (e.value + 1) * 0.5); break;
        case fl::EV_PARAM:
          inParams_.add(e.param, off, e.value);
          toMain_.push({e.param, e.value});
          break;
        case fl::EV_ALL_OFF:
          for (int c = 0; c < 16; c++)
            for (int k = 0; k < 128; k++)
              if (held_[c][k]) {
                Event o{};
                o.sampleOffset = off; o.flags = Event::kIsLive; o.type = Event::kNoteOffEvent;
                o.noteOff = {(int16)c, (int16)k, 0.f, -1, 0.f};
                held_[c][k] = false;
                if (hasEvents_) events_.addEvent(o);
              }
          break;
      }
    }
    // audio buffers
    for (size_t i = 0; i < inBufs_.size(); i++) {
      inBufs_[i].silenceFlags = 0;
      for (int32 c = 0; c < inBufs_[i].numChannels; c++) {
        float* d = inBufs_[i].channelBuffers32[c];
        if (i == 0 && hasInput) std::memcpy(d, s.in[std::min(c, 1)], frames * sizeof(float));
        else std::memset(d, 0, frames * sizeof(float));
      }
    }
    for (auto& b : outBufs_) for (int32 c = 0; c < b.numChannels; c++) std::memset(b.channelBuffers32[c], 0, frames * sizeof(float));
    ctx_ = ProcessContext{};
    ctx_.state = ProcessContext::kTempoValid | ProcessContext::kTimeSigValid | ProcessContext::kProjectTimeMusicValid | ProcessContext::kBarPositionValid;
    if (f.flags & fl::FRAME_PLAYING) ctx_.state |= ProcessContext::kPlaying;
    if (f.flags & fl::FRAME_LOOP) { ctx_.state |= ProcessContext::kCycleActive | ProcessContext::kCycleValid; ctx_.cycleStartMusic = f.loopStartPpq; ctx_.cycleEndMusic = f.loopEndPpq; }
    ctx_.sampleRate = sr_;
    ctx_.projectTimeSamples = (TSamples)f.samplePos;
    ctx_.projectTimeMusic = f.ppq;
    ctx_.barPositionMusic = f.barPpq;
    ctx_.tempo = f.tempo > 0 ? f.tempo : 120;
    ctx_.timeSigNumerator = (int32)(f.tsNum ? f.tsNum : 4);
    ctx_.timeSigDenominator = (int32)(f.tsDen ? f.tsDen : 4);
    ProcessData d{};
    d.processMode = (f.flags & fl::FRAME_OFFLINE) ? kOffline : kRealtime;
    d.symbolicSampleSize = kSample32;
    d.numSamples = (int32)frames;
    d.numInputs = nIn_;
    d.numOutputs = nOut_;
    d.inputs = inBufs_.empty() ? nullptr : inBufs_.data();
    d.outputs = outBufs_.empty() ? nullptr : outBufs_.data();
    d.inputParameterChanges = &inParams_;
    d.outputParameterChanges = &outParams_;
    d.inputEvents = hasEvents_ ? &events_ : nullptr;
    d.outputEvents = nullptr;
    d.processContext = &ctx_;
    proc_->process(d);
    // main output bus → slot (mono plugins on both sides)
    if (nOut_ > 0 && outBufs_[0].numChannels > 0) {
      float** o = outBufs_[0].channelBuffers32;
      std::memcpy(s.out[0], o[0], frames * sizeof(float));
      std::memcpy(s.out[1], o[outBufs_[0].numChannels > 1 ? 1 : 0], frames * sizeof(float));
    } else std::memset(s.out, 0, sizeof s.out);
    // parameter output (meters, the plugin moving its own knobs) reaches the controller
    for (int32 i = 0; i < outParams_.n; i++) {
      auto& q = outParams_.q[i];
      if (q.n) toMain_.push({q.id, q.pts[q.n - 1].value});
    }
  }

 private:
  struct ParamValueMsg { ParamID id; ParamValue value; };
  std::shared_ptr<Module> module_;
  IComponent* comp_ = nullptr;
  IAudioProcessor* proc_ = nullptr;
  IEditController* ctrl_ = nullptr;
  IMidiMapping* midi_ = nullptr;
  IConnectionPoint* cpComp_ = nullptr;
  IConnectionPoint* cpCtrl_ = nullptr;
  bool separate_ = false;
  ComponentHandler handler_;
  PlugFrame frame_;
  IPlugView* view_ = nullptr;
  plat::Window* win_ = nullptr;
  bool resizing_ = false;
  int hasEditor_ = -1;
  int32 nIn_ = 0, nOut_ = 0;
  bool hasEvents_ = false;
  std::vector<AudioBusBuffers> inBufs_, outBufs_;
  std::vector<float> scratch_;
  std::vector<float*> ptrs_;
  ParamID ccMap_[16][130];
  bool held_[16][128] = {};
  double sr_ = 48000;
  bool active_ = false;
  bool processing_ = false;
  EventList events_;
  ParamChanges inParams_, outParams_;
  ProcessContext ctx_{};
  SpscQueue<ParamValueMsg, 4096> toAudio_, toMain_;
};

tresult PLUGIN_API ComponentHandler::performEdit(ParamID id, ParamValue v) {
  if (plat::isMainThread()) p_->editorEdit(id, v);
  else { Vst3Plugin* p = p_; plat::post([p, id, v] { p->editorEdit(id, v); }); }
  return kResultOk;
}
tresult PLUGIN_API ComponentHandler::restartComponent(int32 flags) {
  Vst3Plugin* p = p_;
  plat::post([p, flags] { p->restart(flags); });
  return kResultOk;
}
tresult PLUGIN_API ComponentHandler::setDirty(TBool) {
  Vst3Plugin* p = p_;
  plat::post([p] { if (p->events.dirty) p->events.dirty(); });
  return kResultOk;
}
tresult PLUGIN_API PlugFrame::resizeView(IPlugView* view, ViewRect* r) { return p_->resizeFromPlugin(view, r); }

}  // namespace

std::vector<ClassInfo> scanVst3(const std::string& path, std::string& error) {
  auto fromInfo = classesFromModuleInfo(path);
  if (!fromInfo.empty()) return fromInfo;
  auto m = openModule(path, error);
  if (!m) return {};
  auto out = classesOf(m->factory, path);
  if (out.empty()) error = "No audio classes in this VST3 file";
  return out;
}

std::unique_ptr<Plugin> loadVst3(const std::string& path, const std::string& uid, std::string& error) {
  auto m = openModule(path, error);
  if (!m) return nullptr;
  auto p = std::make_unique<Vst3Plugin>();
  if (!p->init(m, uid, error)) return nullptr;
  return p;
}
