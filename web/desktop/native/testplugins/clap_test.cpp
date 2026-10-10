// Test plugins for FL LUA's plugin host (not shipped). One CLAP file with two plugins:
//   "FLLUA Test CLAP Synth"  saw/sine voices; parameters Gain (id 10, 0..2) and Tone (id 11, 0..1); its editor turns
//                            Tone to 0.75 by itself (reported through the output events)
//   "FLLUA Test CLAP Gain"   effect: input * Gain (id 10, 0..2)
#include <atomic>
#include <cmath>
#include <cstdio>
#include <cstring>

#include <clap/clap.h>

#if defined(__linux__)
#include <X11/Xlib.h>
#elif defined(_WIN32)
#include <windows.h>
#endif

#if defined(_WIN32)
#define EXPORT extern "C" __declspec(dllexport)
#else
#define EXPORT extern "C" __attribute__((visibility("default")))
#endif

namespace {

const char* synthFeatures[] = {CLAP_PLUGIN_FEATURE_INSTRUMENT, CLAP_PLUGIN_FEATURE_SYNTHESIZER, nullptr};
const char* gainFeatures[] = {CLAP_PLUGIN_FEATURE_AUDIO_EFFECT, CLAP_PLUGIN_FEATURE_UTILITY, nullptr};
const clap_plugin_descriptor_t synthDesc = {CLAP_VERSION_INIT, "org.fllua.test.synth", "FLLUA Test CLAP Synth", "FL LUA Tests", "", "", "", "1.0.0", "Test synth", synthFeatures};
const clap_plugin_descriptor_t gainDesc = {CLAP_VERSION_INIT, "org.fllua.test.gain", "FLLUA Test CLAP Gain", "FL LUA Tests", "", "", "", "1.0.0", "Test gain", gainFeatures};

struct Voice { bool on; double vel, ph, env; };

struct Test {
  clap_plugin_t plugin{};
  const clap_host_t* host = nullptr;
  const clap_host_params_t* hostParams = nullptr;
  bool synth = false;
  double gain = 1.0, tone = 0.25, sr = 48000;
  Voice voices[128] = {};
  std::atomic<bool> pendingTone{false};
#if defined(__linux__)
  Display* dpy = nullptr;
  Window win = 0;
#elif defined(_WIN32)
  HWND hwnd = nullptr;
#endif
};

Test* self(const clap_plugin_t* p) { return static_cast<Test*>(p->plugin_data); }

void applyEvent(Test* t, const clap_event_header_t* h) {
  if (h->space_id != CLAP_CORE_EVENT_SPACE_ID) return;
  if (h->type == CLAP_EVENT_PARAM_VALUE) {
    auto* e = reinterpret_cast<const clap_event_param_value_t*>(h);
    if (e->param_id == 10) t->gain = e->value;
    if (e->param_id == 11) t->tone = e->value;
  } else if (h->type == CLAP_EVENT_NOTE_ON) {
    auto* e = reinterpret_cast<const clap_event_note_t*>(h);
    Voice& v = t->voices[e->key & 127]; v.on = true; v.vel = e->velocity; v.ph = 0; v.env = 0;
  } else if (h->type == CLAP_EVENT_NOTE_OFF) {
    auto* e = reinterpret_cast<const clap_event_note_t*>(h);
    t->voices[e->key & 127].on = false;
  }
}

void sendPending(Test* t, const clap_output_events_t* out) {
  if (!out || !t->pendingTone.exchange(false)) return;
  t->tone = 0.75;
  clap_event_param_value_t e{};
  e.header = {sizeof e, 0, CLAP_CORE_EVENT_SPACE_ID, CLAP_EVENT_PARAM_VALUE, 0};
  e.param_id = 11; e.note_id = -1; e.port_index = -1; e.channel = -1; e.key = -1; e.value = 0.75;
  out->try_push(out, &e.header);
}

// ---------------------------------------------------------------- extensions
uint32_t paramsCount(const clap_plugin_t* p) { return self(p)->synth ? 2 : 1; }
bool paramsInfo(const clap_plugin_t*, uint32_t i, clap_param_info_t* info) {
  std::memset(info, 0, sizeof *info);
  info->id = 10 + i;
  info->flags = CLAP_PARAM_IS_AUTOMATABLE;
  std::snprintf(info->name, sizeof info->name, "%s", i == 0 ? "Gain" : "Tone");
  info->min_value = 0;
  info->max_value = i == 0 ? 2 : 1;
  info->default_value = i == 0 ? 1 : 0.25;
  return i < 2;
}
bool paramsValue(const clap_plugin_t* p, clap_id id, double* v) {
  if (id == 10) { *v = self(p)->gain; return true; }
  if (id == 11) { *v = self(p)->tone; return true; }
  return false;
}
bool paramsText(const clap_plugin_t*, clap_id id, double v, char* out, uint32_t size) {
  std::snprintf(out, size, id == 10 ? "%.2fx" : "%.0f%%", id == 10 ? v : v * 100);
  return true;
}
bool paramsFromText(const clap_plugin_t*, clap_id, const char*, double*) { return false; }
void paramsFlush(const clap_plugin_t* p, const clap_input_events_t* in, const clap_output_events_t* out) {
  for (uint32_t i = 0; in && i < in->size(in); i++) applyEvent(self(p), in->get(in, i));
  sendPending(self(p), out);
}
const clap_plugin_params_t paramsExt = {paramsCount, paramsInfo, paramsValue, paramsText, paramsFromText, paramsFlush};

bool stateSave(const clap_plugin_t* p, const clap_ostream_t* s) {
  double v[2] = {self(p)->gain, self(p)->tone};
  return s->write(s, v, sizeof v) == (int64_t)sizeof v;
}
bool stateLoad(const clap_plugin_t* p, const clap_istream_t* s) {
  double v[2];
  if (s->read(s, v, sizeof v) != (int64_t)sizeof v) return false;
  self(p)->gain = v[0]; self(p)->tone = v[1];
  return true;
}
const clap_plugin_state_t stateExt = {stateSave, stateLoad};

uint32_t portsCount(const clap_plugin_t* p, bool isInput) { return isInput && self(p)->synth ? 0 : 1; }
bool portsGet(const clap_plugin_t*, uint32_t i, bool isInput, clap_audio_port_info_t* info) {
  if (i) return false;
  std::memset(info, 0, sizeof *info);
  info->id = 0;
  std::snprintf(info->name, sizeof info->name, "%s", isInput ? "In" : "Out");
  info->flags = CLAP_AUDIO_PORT_IS_MAIN;
  info->channel_count = 2;
  info->port_type = CLAP_PORT_STEREO;
  info->in_place_pair = CLAP_INVALID_ID;
  return true;
}
const clap_plugin_audio_ports_t portsExt = {portsCount, portsGet};

uint32_t notesCount(const clap_plugin_t* p, bool isInput) { return isInput && self(p)->synth ? 1 : 0; }
bool notesGet(const clap_plugin_t*, uint32_t i, bool, clap_note_port_info_t* info) {
  if (i) return false;
  std::memset(info, 0, sizeof *info);
  info->supported_dialects = CLAP_NOTE_DIALECT_CLAP;
  info->preferred_dialect = CLAP_NOTE_DIALECT_CLAP;
  std::snprintf(info->name, sizeof info->name, "Notes");
  return true;
}
const clap_plugin_note_ports_t notesExt = {notesCount, notesGet};

#if defined(__linux__) || defined(_WIN32)
bool guiSupported(const clap_plugin_t*, const char* api, bool floating) {
#if defined(__linux__)
  return !floating && !std::strcmp(api, CLAP_WINDOW_API_X11);
#else
  return !floating && !std::strcmp(api, CLAP_WINDOW_API_WIN32);
#endif
}
bool guiPreferred(const clap_plugin_t*, const char** api, bool* floating) {
#if defined(__linux__)
  *api = CLAP_WINDOW_API_X11;
#else
  *api = CLAP_WINDOW_API_WIN32;
#endif
  *floating = false;
  return true;
}
bool guiCreate(const clap_plugin_t*, const char*, bool) { return true; }
void guiDestroy(const clap_plugin_t* p) {
  Test* t = self(p);
#if defined(__linux__)
  if (t->dpy) { XDestroyWindow(t->dpy, t->win); XCloseDisplay(t->dpy); t->dpy = nullptr; }
#else
  if (t->hwnd) DestroyWindow(t->hwnd);
  t->hwnd = nullptr;
#endif
}
bool guiScale(const clap_plugin_t*, double) { return true; }
bool guiSize(const clap_plugin_t*, uint32_t* w, uint32_t* h) { *w = 300; *h = 180; return true; }
bool guiCanResize(const clap_plugin_t*) { return false; }
bool guiHints(const clap_plugin_t*, clap_gui_resize_hints_t*) { return false; }
bool guiAdjust(const clap_plugin_t*, uint32_t*, uint32_t*) { return false; }
bool guiSetSize(const clap_plugin_t*, uint32_t, uint32_t) { return true; }
bool guiParent(const clap_plugin_t* p, const clap_window_t* w) {
  Test* t = self(p);
#if defined(__linux__)
  t->dpy = XOpenDisplay(nullptr);
  if (!t->dpy) return false;
  t->win = XCreateSimpleWindow(t->dpy, (Window)w->x11, 0, 0, 300, 180, 0, 0, 0xff8a2a);
  XMapWindow(t->dpy, t->win);
  XFlush(t->dpy);
#else
  t->hwnd = CreateWindowExW(0, L"STATIC", L"FLLUA Test CLAP Synth", WS_CHILD | WS_VISIBLE, 0, 0, 300, 180, (HWND)w->win32, nullptr, nullptr, nullptr);
#endif
  return true;
}
bool guiTransient(const clap_plugin_t*, const clap_window_t*) { return false; }
void guiTitle(const clap_plugin_t*, const char*) {}
bool guiShow(const clap_plugin_t* p) {
  Test* t = self(p);
  t->pendingTone = true;                      // "a person turns the Tone knob"
  if (t->hostParams) t->hostParams->request_flush(t->host);
  return true;
}
bool guiHide(const clap_plugin_t*) { return true; }
const clap_plugin_gui_t guiExt = {guiSupported, guiPreferred, guiCreate, guiDestroy, guiScale, guiSize, guiCanResize, guiHints, guiAdjust, guiSetSize, guiParent, guiTransient, guiTitle, guiShow, guiHide};
#endif

// ---------------------------------------------------------------- plugin
bool pInit(const clap_plugin_t* p) {
  Test* t = self(p);
  t->hostParams = static_cast<const clap_host_params_t*>(t->host->get_extension(t->host, CLAP_EXT_PARAMS));
  return true;
}
void pDestroy(const clap_plugin_t* p) { delete self(p); }
bool pActivate(const clap_plugin_t* p, double sr, uint32_t, uint32_t) { self(p)->sr = sr; return true; }
void pDeactivate(const clap_plugin_t*) {}
bool pStart(const clap_plugin_t*) { return true; }
void pStop(const clap_plugin_t*) {}
void pReset(const clap_plugin_t* p) { std::memset(self(p)->voices, 0, sizeof self(p)->voices); }
clap_process_status pProcess(const clap_plugin_t* p, const clap_process_t* pr) {
  Test* t = self(p);
  uint32_t n = pr->frames_count, ne = pr->in_events->size(pr->in_events), ei = 0;
  float* L = pr->audio_outputs[0].data32[0];
  float* R = pr->audio_outputs[0].data32[1];
  for (uint32_t i = 0; i < n; i++) {
    while (ei < ne) {
      const clap_event_header_t* h = pr->in_events->get(pr->in_events, ei);
      if (h->time > i) break;
      applyEvent(t, h);
      ei++;
    }
    if (!t->synth) {
      L[i] = pr->audio_inputs[0].data32[0][i] * (float)t->gain;
      R[i] = pr->audio_inputs[0].data32[1][i] * (float)t->gain;
      continue;
    }
    double s = 0;
    for (int k = 0; k < 128; k++) {
      Voice& v = t->voices[k];
      if (!v.on && v.env < 1e-4) continue;
      v.env += ((v.on ? 1.0 : 0.0) - v.env) * (v.on ? 0.01 : 0.002);
      v.ph += 440.0 * std::pow(2.0, (k - 69) / 12.0) / t->sr;
      if (v.ph >= 1) v.ph -= 1;
      s += (std::sin(v.ph * 6.283185307) * (1 - t->tone) + (2 * v.ph - 1) * t->tone) * v.env * v.vel * 0.3;
    }
    L[i] = R[i] = (float)(s * t->gain);
  }
  sendPending(t, pr->out_events);
  return CLAP_PROCESS_CONTINUE;
}
const void* pExtension(const clap_plugin_t* p, const char* id) {
  if (!std::strcmp(id, CLAP_EXT_PARAMS)) return &paramsExt;
  if (!std::strcmp(id, CLAP_EXT_STATE)) return &stateExt;
  if (!std::strcmp(id, CLAP_EXT_AUDIO_PORTS)) return &portsExt;
  if (!std::strcmp(id, CLAP_EXT_NOTE_PORTS)) return &notesExt;
#if defined(__linux__) || defined(_WIN32)
  if (!std::strcmp(id, CLAP_EXT_GUI) && self(p)->synth) return &guiExt;
#endif
  (void)p;
  return nullptr;
}
void pMainThread(const clap_plugin_t*) {}

uint32_t fCount(const clap_plugin_factory_t*) { return 2; }
const clap_plugin_descriptor_t* fDesc(const clap_plugin_factory_t*, uint32_t i) { return i == 0 ? &synthDesc : i == 1 ? &gainDesc : nullptr; }
const clap_plugin_t* fCreate(const clap_plugin_factory_t*, const clap_host_t* host, const char* id) {
  bool synth = !std::strcmp(id, synthDesc.id);
  if (!synth && std::strcmp(id, gainDesc.id)) return nullptr;
  Test* t = new Test();
  t->host = host;
  t->synth = synth;
  t->plugin = {synth ? &synthDesc : &gainDesc, t, pInit, pDestroy, pActivate, pDeactivate, pStart, pStop, pReset, pProcess, pExtension, pMainThread};
  return &t->plugin;
}
const clap_plugin_factory_t factory = {fCount, fDesc, fCreate};

bool eInit(const char*) { return true; }
void eDeinit() {}
const void* eFactory(const char* id) { return !std::strcmp(id, CLAP_PLUGIN_FACTORY_ID) ? &factory : nullptr; }

}  // namespace

EXPORT const clap_plugin_entry_t clap_entry = {CLAP_VERSION_INIT, eInit, eDeinit, eFactory};
