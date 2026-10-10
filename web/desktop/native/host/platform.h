// The host's main thread: event loop, timers, file descriptors (Linux) and the windows that hold plugin editors.
//   Linux: X11 (platform_x11.cpp)   Windows: Win32 (platform_win.cpp)   macOS: Cocoa (platform_mac.mm)
#pragma once
#include <cstdint>
#include <functional>
#include <string>

namespace plat {

void init();
void run();                     // until quit()
void quit();
bool isMainThread();
void post(std::function<void()> fn);          // from any thread: runs fn on the main thread

uint64_t addTimer(int ms, std::function<void()> cb);
void removeTimer(uint64_t id);
// Linux only (VST3 IRunLoop, CLAP posix-fd-support); flags: 1 read, 2 write, 4 error
uint64_t addFd(int fd, int flags, std::function<void(int flags)> cb);
void removeFd(uint64_t id);

struct Window;
struct WindowCallbacks {
  std::function<void()> close;                  // the person closed the window
  std::function<void(int, int)> resized;        // new content size (logical pixels on macOS, physical elsewhere)
};
// owner: the FL LUA window it belongs to (HWND / X11 window id as a number; ignored on macOS)
Window* createWindow(const std::string& title, int w, int h, bool resizable, uint64_t owner, WindowCallbacks cb);
void* nativeHandle(Window* w);                  // HWND, NSView* or the X11 Window id
void setContentSize(Window* w, int width, int height);
void setResizable(Window* w, bool resizable);
void setTitle(Window* w, const std::string& title);
void show(Window* w);
void hide(Window* w);
void destroyWindow(Window* w);
double scaleFactor(Window* w);                  // HiDPI scale (Windows / Linux), 1 on macOS (points)

const char* vst3PlatformType();                  // kPlatformTypeHWND / NSView / X11EmbedWindowID
const char* clapWindowApi();                     // CLAP_WINDOW_API_WIN32 / COCOA / X11

}  // namespace plat
