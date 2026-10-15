// What the host needs from a loaded plugin, whatever its format (vst3.cpp, clap.cpp, vst2.cpp).
#pragma once
#include <atomic>
#include <cstdint>
#include <functional>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

#include "../common/layout.h"
#include "json.h"

struct ClassInfo {             // one plugin found in a file
  std::string format;          // "vst3" | "clap" | "vst2" | "au"
  std::string path;            // the file or bundle
  std::string uid;             // VST3 class id (32 hex digits) / CLAP plugin id / VST2 unique id (decimal)
  std::string name, vendor, version, category;
  bool instrument = false;
  json::Value toJson() const {
    json::Value v = json::Value::object();
    v.set("format", format).set("path", path).set("uid", uid).set("name", name).set("vendor", vendor)
     .set("version", version).set("category", category).set("kind", instrument ? "instrument" : "effect");
    return v;
  }
};

struct ParamInfo {
  uint32_t id = 0;
  std::string name, unit, group;
  double def = 0;              // normalized 0..1
  int steps = 0;               // 0 = continuous
  bool automatable = true, hidden = false, readOnly = false, bypass = false;
  json::Value toJson() const {
    json::Value v = json::Value::object();
    v.set("id", (double)id).set("name", name).set("def", def).set("steps", steps);
    if (!unit.empty()) v.set("unit", unit);
    if (!group.empty()) v.set("group", group);
    if (!automatable) v.set("automatable", false);
    if (hidden) v.set("hidden", true);
    if (readOnly) v.set("readOnly", true);
    if (bypass) v.set("bypass", true);
    return v;
  }
};

// What a plugin tells the host (always called on the main thread)
struct PluginEvents {
  std::function<void(uint32_t id, double value)> paramFromEditor;   // the person turned a knob in the plugin's window
  std::function<void()> dirty;                                       // its state changed (save it with the project)
  std::function<void()> paramsChanged;                               // the parameter list or names changed
  std::function<void()> latencyChanged;
  std::function<void()> editorClosed;
  std::function<void(const std::string&)> log;
};

class Plugin {
 public:
  virtual ~Plugin() = default;
  ClassInfo info;
  PluginEvents events;
  bool hasInput = false;       // effects take audio in
  int outChannels = 2;

  // main thread
  virtual bool activate(double sampleRate, int maxFrames) = 0;
  virtual void deactivate() = 0;
  virtual std::vector<ParamInfo> params() = 0;
  virtual double paramValue(uint32_t id) = 0;                   // normalized
  virtual std::string paramText(uint32_t id, double normalized) = 0;
  virtual void setParamFromHost(uint32_t id, double normalized) = 0;   // updates the editor (the processor gets it through process)
  virtual bool saveState(std::string& out) = 0;
  virtual bool loadState(const std::string& data) = 0;
  virtual uint32_t latency() = 0;
  virtual bool hasEditor() = 0;
  virtual bool openEditor(const std::string& title, uint64_t owner) = 0;
  virtual void closeEditor() = 0;
  virtual bool editorOpen() = 0;
  virtual void idle() {}                                          // ~30 times a second

  // audio thread: one block; events and audio in from the slot, audio out into it
  virtual void process(const fl::Frame& frame, fl::Slot& slot) = 0;
  // audio thread (or the main thread while the audio thread is held): stop processing before deactivate
  virtual void stopProcessing() = 0;
};

// format modules
std::vector<ClassInfo> scanVst3(const std::string& path, std::string& error);
std::vector<ClassInfo> scanClap(const std::string& path, std::string& error);
std::unique_ptr<Plugin> loadVst3(const std::string& path, const std::string& uid, std::string& error);
std::unique_ptr<Plugin> loadClap(const std::string& path, const std::string& uid, std::string& error);
// notPlugin: the file is no VST2 plugin at all (a library next to the plugins): not worth listing as a failure
std::vector<ClassInfo> scanVst2(const std::string& path, std::string& error, bool& notPlugin);
std::unique_ptr<Plugin> loadVst2(const std::string& path, const std::string& uid, std::string& error);

// the thread processing audio right now (CLAP thread-check, VST3 asserts in some plugins)
bool isAudioThread();
void setAudioThread(bool on);
