// CLAP plugins (free-audio/clap, MIT): entry and factory, host extensions (log, thread-check, params, state, latency,
// gui, timer-support, posix-fd-support, audio-ports, note-ports), realtime processing with note / MIDI / parameter
// events, parameter output from the plugin's editor, state, and the editor embedded in a host window.
#include <algorithm>
#include <cmath>
#include <cstring>
#include <map>
#include <memory>
#include <set>
#include <vector>

#include <clap/clap.h>

#include "module.h"
#include "platform.h"
#include "plugin.h"
#include "util.h"

namespace {

struct ClapModule {
  mod::Library lib;
  const clap_plugin_entry_t* entry = nullptr;
  const clap_plugin_factory_t* factory = nullptr;
  std::string path;
  int refs = 0;
  ~ClapModule() { if (entry) entry->deinit(); }
};
std::map<std::string, std::shared_ptr<ClapModule>> gModules;

std::string binaryPath(const std::string& path) {
#ifdef __APPLE__
  return path;                    // the bundle
#else
  // the .clap file is the library on Windows and Linux; some are a folder holding <name>.clap next to resources
  if (mod::isDir(path)) {
    std::string inner = path + (path.back() == '/' || path.back() == '\\' ? "" : "/") + mod::stem(path) + ".clap";
    if (mod::exists(inner)) return inner;
  }
  return path;
#endif
}

std::shared_ptr<ClapModule> openModule(const std::string& path, std::string& error) {
  auto it = gModules.find(path);
  if (it != gModules.end()) return it->second;
  auto m = std::make_shared<ClapModule>();
  m->path = path;
  if (!m->lib.open(binaryPath(path), error)) return nullptr;
  m->entry = reinterpret_cast<const clap_plugin_entry_t*>(m->lib.symbol("clap_entry"));
  if (!m->entry) { error = "Not a CLAP plugin (no clap_entry)"; return nullptr; }
  if (!clap_version_is_compatible(m->entry->clap_version)) { error = "Unsupported CLAP version"; m->entry = nullptr; return nullptr; }
  if (!m->entry->init(path.c_str())) { error = "The plugin did not initialize"; m->entry = nullptr; return nullptr; }
  m->factory = static_cast<const clap_plugin_factory_t*>(m->entry->get_factory(CLAP_PLUGIN_FACTORY_ID));
  if (!m->factory) { error = "The plugin has no plugin factory"; return nullptr; }
  gModules[path] = m;
  return m;
}

void dropModule(const std::string& path) {
  auto it = gModules.find(path);
  if (it != gModules.end() && --it->second->refs <= 0) gModules.erase(it);
}

ClassInfo infoOf(const clap_plugin_descriptor_t* d, const std::string& path) {
  ClassInfo c;
  c.format = "clap";
  c.path = path;
  c.uid = d->id ? d->id : "";
  c.name = d->name ? d->name : c.uid;
  c.vendor = d->vendor ? d->vendor : "";
  c.version = d->version ? d->version : "";
  std::string cat;
  for (auto f = d->features; f && *f; f++) {
    if (!cat.empty()) cat += "|";
    cat += *f;
    if (std::strcmp(*f, CLAP_PLUGIN_FEATURE_INSTRUMENT) == 0) c.instrument = true;
  }
  c.category = cat;
  return c;
}

// ---------------------------------------------------------------------------------------------- event lists
struct InEvents {
  clap_input_events_t api{};
  std::vector<const clap_event_header_t*> list;
  // storage for the events of one block
  std::vector<clap_event_note_t> notes;
  std::vector<clap_event_midi_t> midi;
  std::vector<clap_event_param_value_t> params;
  InEvents() {
    api.ctx = this;
    api.size = [](const clap_input_events_t* l) -> uint32_t { return (uint32_t) static_cast<InEvents*>(l->ctx)->list.size(); };
    api.get = [](const clap_input_events_t* l, uint32_t i) -> const clap_event_header_t* {
      auto* e = static_cast<InEvents*>(l->ctx);
      return i < e->list.size() ? e->list[i] : nullptr;
    };
    notes.reserve(1024); midi.reserve(1024); params.reserve(2048); list.reserve(4096);
  }
  void clear() { list.clear(); notes.clear(); midi.clear(); params.clear(); }
  // events must be in time order; the slot's events already are, parameters from the editor come first
  void sort() { std::stable_sort(list.begin(), list.end(), [](const clap_event_header_t* a, const clap_event_header_t* b) { return a->time < b->time; }); }
};

struct OutEvents {
  clap_output_events_t api{};
  SpscQueue<ParamMsg, 4096>* toMain = nullptr;
  OutEvents() {
    api.ctx = this;
    api.try_push = [](const clap_output_events_t* l, const clap_event_header_t* e) -> bool {
      auto* o = static_cast<OutEvents*>(l->ctx);
      if (e->space_id == CLAP_CORE_EVENT_SPACE_ID && e->type == CLAP_EVENT_PARAM_VALUE && o->toMain) {
        auto* p = reinterpret_cast<const clap_event_param_value_t*>(e);
        o->toMain->push({p->param_id, p->value});
      }
      return true;
    };
  }
};

struct IStream {
  clap_istream_t api{};
  const std::string* data;
  size_t pos = 0;
  explicit IStream(const std::string& d) : data(&d) {
    api.ctx = this;
    api.read = [](const clap_istream_t* s, void* buf, uint64_t size) -> int64_t {
      auto* me = static_cast<IStream*>(s->ctx);
      size_t n = (size_t)std::min<uint64_t>(size, me->data->size() - me->pos);
      std::memcpy(buf, me->data->data() + me->pos, n);
      me->pos += n;
      return (int64_t)n;
    };
  }
};
struct OStream {
  clap_ostream_t api{};
  std::string data;
  OStream() {
    api.ctx = this;
    api.write = [](const clap_ostream_t* s, const void* buf, uint64_t size) -> int64_t {
      static_cast<OStream*>(s->ctx)->data.append(static_cast<const char*>(buf), (size_t)size);
      return (int64_t)size;
    };
  }
};

// ---------------------------------------------------------------------------------------------- the plugin
class ClapPlugin : public Plugin {
 public:
  ClapPlugin() {
    host_.clap_version = CLAP_VERSION;
    host_.host_data = this;
    host_.name = "FL LUA";
    host_.vendor = "FL LUA";
    host_.url = "https://github.com/gghub433/FL-STUD-LUA";
    host_.version = "0.8.0";
    host_.get_extension = [](const clap_host_t* h, const char* id) -> const void* { return self(h)->hostExtension(id); };
    host_.request_restart = [](const clap_host_t* h) { auto* p = self(h); plat::post([p] { p->restartRequested(); }); };
    host_.request_process = [](const clap_host_t*) {};
    host_.request_callback = [](const clap_host_t* h) { auto* p = self(h); plat::post([p] { if (p->plugin_) p->plugin_->on_main_thread(p->plugin_); }); };

    log_.log = [](const clap_host_t* h, clap_log_severity s, const char* msg) {
      if (s >= CLAP_LOG_WARNING && msg) { auto* p = self(h); std::string m = msg; plat::post([p, m] { if (p->events.log) p->events.log(m); }); }
    };
    threadCheck_.is_main_thread = [](const clap_host_t*) { return plat::isMainThread(); };
    threadCheck_.is_audio_thread = [](const clap_host_t*) { return isAudioThread(); };
    params_.rescan = [](const clap_host_t* h, clap_param_rescan_flags) { auto* p = self(h); if (p->events.paramsChanged) p->events.paramsChanged(); };
    params_.clear = [](const clap_host_t*, clap_id, clap_param_clear_flags) {};
    params_.request_flush = [](const clap_host_t* h) { self(h)->flushRequested_ = true; };
    state_.mark_dirty = [](const clap_host_t* h) { auto* p = self(h); plat::post([p] { if (p->events.dirty) p->events.dirty(); }); };
    latency_.changed = [](const clap_host_t* h) { auto* p = self(h); plat::post([p] { if (p->events.latencyChanged) p->events.latencyChanged(); }); };
    gui_.resize_hints_changed = [](const clap_host_t*) {};
    gui_.request_resize = [](const clap_host_t* h, uint32_t w, uint32_t hh) -> bool {
      auto* p = self(h);
      if (!plat::isMainThread()) { plat::post([p, w, hh] { p->resizeFromPlugin(w, hh); }); return true; }
      return p->resizeFromPlugin(w, hh);
    };
    gui_.request_show = [](const clap_host_t* h) -> bool { auto* p = self(h); if (p->win_) plat::show(p->win_); return true; };
    gui_.request_hide = [](const clap_host_t* h) -> bool { auto* p = self(h); if (p->win_) plat::hide(p->win_); return true; };
    gui_.closed = [](const clap_host_t* h, bool) { auto* p = self(h); plat::post([p] { p->closeEditor(); if (p->events.editorClosed) p->events.editorClosed(); }); };
    timers_.register_timer = [](const clap_host_t* h, uint32_t ms, clap_id* id) -> bool {
      auto* p = self(h);
      clap_id tid = p->nextTimer_++;
      uint64_t t = plat::addTimer((int)std::max<uint32_t>(ms, 5), [p, tid] { if (p->timerExt_ && p->plugin_) p->timerExt_->on_timer(p->plugin_, tid); });
      p->timerIds_[tid] = t;
      *id = tid;
      return true;
    };
    timers_.unregister_timer = [](const clap_host_t* h, clap_id id) -> bool {
      auto* p = self(h);
      auto it = p->timerIds_.find(id);
      if (it == p->timerIds_.end()) return false;
      plat::removeTimer(it->second);
      p->timerIds_.erase(it);
      return true;
    };
    fdSupport_.register_fd = [](const clap_host_t* h, int fd, clap_posix_fd_flags_t flags) -> bool {
      auto* p = self(h);
      p->unregisterFd(fd);
      p->fdIds_[fd] = plat::addFd(fd, (int)flags, [p, fd](int fl) { if (p->fdExt_ && p->plugin_) p->fdExt_->on_fd(p->plugin_, fd, (clap_posix_fd_flags_t)fl); });
      return true;
    };
    fdSupport_.modify_fd = [](const clap_host_t* h, int fd, clap_posix_fd_flags_t flags) -> bool {
      auto* p = self(h);
      p->unregisterFd(fd);
      p->fdIds_[fd] = plat::addFd(fd, (int)flags, [p, fd](int fl) { if (p->fdExt_ && p->plugin_) p->fdExt_->on_fd(p->plugin_, fd, (clap_posix_fd_flags_t)fl); });
      return true;
    };
    fdSupport_.unregister_fd = [](const clap_host_t* h, int fd) -> bool { self(h)->unregisterFd(fd); return true; };
    audioPorts_.is_rescan_flag_supported = [](const clap_host_t*, uint32_t) { return true; };
    audioPorts_.rescan = [](const clap_host_t* h, uint32_t) { auto* p = self(h); plat::post([p] { p->restartRequested(); }); };
    notePorts_.supported_dialects = [](const clap_host_t*) -> uint32_t { return CLAP_NOTE_DIALECT_CLAP | CLAP_NOTE_DIALECT_MIDI; };
    notePorts_.rescan = [](const clap_host_t* h, uint32_t) { auto* p = self(h); plat::post([p] { p->checkNotePorts(); }); };
    out_.toMain = &toMain_;
  }
  ~ClapPlugin() override {
    closeEditor();
    deactivate();
    for (auto& kv : timerIds_) plat::removeTimer(kv.second);
    for (auto& kv : fdIds_) plat::removeFd(kv.second);
    if (plugin_) plugin_->destroy(plugin_);
    plugin_ = nullptr;
    if (module_) { module_.reset(); dropModule(info.path); }
  }

