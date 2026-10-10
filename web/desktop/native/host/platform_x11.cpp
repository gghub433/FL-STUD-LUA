// Linux main loop: poll() over a wake-up pipe, the X11 connection and the descriptors plugins register, with the
// nearest timer as the timeout. Plugin editors live in plain X11 top-level windows.
#include "platform.h"

#include <X11/Xatom.h>
#include <X11/Xlib.h>
#include <X11/Xutil.h>
#include <fcntl.h>
#include <poll.h>
#include <unistd.h>

#include <algorithm>
#include <chrono>
#include <map>
#include <mutex>
#include <thread>
#include <vector>

namespace plat {

namespace {
using Clock = std::chrono::steady_clock;
struct Timer { int ms; Clock::time_point next; std::function<void()> cb; };
struct Fd { int fd; int flags; std::function<void(int)> cb; };

Display* dpy = nullptr;
Atom wmDelete = 0, wmProtocols = 0;
int wake[2] = {-1, -1};
std::mutex qmu;
std::vector<std::function<void()>> queue;
std::map<uint64_t, Timer> timers;
std::map<uint64_t, Fd> fds;
uint64_t nextId = 1;
bool running = false;
std::thread::id mainId;
std::map<::Window, Window*> windows;
}  // namespace

struct Window {
  ::Window id = 0;
  WindowCallbacks cb;
  int w = 0, h = 0;
  bool resizable = false;
};

void init() {
  mainId = std::this_thread::get_id();
  XInitThreads();
  if (pipe(wake) == 0) { fcntl(wake[0], F_SETFL, O_NONBLOCK); fcntl(wake[1], F_SETFL, O_NONBLOCK); }
  dpy = XOpenDisplay(nullptr);           // may be null without a display: plugins still process audio
  if (dpy) {
    wmDelete = XInternAtom(dpy, "WM_DELETE_WINDOW", False);
    wmProtocols = XInternAtom(dpy, "WM_PROTOCOLS", False);
  }
}

bool isMainThread() { return std::this_thread::get_id() == mainId; }

void post(std::function<void()> fn) {
  { std::lock_guard<std::mutex> l(qmu); queue.push_back(std::move(fn)); }
  char c = 1;
  ssize_t r = write(wake[1], &c, 1);
  (void)r;
}

uint64_t addTimer(int ms, std::function<void()> cb) {
  uint64_t id = nextId++;
  timers[id] = Timer{std::max(1, ms), Clock::now() + std::chrono::milliseconds(std::max(1, ms)), std::move(cb)};
  return id;
}
void removeTimer(uint64_t id) { timers.erase(id); }

uint64_t addFd(int fd, int flags, std::function<void(int)> cb) {
  uint64_t id = nextId++;
  fds[id] = Fd{fd, flags, std::move(cb)};
  return id;
}
void removeFd(uint64_t id) { fds.erase(id); }

static void handleX() {
  while (dpy && XPending(dpy)) {
    XEvent e;
    XNextEvent(dpy, &e);
    auto it = windows.find(e.xany.window);
    if (it == windows.end()) continue;
    Window* w = it->second;
    if (e.type == ClientMessage && (Atom)e.xclient.message_type == wmProtocols && (Atom)e.xclient.data.l[0] == wmDelete) {
      if (w->cb.close) w->cb.close();
    } else if (e.type == ConfigureNotify) {
      if (e.xconfigure.width != w->w || e.xconfigure.height != w->h) {
        w->w = e.xconfigure.width; w->h = e.xconfigure.height;
        if (w->cb.resized) w->cb.resized(w->w, w->h);
      }
    }
  }
}

void run() {
  running = true;
  while (running) {
    std::vector<pollfd> p;
    p.push_back({wake[0], POLLIN, 0});
    if (dpy) p.push_back({ConnectionNumber(dpy), POLLIN, 0});
    std::vector<uint64_t> ids;
    for (auto& kv : fds) {
      short ev = 0;
      if (kv.second.flags & 1) ev |= POLLIN;
      if (kv.second.flags & 2) ev |= POLLOUT;
      p.push_back({kv.second.fd, ev, 0});
      ids.push_back(kv.first);
    }
    auto now = Clock::now();
    int timeout = 50;
    for (auto& kv : timers) {
      auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(kv.second.next - now).count();
      timeout = (int)std::max<int64_t>(0, std::min<int64_t>(timeout, ms));
    }
    if (dpy && XPending(dpy)) timeout = 0;
    poll(p.data(), p.size(), timeout);

    if (p[0].revents & POLLIN) { char buf[256]; while (read(wake[0], buf, sizeof buf) > 0) {} }
    std::vector<std::function<void()>> q;
    { std::lock_guard<std::mutex> l(qmu); q.swap(queue); }
    for (auto& f : q) f();
    handleX();
    size_t base = dpy ? 2 : 1;
    for (size_t i = 0; i < ids.size(); i++) {
      short r = p[base + i].revents;
      if (!r) continue;
      auto it = fds.find(ids[i]);
      if (it == fds.end()) continue;
      int fl = ((r & POLLIN) ? 1 : 0) | ((r & POLLOUT) ? 2 : 0) | ((r & (POLLERR | POLLHUP)) ? 4 : 0);
      auto cb = it->second.cb;
      cb(fl);
    }
    now = Clock::now();
    std::vector<uint64_t> due;
    for (auto& kv : timers) if (kv.second.next <= now) due.push_back(kv.first);
    for (auto id : due) {
      auto it = timers.find(id);
      if (it == timers.end()) continue;
      it->second.next = now + std::chrono::milliseconds(it->second.ms);
      auto cb = it->second.cb;
      cb();
    }
    if (dpy) XFlush(dpy);
  }
}

void quit() { running = false; post([] {}); }

Window* createWindow(const std::string& title, int w, int h, bool resizable, uint64_t owner, WindowCallbacks cb) {
  if (!dpy) return nullptr;
  auto* win = new Window();
  win->cb = std::move(cb);
  win->w = std::max(1, w); win->h = std::max(1, h);
  win->resizable = resizable;
  int screen = DefaultScreen(dpy);
  XSetWindowAttributes a{};
  a.background_pixel = BlackPixel(dpy, screen);
  a.event_mask = StructureNotifyMask;
  win->id = XCreateWindow(dpy, RootWindow(dpy, screen), 80, 80, (unsigned)win->w, (unsigned)win->h, 0, CopyFromParent, InputOutput, CopyFromParent, CWBackPixel | CWEventMask, &a);
  XSetWMProtocols(dpy, win->id, &wmDelete, 1);
  if (owner) XSetTransientForHint(dpy, win->id, (::Window)owner);
  windows[win->id] = win;
  setTitle(win, title);
  setResizable(win, resizable);
  XFlush(dpy);
  return win;
}

void* nativeHandle(Window* w) { return w ? reinterpret_cast<void*>(static_cast<uintptr_t>(w->id)) : nullptr; }

void setResizable(Window* w, bool resizable) {
  if (!w) return;
  w->resizable = resizable;
  XSizeHints* hints = XAllocSizeHints();
  hints->flags = PMinSize | PMaxSize;
  if (resizable) { hints->min_width = 64; hints->min_height = 48; hints->max_width = 16384; hints->max_height = 16384; }
  else { hints->min_width = hints->max_width = w->w; hints->min_height = hints->max_height = w->h; }
  XSetWMNormalHints(dpy, w->id, hints);
  XFree(hints);
}

void setContentSize(Window* w, int width, int height) {
  if (!w || width <= 0 || height <= 0) return;
  w->w = width; w->h = height;
  if (!w->resizable) setResizable(w, false);
  XResizeWindow(dpy, w->id, (unsigned)width, (unsigned)height);
  XFlush(dpy);
}

void setTitle(Window* w, const std::string& title) {
  if (!w) return;
  Atom utf8 = XInternAtom(dpy, "UTF8_STRING", False), name = XInternAtom(dpy, "_NET_WM_NAME", False);
  XChangeProperty(dpy, w->id, name, utf8, 8, PropModeReplace, reinterpret_cast<const unsigned char*>(title.c_str()), (int)title.size());
  XStoreName(dpy, w->id, title.c_str());
}

void show(Window* w) { if (w) { XMapRaised(dpy, w->id); XFlush(dpy); } }
void hide(Window* w) { if (w) { XUnmapWindow(dpy, w->id); XFlush(dpy); } }

void destroyWindow(Window* w) {
  if (!w) return;
  windows.erase(w->id);
  XDestroyWindow(dpy, w->id);
  XFlush(dpy);
  delete w;
}

double scaleFactor(Window*) { return 1.0; }
const char* vst3PlatformType() { return "X11EmbedWindowID"; }
const char* clapWindowApi() { return "x11"; }

}  // namespace plat
