// Test VST2 plugins for FL LUA's host, written against common/vst2abi.h. Built twice:
//   FLLUA_TEST_SYNTH=1  "FLLUA Test VST2 Synth"  sine/saw voices; Gain (0) and Tone (1); its editor turns Tone to 0.75
//                       by itself (as if a person did) so the editor -> host path can be tested
//   FLLUA_TEST_SYNTH=0  "FLLUA Test VST2 Gain"   a 64-sample delay times 2 * Gain (so the latency is visible)
// State is a chunk with the two values.
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>

#include "../common/vst2abi.h"

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

#ifndef FLLUA_TEST_SYNTH
#define FLLUA_TEST_SYNTH 1
#endif

using namespace vst2;

namespace {

constexpr bool kSynth = FLLUA_TEST_SYNTH != 0;

struct Voice { bool on; float vel; double ph; float env; };

struct TestPlugin {
  AEffect fx{};
  HostCallback host = nullptr;
  float p[2] = {0.5f, 0.25f};
  Voice voices[128] = {};
  float dl[2][64] = {};
  int dp = 0;
  double sr = 48000;
  ERect rect{0, 0, 200, 320};
  float chunk[2] = {};
#if defined(__linux__)
  Display* dpy = nullptr;
  ::Window win = 0;
#elif defined(_WIN32)
  HWND hwnd = nullptr;
#endif
};

TestPlugin* self(AEffect* e) { return static_cast<TestPlugin*>(e->object); }

void copyStr(void* ptr, const char* s) { if (ptr) std::strcpy(static_cast<char*>(ptr), s); }

void reset(TestPlugin* t) {
  std::memset(t->voices, 0, sizeof t->voices);
  std::memset(t->dl, 0, sizeof t->dl);
}

void openEditor(TestPlugin* t, void* parent) {
#if defined(__linux__)
  t->dpy = XOpenDisplay(nullptr);
  if (!t->dpy) return;
  t->win = XCreateSimpleWindow(t->dpy, (::Window)(uintptr_t)parent, 0, 0, 320, 200, 0, 0, 0x2a7fff);
  XMapWindow(t->dpy, t->win);
  XFlush(t->dpy);
#elif defined(_WIN32)
  t->hwnd = CreateWindowExW(0, L"STATIC", L"FLLUA Test VST2 Synth", WS_CHILD | WS_VISIBLE, 0, 0, 320, 200, (HWND)parent, nullptr, nullptr, nullptr);
#else
  (void)parent;
#endif
  // "a person turns the Tone knob"
  t->p[1] = 0.75f;
  t->host(&t->fx, audioMasterBeginEdit, 1, 0, nullptr, 0);
  t->host(&t->fx, audioMasterAutomate, 1, 0, nullptr, 0.75f);
  t->host(&t->fx, audioMasterEndEdit, 1, 0, nullptr, 0);
}

void closeEditor(TestPlugin* t) {
#if defined(__linux__)
  if (t->dpy) { XDestroyWindow(t->dpy, t->win); XCloseDisplay(t->dpy); t->dpy = nullptr; }
#elif defined(_WIN32)
  if (t->hwnd) DestroyWindow(t->hwnd);
  t->hwnd = nullptr;
#else
  (void)t;
#endif
}

intptr_t VST2_CALL dispatcher(AEffect* e, int32_t op, int32_t index, intptr_t value, void* ptr, float opt) {
  TestPlugin* t = self(e);
  switch (op) {
    case effClose: closeEditor(t); delete t; return 1;
    case effSetSampleRate: t->sr = opt; return 1;
    case effMainsChanged: reset(t); return 1;
    case effGetParamName: copyStr(ptr, index == 0 ? "Gain" : "Tone"); return 1;
    case effGetParamLabel: copyStr(ptr, index == 1 ? "%" : ""); return 1;
    case effGetParamDisplay: {
      char buf[32];
      if (index == 1) std::snprintf(buf, sizeof buf, "%d", (int)std::lround(t->p[1] * 100));
      else std::snprintf(buf, sizeof buf, "%.2f", t->p[0] * 2);
      copyStr(ptr, buf);
      return 1;
    }
    case effGetEffectName: copyStr(ptr, kSynth ? "FLLUA Test VST2 Synth" : "FLLUA Test VST2 Gain"); return 1;
    case effGetVendorString: copyStr(ptr, "FL LUA Tests"); return 1;
    case effGetProductString: copyStr(ptr, kSynth ? "FLLUA Test VST2 Synth" : "FLLUA Test VST2 Gain"); return 1;
    case effGetVendorVersion: return 1;
    case effGetPlugCategory: return kSynth ? kPlugCategSynth : kPlugCategEffect;
    case effGetVstVersion: return 2400;
    case effCanBeAutomated: return 1;
    case effEditGetRect: if (!kSynth || !ptr) return 0; *static_cast<ERect**>(ptr) = &t->rect; return 1;
    case effEditOpen: if (!kSynth) return 0; openEditor(t, ptr); return 1;
    case effEditClose: closeEditor(t); return 1;
    case effGetChunk:
      t->chunk[0] = t->p[0]; t->chunk[1] = t->p[1];
      *static_cast<void**>(ptr) = t->chunk;
      return (intptr_t)sizeof t->chunk;
    case effSetChunk:
      if (value == (intptr_t)sizeof t->chunk && ptr) { std::memcpy(t->chunk, ptr, sizeof t->chunk); t->p[0] = t->chunk[0]; t->p[1] = t->chunk[1]; }
      return 1;
    case effProcessEvents: {
      if (!kSynth || !ptr) return 1;
      auto* ev = static_cast<VstEvents*>(ptr);
      for (int32_t i = 0; i < ev->numEvents; i++) {
        if (ev->events[i]->type != kVstMidiType) continue;
        auto* m = reinterpret_cast<VstMidiEvent*>(ev->events[i]);
        uint8_t st = (uint8_t)m->midiData[0] & 0xF0, key = (uint8_t)m->midiData[1] & 127, vel = (uint8_t)m->midiData[2];
        // a note starts deltaFrames into the block: the phase counts the wait down from -deltaFrames
        if (st == 0x90 && vel) { Voice& v = t->voices[key]; v.on = true; v.vel = vel / 127.f; v.env = 0; v.ph = -(double)m->deltaFrames; }
        else if (st == 0x80 || (st == 0x90 && !vel)) t->voices[key].on = false;
      }
      return 1;
    }
    default: return 0;
  }
}

void VST2_CALL setParameter(AEffect* e, int32_t i, float v) { if (i >= 0 && i < 2) self(e)->p[i] = v; }
float VST2_CALL getParameter(AEffect* e, int32_t i) { return i >= 0 && i < 2 ? self(e)->p[i] : 0; }

void VST2_CALL processReplacing(AEffect* e, float** in, float** out, int32_t n) {
  TestPlugin* t = self(e);
  if (!kSynth) {
    float g = 2 * t->p[0];
    for (int32_t i = 0; i < n; i++) {
      float a = in[0][i], b = in[1][i];
      out[0][i] = t->dl[0][t->dp] * g; out[1][i] = t->dl[1][t->dp] * g;
      t->dl[0][t->dp] = a; t->dl[1][t->dp] = b;
      t->dp = (t->dp + 1) % 64;
    }
    return;
  }
  for (int32_t i = 0; i < n; i++) {
    float s = 0;
    for (int k = 0; k < 128; k++) {
      Voice& v = t->voices[k];
      if (!v.on && v.env < 1e-4f) continue;
      if (v.ph < 0) { v.ph += 1; continue; }        // the note's offset in the block
      v.env += ((v.on ? 1.f : 0.f) - v.env) * (v.on ? 0.01f : 0.002f);
      double f = 440.0 * std::pow(2.0, (k - 69) / 12.0);
      v.ph += f / t->sr;
      if (v.ph >= 1) v.ph -= 1;
      double sine = std::sin(v.ph * 6.283185307), saw = 2 * v.ph - 1;
      s += (float)((sine * (1 - t->p[1]) + saw * t->p[1]) * v.env * v.vel * 0.3);
    }
    out[0][i] = out[1][i] = s * 2 * t->p[0];
  }
}

}  // namespace