  static ClapPlugin* self(const clap_host_t* h) { return static_cast<ClapPlugin*>(h->host_data); }

  const void* hostExtension(const char* id) {
    if (!std::strcmp(id, CLAP_EXT_LOG)) return &log_;
    if (!std::strcmp(id, CLAP_EXT_THREAD_CHECK)) return &threadCheck_;
    if (!std::strcmp(id, CLAP_EXT_PARAMS)) return &params_;
    if (!std::strcmp(id, CLAP_EXT_STATE)) return &state_;
    if (!std::strcmp(id, CLAP_EXT_LATENCY)) return &latency_;
    if (!std::strcmp(id, CLAP_EXT_GUI)) return &gui_;
    if (!std::strcmp(id, CLAP_EXT_TIMER_SUPPORT)) return &timers_;
    if (!std::strcmp(id, CLAP_EXT_AUDIO_PORTS)) return &audioPorts_;
    if (!std::strcmp(id, CLAP_EXT_NOTE_PORTS)) return &notePorts_;
#ifdef __linux__
    if (!std::strcmp(id, CLAP_EXT_POSIX_FD_SUPPORT)) return &fdSupport_;
#endif
    return nullptr;
  }

  void unregisterFd(int fd) {
    auto it = fdIds_.find(fd);
    if (it != fdIds_.end()) { plat::removeFd(it->second); fdIds_.erase(it); }
  }

