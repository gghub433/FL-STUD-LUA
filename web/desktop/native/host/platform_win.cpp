// Windows main loop: a message loop with a hidden window that receives posted work and timers. Plugin editors live in
// ordinary top-level windows owned by FL LUA's window (so they stay above it and minimize with it).
#include "platform.h"

#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>

#include <algorithm>
#include <map>
#include <mutex>
#include <vector>

namespace plat {

namespace {
constexpr UINT WM_RUN = WM_APP + 1;
HWND hidden = nullptr;
DWORD mainId = 0;
std::mutex qmu;
std::vector<std::function<void()>> queue;
std::map<UINT_PTR, std::function<void()>> timers;
UINT_PTR nextTimer = 1;
const wchar_t* kWinClass = L"FLLUAPluginWindow";

std::wstring wide(const std::string& s) {
  if (s.empty()) return L"";
  int n = MultiByteToWideChar(CP_UTF8, 0, s.data(), (int)s.size(), nullptr, 0);
  std::wstring w((size_t)n, L'\0');
  MultiByteToWideChar(CP_UTF8, 0, s.data(), (int)s.size(), &w[0], n);
  return w;
}

LRESULT CALLBACK hiddenProc(HWND h, UINT msg, WPARAM wp, LPARAM lp) {
  if (msg == WM_RUN) {
    std::vector<std::function<void()>> q;
    { std::lock_guard<std::mutex> l(qmu); q.swap(queue); }
    for (auto& f : q) f();
    return 0;
  }
  if (msg == WM_TIMER) {
    auto it = timers.find((UINT_PTR)wp);
    if (it != timers.end()) { auto cb = it->second; cb(); }
    return 0;
  }
  return DefWindowProcW(h, msg, wp, lp);
}
}  // namespace

struct Window {
  HWND hwnd = nullptr;
  WindowCallbacks cb;
  bool resizable = false;
  bool sizing = false;
};

namespace {
DWORD styleOf(bool resizable) { return resizable ? WS_OVERLAPPEDWINDOW : (WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU | WS_MINIMIZEBOX); }

// window size for a content (client) size
SIZE outerSize(HWND h, bool resizable, int w, int ht) {
  RECT r{0, 0, w, ht};
  UINT dpi = h ? GetDpiForWindow(h) : 96;
  AdjustWindowRectExForDpi(&r, styleOf(resizable), FALSE, 0, dpi ? dpi : 96);
  return SIZE{r.right - r.left, r.bottom - r.top};
}

LRESULT CALLBACK winProc(HWND h, UINT msg, WPARAM wp, LPARAM lp) {
  auto* w = reinterpret_cast<Window*>(GetWindowLongPtrW(h, GWLP_USERDATA));
  switch (msg) {
    case WM_CLOSE:
      if (w && w->cb.close) w->cb.close();
      return 0;
    case WM_SIZE:
      if (w && !w->sizing && wp != SIZE_MINIMIZED && w->cb.resized) w->cb.resized(LOWORD(lp), HIWORD(lp));
      return 0;
    case WM_DPICHANGED: {
      auto* r = reinterpret_cast<RECT*>(lp);
      SetWindowPos(h, nullptr, r->left, r->top, r->right - r->left, r->bottom - r->top, SWP_NOZORDER | SWP_NOACTIVATE);
      return 0;
    }
    case WM_ERASEBKGND:
      return 1;
  }
  return DefWindowProcW(h, msg, wp, lp);
}
}  // namespace

void init() {
  mainId = GetCurrentThreadId();
  OleInitialize(nullptr);
  WNDCLASSEXW hc{sizeof hc};
  hc.lpfnWndProc = hiddenProc;
  hc.hInstance = GetModuleHandleW(nullptr);
  hc.lpszClassName = L"FLLUAHostMessages";
  RegisterClassExW(&hc);
  hidden = CreateWindowExW(0, hc.lpszClassName, L"", 0, 0, 0, 0, 0, HWND_MESSAGE, nullptr, hc.hInstance, nullptr);
  WNDCLASSEXW wc{sizeof wc};
  wc.lpfnWndProc = winProc;
  wc.hInstance = GetModuleHandleW(nullptr);
  wc.hCursor = LoadCursor(nullptr, IDC_ARROW);
  wc.hbrBackground = (HBRUSH)GetStockObject(BLACK_BRUSH);
  wc.lpszClassName = kWinClass;
  wc.hIcon = LoadIcon(nullptr, IDI_APPLICATION);
  RegisterClassExW(&wc);
}

bool isMainThread() { return GetCurrentThreadId() == mainId; }

void post(std::function<void()> fn) {
  { std::lock_guard<std::mutex> l(qmu); queue.push_back(std::move(fn)); }
  PostMessageW(hidden, WM_RUN, 0, 0);
}

void run() {
  MSG m;
  while (GetMessageW(&m, nullptr, 0, 0) > 0) {
    TranslateMessage(&m);
    DispatchMessageW(&m);
  }
}

void quit() { post([] { PostQuitMessage(0); }); }

uint64_t addTimer(int ms, std::function<void()> cb) {
  UINT_PTR id = nextTimer++;
  timers[id] = std::move(cb);
  SetTimer(hidden, id, (UINT)std::max(1, ms), nullptr);
  return id;
}
void removeTimer(uint64_t id) {
  KillTimer(hidden, (UINT_PTR)id);
  timers.erase((UINT_PTR)id);
}

uint64_t addFd(int, int, std::function<void(int)>) { return 0; }
void removeFd(uint64_t) {}

Window* createWindow(const std::string& title, int w, int h, bool resizable, uint64_t owner, WindowCallbacks cb) {
  auto* win = new Window();
  win->cb = std::move(cb);
  win->resizable = resizable;
  SIZE s = outerSize(nullptr, resizable, w, h);
  win->hwnd = CreateWindowExW(WS_EX_DLGMODALFRAME, kWinClass, wide(title).c_str(), styleOf(resizable) | WS_CLIPCHILDREN, CW_USEDEFAULT, CW_USEDEFAULT, s.cx, s.cy,
                              owner ? (HWND)(uintptr_t)owner : nullptr, nullptr, GetModuleHandleW(nullptr), nullptr);
  if (!win->hwnd) { delete win; return nullptr; }
  SetWindowLongPtrW(win->hwnd, GWLP_USERDATA, (LONG_PTR)win);
  setContentSize(win, w, h);          // again, now with the window's own DPI
  return win;
}

void* nativeHandle(Window* w) { return w ? (void*)w->hwnd : nullptr; }

void setContentSize(Window* w, int width, int height) {
  if (!w || width <= 0 || height <= 0) return;
  SIZE s = outerSize(w->hwnd, w->resizable, width, height);
  w->sizing = true;
  SetWindowPos(w->hwnd, nullptr, 0, 0, s.cx, s.cy, SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE);
  w->sizing = false;
}

void setResizable(Window* w, bool resizable) {
  if (!w) return;
  w->resizable = resizable;
  SetWindowLongPtrW(w->hwnd, GWL_STYLE, (LONG_PTR)(styleOf(resizable) | WS_CLIPCHILDREN | WS_VISIBLE));
  SetWindowPos(w->hwnd, nullptr, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_FRAMECHANGED);
}

void setTitle(Window* w, const std::string& title) { if (w) SetWindowTextW(w->hwnd, wide(title).c_str()); }

void show(Window* w) {
  if (!w) return;
  ShowWindow(w->hwnd, IsIconic(w->hwnd) ? SW_RESTORE : SW_SHOW);
  SetForegroundWindow(w->hwnd);
}
void hide(Window* w) { if (w) ShowWindow(w->hwnd, SW_HIDE); }

void destroyWindow(Window* w) {
  if (!w) return;
  SetWindowLongPtrW(w->hwnd, GWLP_USERDATA, 0);
  DestroyWindow(w->hwnd);
  delete w;
}

double scaleFactor(Window* w) {
  UINT dpi = w ? GetDpiForWindow(w->hwnd) : 96;
  return dpi ? dpi / 96.0 : 1.0;
}
const char* vst3PlatformType() { return "HWND"; }
const char* clapWindowApi() { return "win32"; }

}  // namespace plat
