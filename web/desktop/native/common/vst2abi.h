// The binary interface of VST 2.x plugins, as far as FL LUA's host and its test plugin use it.
// Steinberg no longer distributes the VST2 SDK; this file is not taken from it. It describes, for interoperability,
// the layout and the numbers that VST2 plugins and hosts exchange: one structure per plugin instance (AEffect) with
// function pointers, an opcode-based call into the plugin (dispatcher) and one back into the host (audioMaster).
// Names follow the widely used conventions so that the code reads like other hosts.
#pragma once
#include <cstdint>

#if defined(_WIN32)
#define VST2_CALL __cdecl
#else
#define VST2_CALL
#endif

namespace vst2 {

struct AEffect;
using HostCallback = intptr_t(VST2_CALL*)(AEffect* effect, int32_t opcode, int32_t index, intptr_t value, void* ptr, float opt);
using Dispatcher = intptr_t(VST2_CALL*)(AEffect* effect, int32_t opcode, int32_t index, intptr_t value, void* ptr, float opt);
using ProcessFloat = void(VST2_CALL*)(AEffect* effect, float** inputs, float** outputs, int32_t frames);
using ProcessDouble = void(VST2_CALL*)(AEffect* effect, double** inputs, double** outputs, int32_t frames);
using SetParameter = void(VST2_CALL*)(AEffect* effect, int32_t index, float value);
using GetParameter = float(VST2_CALL*)(AEffect* effect, int32_t index);
using Entry = AEffect*(VST2_CALL*)(HostCallback host);

constexpr int32_t kMagic = 0x56737450;            // 'VstP'

struct AEffect {
  int32_t magic;
  Dispatcher dispatcher;
  ProcessFloat process;                           // old accumulating process (adds to the outputs)
  SetParameter setParameter;
  GetParameter getParameter;
  int32_t numPrograms;
  int32_t numParams;
  int32_t numInputs;
  int32_t numOutputs;
  int32_t flags;
  intptr_t resvd1;                                // for the host
  intptr_t resvd2;
  int32_t initialDelay;                           // latency in samples
  int32_t realQualities;
  int32_t offQualities;
  float ioRatio;
  void* object;                                   // for the plugin
  void* user;
  int32_t uniqueID;
  int32_t version;
  ProcessFloat processReplacing;
  ProcessDouble processDoubleReplacing;
  char future[56];
};

// AEffect::flags
enum : int32_t {
  effFlagsHasEditor = 1 << 0,
  effFlagsCanReplacing = 1 << 4,
  effFlagsProgramChunks = 1 << 5,
  effFlagsIsSynth = 1 << 8,
  effFlagsNoSoundInStop = 1 << 9,
  effFlagsCanDoubleReplacing = 1 << 12,
};

// host -> plugin
enum : int32_t {
  effOpen = 0, effClose = 1, effSetProgram = 2, effGetProgram = 3, effSetProgramName = 4, effGetProgramName = 5,
  effGetParamLabel = 6, effGetParamDisplay = 7, effGetParamName = 8,
  effSetSampleRate = 10, effSetBlockSize = 11, effMainsChanged = 12,
  effEditGetRect = 13, effEditOpen = 14, effEditClose = 15, effEditIdle = 19,
  effGetChunk = 23, effSetChunk = 24, effProcessEvents = 25, effCanBeAutomated = 26,
  effGetProgramNameIndexed = 29, effGetPlugCategory = 35,
  effGetEffectName = 45, effGetVendorString = 47, effGetProductString = 48, effGetVendorVersion = 49,
  effCanDo = 51, effGetTailSize = 52, effGetParameterProperties = 56, effGetVstVersion = 58,
  effBeginSetProgram = 67, effEndSetProgram = 68, effShellGetNextPlugin = 70,
  effStartProcess = 71, effStopProcess = 72, effSetProcessPrecision = 77,
};

// plugin -> host
enum : int32_t {
  audioMasterAutomate = 0, audioMasterVersion = 1, audioMasterCurrentId = 2, audioMasterIdle = 3,
  audioMasterGetTime = 7, audioMasterProcessEvents = 8, audioMasterIOChanged = 13, audioMasterSizeWindow = 15,
  audioMasterGetSampleRate = 16, audioMasterGetBlockSize = 17, audioMasterGetInputLatency = 18,
  audioMasterGetOutputLatency = 19, audioMasterGetCurrentProcessLevel = 23, audioMasterGetAutomationState = 24,
  audioMasterGetVendorString = 32, audioMasterGetProductString = 33, audioMasterGetVendorVersion = 34,
  audioMasterCanDo = 37, audioMasterGetLanguage = 38, audioMasterGetDirectory = 41, audioMasterUpdateDisplay = 42,
  audioMasterBeginEdit = 43, audioMasterEndEdit = 44,
};

// effGetPlugCategory
enum : int32_t {
  kPlugCategUnknown = 0, kPlugCategEffect = 1, kPlugCategSynth = 2, kPlugCategAnalysis = 3, kPlugCategMastering = 4,
  kPlugCategSpacializer = 5, kPlugCategRoomFx = 6, kPlugSurroundFx = 7, kPlugCategRestoration = 8,
  kPlugCategOfflineProcess = 9, kPlugCategShell = 10, kPlugCategGenerator = 11,
};

// audioMasterGetCurrentProcessLevel
enum : int32_t { kVstProcessLevelUnknown = 0, kVstProcessLevelUser = 1, kVstProcessLevelRealtime = 2, kVstProcessLevelOffline = 4 };

// sizes plugins expect for the strings they write
constexpr int kMaxNameLen = 64;                   // effGetEffectName / vendor / product / names in practice
constexpr int kMaxParamStrLen = 8;                // nominal; plugins often write more, so hosts pass bigger buffers

struct ERect { int16_t top, left, bottom, right; };

// events
enum : int32_t { kVstMidiType = 1, kVstSysExType = 6 };
enum : int32_t { kVstMidiEventIsRealtime = 1 };

struct VstEvent {
  int32_t type;
  int32_t byteSize;                               // sizeof(VstEvent) - 2 * sizeof(int32_t)
  int32_t deltaFrames;
  int32_t flags;
  char data[16];
};

struct VstMidiEvent {
  int32_t type;                                   // kVstMidiType
  int32_t byteSize;                               // sizeof(VstMidiEvent)
  int32_t deltaFrames;                            // offset in the block
  int32_t flags;
  int32_t noteLength;
  int32_t noteOffset;
  char midiData[4];
  char detune;
  char noteOffVelocity;
  char reserved1;
  char reserved2;
};

// effProcessEvents: a count and an array of pointers (the array is as long as the count)
template <int N>
struct VstEventsN {
  int32_t numEvents;
  intptr_t reserved;
  VstEvent* events[N];
};
struct VstEvents {
  int32_t numEvents;
  intptr_t reserved;
  VstEvent* events[2];
};

// audioMasterGetTime
enum : int32_t {
  kVstTransportChanged = 1, kVstTransportPlaying = 1 << 1, kVstTransportCycleActive = 1 << 2, kVstTransportRecording = 1 << 3,
  kVstNanosValid = 1 << 8, kVstPpqPosValid = 1 << 9, kVstTempoValid = 1 << 10, kVstBarsValid = 1 << 11,
  kVstCyclePosValid = 1 << 12, kVstTimeSigValid = 1 << 13, kVstSmpteValid = 1 << 14, kVstClockValid = 1 << 15,
};

struct VstTimeInfo {
  double samplePos;
  double sampleRate;
  double nanoSeconds;
  double ppqPos;
  double tempo;
  double barStartPos;
  double cycleStartPos;
  double cycleEndPos;
  int32_t timeSigNumerator;
  int32_t timeSigDenominator;
  int32_t smpteOffset;
  int32_t smpteFrameRate;
  int32_t samplesToNextClock;
  int32_t flags;
};

// effGetParameterProperties
enum : int32_t {
  kVstParameterIsSwitch = 1 << 0, kVstParameterUsesIntegerMinMax = 1 << 1, kVstParameterUsesFloatStep = 1 << 2,
  kVstParameterUsesIntStep = 1 << 3, kVstParameterSupportsDisplayIndex = 1 << 4,
  kVstParameterSupportsDisplayCategory = 1 << 5, kVstParameterCanRamp = 1 << 6,
};

struct VstParameterProperties {
  float stepFloat;
  float smallStepFloat;
  float largeStepFloat;
  char label[64];
  int32_t flags;
  int32_t minInteger;
  int32_t maxInteger;
  int32_t stepInteger;
  int32_t largeStepInteger;
  char shortLabel[8];
  int16_t displayIndex;
  int16_t category;
  int16_t numParametersInCategory;
  int16_t reserved;
  char categoryLabel[24];
  char future[16];
};

static_assert(sizeof(VstMidiEvent) == 32, "VstMidiEvent layout");
static_assert(sizeof(VstEvent) == 32, "VstEvent layout");
static_assert(sizeof(VstTimeInfo) == 88, "VstTimeInfo layout");
static_assert(sizeof(VstParameterProperties) == 152, "VstParameterProperties layout");
static_assert(sizeof(ERect) == 8, "ERect layout");

}  // namespace vst2