  bool init(std::shared_ptr<ClapModule> m, const std::string& uid, std::string& error) {
    module_ = m;
    m->refs++;
    const clap_plugin_descriptor_t* desc = nullptr;
    uint32_t n = m->factory->get_plugin_count(m->factory);
    for (uint32_t i = 0; i < n; i++) {
      auto d = m->factory->get_plugin_descriptor(m->factory, i);
      if (d && d->id && uid == d->id) desc = d;
    }
    if (!desc) { error = "The plugin file has no plugin " + uid; return false; }
    info = infoOf(desc, m->path);
    plugin_ = m->factory->create_plugin(m->factory, &host_, uid.c_str());
    if (!plugin_) { error = "Could not create the plugin"; return false; }
    if (!plugin_->init(plugin_)) { plugin_->destroy(plugin_); plugin_ = nullptr; error = "The plugin did not initialize"; return false; }
    paramsExt_ = static_cast<const clap_plugin_params_t*>(plugin_->get_extension(plugin_, CLAP_EXT_PARAMS));
    stateExt_ = static_cast<const clap_plugin_state_t*>(plugin_->get_extension(plugin_, CLAP_EXT_STATE));
    latencyExt_ = static_cast<const clap_plugin_latency_t*>(plugin_->get_extension(plugin_, CLAP_EXT_LATENCY));
    guiExt_ = static_cast<const clap_plugin_gui_t*>(plugin_->get_extension(plugin_, CLAP_EXT_GUI));
    timerExt_ = static_cast<const clap_plugin_timer_support_t*>(plugin_->get_extension(plugin_, CLAP_EXT_TIMER_SUPPORT));
    fdExt_ = static_cast<const clap_plugin_posix_fd_support_t*>(plugin_->get_extension(plugin_, CLAP_EXT_POSIX_FD_SUPPORT));
    portsExt_ = static_cast<const clap_plugin_audio_ports_t*>(plugin_->get_extension(plugin_, CLAP_EXT_AUDIO_PORTS));
    notesExt_ = static_cast<const clap_plugin_note_ports_t*>(plugin_->get_extension(plugin_, CLAP_EXT_NOTE_PORTS));
    setupPorts();
    checkNotePorts();
    cacheParams();
    return true;
  }