EXPORT AEffect* VSTPluginMain(HostCallback host) {
  if (!host || host(nullptr, audioMasterVersion, 0, 0, nullptr, 0) < 2400) return nullptr;
  auto* t = new TestPlugin();
  t->host = host;
  AEffect& fx = t->fx;
  fx.magic = kMagic;
  fx.dispatcher = dispatcher;
  fx.setParameter = setParameter;
  fx.getParameter = getParameter;
  fx.processReplacing = processReplacing;
  fx.numPrograms = 1;
  fx.numParams = kSynth ? 2 : 1;
  fx.numInputs = kSynth ? 0 : 2;
  fx.numOutputs = 2;
  fx.flags = effFlagsCanReplacing | effFlagsProgramChunks | (kSynth ? effFlagsIsSynth : 0);
#if defined(__linux__) || defined(_WIN32)
  if (kSynth) fx.flags |= effFlagsHasEditor;
#endif
  fx.initialDelay = kSynth ? 0 : 64;
  fx.object = t;
  fx.uniqueID = kSynth ? 0x464C7332 : 0x464C6732;          // 'FLs2' / 'FLg2'
  fx.version = 1;
  return &fx;
}

#if defined(__APPLE__)
EXPORT AEffect* main_macho(HostCallback host) { return VSTPluginMain(host); }
#endif