  void setupPorts() {
    inPorts_.clear(); outPorts_.clear();
    if (portsExt_) {
      for (int dir = 0; dir < 2; dir++) {
        uint32_t n = portsExt_->count(plugin_, dir == 0);
        for (uint32_t i = 0; i < n; i++) {
          clap_audio_port_info_t pi{};
          if (!portsExt_->get(plugin_, i, dir == 0, &pi)) continue;
          (dir == 0 ? inPorts_ : outPorts_).push_back(pi.channel_count);
        }
      }
    } else if (!info.instrument) { inPorts_ = {2}; outPorts_ = {2}; }
    else outPorts_ = {2};
    size_t ch = 0;
    for (auto c : inPorts_) ch += c;
    for (auto c : outPorts_) ch += c;
    scratch_.assign(ch * fl::MAX_FRAMES, 0.f);
    ptrs_.assign(ch, nullptr);
    inBufs_.assign(inPorts_.size(), clap_audio_buffer_t{});
    outBufs_.assign(outPorts_.size(), clap_audio_buffer_t{});
    size_t k = 0;
    for (size_t i = 0; i < inPorts_.size(); i++) { inBufs_[i].data32 = &ptrs_[k]; inBufs_[i].channel_count = inPorts_[i]; for (uint32_t c = 0; c < inPorts_[i]; c++, k++) ptrs_[k] = &scratch_[k * fl::MAX_FRAMES]; }
    for (size_t i = 0; i < outPorts_.size(); i++) { outBufs_[i].data32 = &ptrs_[k]; outBufs_[i].channel_count = outPorts_[i]; for (uint32_t c = 0; c < outPorts_[i]; c++, k++) ptrs_[k] = &scratch_[k * fl::MAX_FRAMES]; }
    hasInput = !inPorts_.empty() && inPorts_[0] > 0;
    outChannels = outPorts_.empty() ? 0 : (int)outPorts_[0];
  }

  void checkNotePorts() {
    useMidi_ = false;
    if (!notesExt_) return;
    if (notesExt_->count(plugin_, true) == 0) return;
    clap_note_port_info_t ni{};
    if (notesExt_->get(plugin_, 0, true, &ni)) useMidi_ = !(ni.supported_dialects & CLAP_NOTE_DIALECT_CLAP) && (ni.supported_dialects & CLAP_NOTE_DIALECT_MIDI);
  }

  struct Range { double min, max; };
  void cacheParams() {
    ranges_.clear();
    if (!paramsExt_) return;
    uint32_t n = paramsExt_->count(plugin_);
    for (uint32_t i = 0; i < n; i++) {
      clap_param_info_t pi{};
      if (paramsExt_->get_info(plugin_, i, &pi)) ranges_[pi.id] = {pi.min_value, pi.max_value};
    }
  }
  double toPlain(uint32_t id, double norm) const {
    auto it = ranges_.find(id);
    if (it == ranges_.end()) return norm;
    return it->second.min + norm * (it->second.max - it->second.min);
  }
  double toNorm(uint32_t id, double plain) const {
    auto it = ranges_.find(id);
    if (it == ranges_.end() || it->second.max == it->second.min) return plain;
    return (plain - it->second.min) / (it->second.max - it->second.min);
  }

  // ------------------------------------------------------------------ lifecycle
  bool activate(double sr, int maxFrames) override {
    if (active_) deactivate();
    if (!plugin_->activate(plugin_, sr, 1, (uint32_t)maxFrames)) return false;
    sr_ = sr;
    active_ = true;
    return true;
  }
  void deactivate() override {
    if (!active_) return;
    stopProcessing();
    plugin_->deactivate(plugin_);
    active_ = false;
  }
  void stopProcessing() override {
    if (processing_) { plugin_->stop_processing(plugin_); processing_ = false; }
  }
  void restartRequested() {
    if (!active_) return;
    double sr = sr_;
    deactivate();
    setupPorts();
    activate(sr, fl::MAX_FRAMES);
  }

  // ------------------------------------------------------------------ parameters
  std::vector<ParamInfo> params() override {
    std::vector<ParamInfo> out;
    cacheParams();
    if (!paramsExt_) return out;
    uint32_t n = paramsExt_->count(plugin_);
    for (uint32_t i = 0; i < n; i++) {
      clap_param_info_t pi{};
      if (!paramsExt_->get_info(plugin_, i, &pi)) continue;
      ParamInfo p;
      p.id = pi.id;
      p.name = trimNul(pi.name, sizeof pi.name);
      p.group = trimNul(pi.module, sizeof pi.module);
      double range = pi.max_value - pi.min_value;
      p.def = range != 0 ? (pi.default_value - pi.min_value) / range : 0;
      p.steps = (pi.flags & CLAP_PARAM_IS_STEPPED) ? (int)std::max(1.0, std::round(range)) : 0;
      p.automatable = (pi.flags & CLAP_PARAM_IS_AUTOMATABLE) != 0;
      p.hidden = (pi.flags & CLAP_PARAM_IS_HIDDEN) != 0;
      p.readOnly = (pi.flags & CLAP_PARAM_IS_READONLY) != 0;
      p.bypass = (pi.flags & CLAP_PARAM_IS_BYPASS) != 0;
      out.push_back(p);
    }
    return out;
  }
  double paramValue(uint32_t id) override {
    double v = 0;
    if (paramsExt_ && paramsExt_->get_value(plugin_, id, &v)) return toNorm(id, v);
    return 0;
  }
  std::string paramText(uint32_t id, double norm) override {
    char buf[256] = {0};
    if (paramsExt_ && paramsExt_->value_to_text(plugin_, id, toPlain(id, norm), buf, sizeof buf)) return buf;
    return "";
  }
  void setParamFromHost(uint32_t, double) override {}       // the plugin updates its editor itself

  // ------------------------------------------------------------------ state
  bool saveState(std::string& out) override {
    if (!stateExt_) return false;
    OStream o;
    if (!stateExt_->save(plugin_, &o.api)) return false;
    out = "FLCL" + o.data;
    return true;
  }
  bool loadState(const std::string& d) override {
    if (!stateExt_ || d.size() < 4 || d.compare(0, 4, "FLCL") != 0) return false;
    std::string body = d.substr(4);
    IStream i(body);
    bool ok = stateExt_->load(plugin_, &i.api);
    cacheParams();
    return ok;
  }
  uint32_t latency() override { return latencyExt_ && active_ ? latencyExt_->get(plugin_) : 0; }

  // ------------------------------------------------------------------ editor
  bool hasEditor() override { return guiExt_ && guiExt_->is_api_supported(plugin_, plat::clapWindowApi(), false); }
  bool openEditor(const std::string& title, uint64_t owner) override {
    if (guiCreated_) { if (win_) plat::show(win_); guiExt_->show(plugin_); return true; }
    if (!hasEditor()) return false;
    if (!guiExt_->create(plugin_, plat::clapWindowApi(), false)) return false;
    guiCreated_ = true;
    uint32_t w = 400, h = 300;
    guiExt_->get_size(plugin_, &w, &h);
    bool resizable = guiExt_->can_resize(plugin_);
    win_ = plat::createWindow(title, (int)w, (int)h, resizable, owner,
                              {[this] { closeEditor(); if (events.editorClosed) events.editorClosed(); },
                               [this](int ww, int hh) { windowResized(ww, hh); }});
    if (!win_) { guiExt_->destroy(plugin_); guiCreated_ = false; return false; }
    double sc = plat::scaleFactor(win_);
    if (sc != 1.0) guiExt_->set_scale(plugin_, sc);
    clap_window_t cw{};
    cw.api = plat::clapWindowApi();
#if defined(_WIN32)
    cw.win32 = plat::nativeHandle(win_);
#elif defined(__APPLE__)
    cw.cocoa = plat::nativeHandle(win_);
#else
    cw.x11 = (clap_xwnd) reinterpret_cast<uintptr_t>(plat::nativeHandle(win_));
#endif
    if (!guiExt_->set_parent(plugin_, &cw)) { closeEditor(); return false; }
    guiExt_->suggest_title(plugin_, title.c_str());
    uint32_t w2 = w, h2 = h;
    if (guiExt_->get_size(plugin_, &w2, &h2) && (w2 != w || h2 != h)) plat::setContentSize(win_, (int)w2, (int)h2);
    plat::show(win_);
    guiExt_->show(plugin_);
    return true;
  }
  void closeEditor() override {
    if (guiCreated_) { guiExt_->hide(plugin_); guiExt_->destroy(plugin_); guiCreated_ = false; }
    if (win_) { plat::destroyWindow(win_); win_ = nullptr; }
  }
  bool editorOpen() override { return guiCreated_; }
  bool resizeFromPlugin(uint32_t w, uint32_t h) {
    if (!win_) return false;
    resizing_ = true;
    plat::setContentSize(win_, (int)w, (int)h);
    resizing_ = false;
    if (guiExt_) guiExt_->set_size(plugin_, w, h);
    return true;
  }
  void windowResized(int w, int h) {
    if (!guiCreated_ || resizing_ || !guiExt_->can_resize(plugin_)) return;
    uint32_t ww = (uint32_t)w, hh = (uint32_t)h;
    guiExt_->adjust_size(plugin_, &ww, &hh);
    if ((int)ww != w || (int)hh != h) { resizing_ = true; plat::setContentSize(win_, (int)ww, (int)hh); resizing_ = false; }
    guiExt_->set_size(plugin_, ww, hh);
  }

  void idle() override {
    // parameter changes the plugin reported (its editor) go to FL LUA
    ParamMsg m;
    std::map<uint32_t, double> last;
    while (toMain_.pop(m)) last[m.id] = m.value;
    for (auto& kv : last) if (events.paramFromEditor) events.paramFromEditor(kv.first, toNorm(kv.first, kv.second));
    // with no audio running, a flush applies the editor's changes
    if (flushRequested_.exchange(false) && !processing_ && paramsExt_) {
      flushIn_.clear();
      paramsExt_->flush(plugin_, &flushIn_.api, &out_.api);
    }
  }

  // ------------------------------------------------------------------ audio
  void process(const fl::Frame& f, fl::Slot& s) override {
    uint32_t frames = std::min<uint32_t>(f.frames, fl::MAX_FRAMES);
    if (!active_) { std::memset(s.out, 0, sizeof s.out); return; }
    if (!processing_) { processing_ = plugin_->start_processing(plugin_); if (!processing_) { std::memset(s.out, 0, sizeof s.out); return; } }
    in_.clear();
    for (uint32_t i = 0; i < s.nEvents && i < (uint32_t)fl::MAX_EVENTS; i++) {
      const fl::Event& e = s.events[i];
      uint32_t t = std::min<uint32_t>(e.offset, frames ? frames - 1 : 0);
      int ch = e.channel & 15;
      auto note = [&](uint16_t type, double vel) {
        if (useMidi_) {
          clap_event_midi_t m{};
          m.header = {sizeof m, t, CLAP_CORE_EVENT_SPACE_ID, CLAP_EVENT_MIDI, 0};
          m.port_index = 0;
          m.data[0] = (uint8_t)((type == CLAP_EVENT_NOTE_ON ? 0x90 : 0x80) | ch);
          m.data[1] = e.key;
          m.data[2] = (uint8_t)std::max(type == CLAP_EVENT_NOTE_ON ? 1 : 0, std::min(127, (int)std::lround(vel * 127)));
          in_.midi.push_back(m);
          in_.list.push_back(&in_.midi.back().header);
        } else {
          clap_event_note_t n{};
          n.header = {sizeof n, t, CLAP_CORE_EVENT_SPACE_ID, type, CLAP_EVENT_IS_LIVE};
          n.note_id = e.noteId;
          n.port_index = 0;
          n.channel = (int16_t)ch;
          n.key = e.key;
          n.velocity = vel;
          in_.notes.push_back(n);
          in_.list.push_back(&in_.notes.back().header);
        }
      };
      auto midi3 = [&](uint8_t st, uint8_t d1, uint8_t d2) {
        clap_event_midi_t m{};
        m.header = {sizeof m, t, CLAP_CORE_EVENT_SPACE_ID, CLAP_EVENT_MIDI, 0};
        m.data[0] = (uint8_t)(st | ch); m.data[1] = d1; m.data[2] = d2;
        in_.midi.push_back(m);
        in_.list.push_back(&in_.midi.back().header);
      };
      if (in_.notes.size() >= in_.notes.capacity() - 2 || in_.midi.size() >= in_.midi.capacity() - 2 || in_.params.size() >= in_.params.capacity() - 2) break;
      switch (e.type) {
        case fl::EV_NOTE_ON: note(CLAP_EVENT_NOTE_ON, e.value); held_[ch][e.key] = true; break;
        case fl::EV_NOTE_OFF: note(CLAP_EVENT_NOTE_OFF, e.value); held_[ch][e.key] = false; break;
        case fl::EV_CC: midi3(0xB0, e.key & 127, (uint8_t)std::lround(std::clamp(e.value, 0.0, 1.0) * 127)); break;
        case fl::EV_PITCH: { int v = (int)std::lround((std::clamp(e.value, -1.0, 1.0) + 1) * 8191.5); v = std::clamp(v, 0, 16383); midi3(0xE0, (uint8_t)(v & 127), (uint8_t)(v >> 7)); break; }
        case fl::EV_CHAN_PRESSURE: midi3(0xD0, (uint8_t)std::lround(std::clamp(e.value, 0.0, 1.0) * 127), 0); break;
        case fl::EV_POLY_PRESSURE: midi3(0xA0, e.key & 127, (uint8_t)std::lround(std::clamp(e.value, 0.0, 1.0) * 127)); break;
        case fl::EV_PARAM: {
          clap_event_param_value_t p{};
          p.header = {sizeof p, t, CLAP_CORE_EVENT_SPACE_ID, CLAP_EVENT_PARAM_VALUE, 0};
          p.param_id = e.param;
          p.cookie = nullptr;
          p.note_id = -1; p.port_index = -1; p.channel = -1; p.key = -1;
          p.value = toPlain(e.param, e.value);
          in_.params.push_back(p);
          in_.list.push_back(&in_.params.back().header);
          break;
        }
        case fl::EV_RESET:
          std::memset(held_, 0, sizeof held_);
          plugin_->reset(plugin_);
          break;
        case fl::EV_ALL_OFF:
          for (int c = 0; c < 16; c++)
            for (int k = 0; k < 128; k++)
              if (held_[c][k]) {
                held_[c][k] = false;
                clap_event_note_t n{};
                n.header = {sizeof n, t, CLAP_CORE_EVENT_SPACE_ID, CLAP_EVENT_NOTE_OFF, 0};
                n.note_id = -1; n.port_index = 0; n.channel = (int16_t)c; n.key = (int16_t)k; n.velocity = 0;
                if (in_.notes.size() + 1 < in_.notes.capacity()) { in_.notes.push_back(n); in_.list.push_back(&in_.notes.back().header); }
              }
          break;
      }
    }
    in_.sort();
    for (size_t i = 0; i < inBufs_.size(); i++)
      for (uint32_t c = 0; c < inBufs_[i].channel_count; c++) {
        if (i == 0 && hasInput) std::memcpy(inBufs_[i].data32[c], s.in[std::min<uint32_t>(c, 1)], frames * sizeof(float));
        else std::memset(inBufs_[i].data32[c], 0, frames * sizeof(float));
      }
    for (auto& b : outBufs_) for (uint32_t c = 0; c < b.channel_count; c++) std::memset(b.data32[c], 0, frames * sizeof(float));
    clap_event_transport_t tr{};
    tr.header = {sizeof tr, 0, CLAP_CORE_EVENT_SPACE_ID, CLAP_EVENT_TRANSPORT, 0};
    tr.flags = CLAP_TRANSPORT_HAS_TEMPO | CLAP_TRANSPORT_HAS_BEATS_TIMELINE | CLAP_TRANSPORT_HAS_SECONDS_TIMELINE | CLAP_TRANSPORT_HAS_TIME_SIGNATURE;
    if (f.flags & fl::FRAME_PLAYING) tr.flags |= CLAP_TRANSPORT_IS_PLAYING;
    if (f.flags & fl::FRAME_LOOP) tr.flags |= CLAP_TRANSPORT_IS_LOOP_ACTIVE;
    tr.tempo = f.tempo > 0 ? f.tempo : 120;
    tr.song_pos_beats = (clap_beattime)std::llround(f.ppq * (double)CLAP_BEATTIME_FACTOR);
    tr.song_pos_seconds = (clap_sectime)std::llround((f.samplePos / (sr_ > 0 ? sr_ : 48000)) * (double)CLAP_SECTIME_FACTOR);
    tr.loop_start_beats = (clap_beattime)std::llround(f.loopStartPpq * (double)CLAP_BEATTIME_FACTOR);
    tr.loop_end_beats = (clap_beattime)std::llround(f.loopEndPpq * (double)CLAP_BEATTIME_FACTOR);
    tr.bar_start = (clap_beattime)std::llround(f.barPpq * (double)CLAP_BEATTIME_FACTOR);
    tr.tsig_num = (uint16_t)(f.tsNum ? f.tsNum : 4);
    tr.tsig_denom = (uint16_t)(f.tsDen ? f.tsDen : 4);
    tr.bar_number = (int32_t)(f.barPpq / std::max(0.25, tr.tsig_num * 4.0 / tr.tsig_denom));
    clap_process_t p{};
    p.steady_time = (int64_t)steady_;
    steady_ += frames;
    p.frames_count = frames;
    p.transport = &tr;
    p.audio_inputs = inBufs_.empty() ? nullptr : inBufs_.data();
    p.audio_inputs_count = (uint32_t)inBufs_.size();
    p.audio_outputs = outBufs_.empty() ? nullptr : outBufs_.data();
    p.audio_outputs_count = (uint32_t)outBufs_.size();
    p.in_events = &in_.api;
    p.out_events = &out_.api;
    plugin_->process(plugin_, &p);
    if (!outBufs_.empty() && outBufs_[0].channel_count > 0) {
      std::memcpy(s.out[0], outBufs_[0].data32[0], frames * sizeof(float));
      std::memcpy(s.out[1], outBufs_[0].data32[outBufs_[0].channel_count > 1 ? 1 : 0], frames * sizeof(float));
    } else std::memset(s.out, 0, sizeof s.out);
  }

 private:
  std::shared_ptr<ClapModule> module_;
  clap_host_t host_{};
  clap_host_log_t log_{};
  clap_host_thread_check_t threadCheck_{};
  clap_host_params_t params_{};
  clap_host_state_t state_{};
  clap_host_latency_t latency_{};
  clap_host_gui_t gui_{};
  clap_host_timer_support_t timers_{};
  clap_host_posix_fd_support_t fdSupport_{};
  clap_host_audio_ports_t audioPorts_{};
  clap_host_note_ports_t notePorts_{};
  const clap_plugin_t* plugin_ = nullptr;
  const clap_plugin_params_t* paramsExt_ = nullptr;
  const clap_plugin_state_t* stateExt_ = nullptr;
  const clap_plugin_latency_t* latencyExt_ = nullptr;
  const clap_plugin_gui_t* guiExt_ = nullptr;
  const clap_plugin_timer_support_t* timerExt_ = nullptr;
  const clap_plugin_posix_fd_support_t* fdExt_ = nullptr;
  const clap_plugin_audio_ports_t* portsExt_ = nullptr;
  const clap_plugin_note_ports_t* notesExt_ = nullptr;
  std::map<clap_id, uint64_t> timerIds_;
  std::map<int, uint64_t> fdIds_;
  clap_id nextTimer_ = 1;
  std::map<uint32_t, Range> ranges_;
  std::vector<uint32_t> inPorts_, outPorts_;
  std::vector<clap_audio_buffer_t> inBufs_, outBufs_;
  std::vector<float> scratch_;
  std::vector<float*> ptrs_;
  InEvents in_, flushIn_;
  OutEvents out_;
  SpscQueue<ParamMsg, 4096> toMain_;
  std::atomic<bool> flushRequested_{false};
  bool held_[16][128] = {};
  bool useMidi_ = false;
  double sr_ = 48000;
  uint64_t steady_ = 0;
  bool active_ = false, processing_ = false, guiCreated_ = false, resizing_ = false;
  plat::Window* win_ = nullptr;
};

}  // namespace

std::vector<ClassInfo> scanClap(const std::string& path, std::string& error) {
  auto m = openModule(path, error);
  if (!m) return {};
  std::vector<ClassInfo> out;
  uint32_t n = m->factory->get_plugin_count(m->factory);
  for (uint32_t i = 0; i < n; i++) {
    auto d = m->factory->get_plugin_descriptor(m->factory, i);
    if (d && d->id) out.push_back(infoOf(d, path));
  }
  if (out.empty()) error = "No plugins in this CLAP file";
  return out;
}

std::unique_ptr<Plugin> loadClap(const std::string& path, const std::string& uid, std::string& error) {
  auto m = openModule(path, error);
  if (!m) return nullptr;
  auto p = std::make_unique<ClapPlugin>();
  if (!p->init(m, uid, error)) return nullptr;
  return p;
}
