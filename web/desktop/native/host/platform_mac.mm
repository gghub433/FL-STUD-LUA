// macOS main loop: NSApplication (as an accessory app: no Dock icon, but its windows can come to the front).
// Plugin editors live in NSWindows; plugins get the window's content NSView.
#import <Cocoa/Cocoa.h>
#include <pthread.h>

#include <map>
#include <memory>

#include "platform.h"

namespace plat {
struct Window;
}

@interface FLWindowDelegate : NSObject <NSWindowDelegate>
@property(nonatomic) plat::Window* owner;
@end

namespace plat {

struct Window {
  NSWindow* win = nil;
  FLWindowDelegate* del = nil;
  WindowCallbacks cb;
  bool resizable = false;
  bool sizing = false;
};

namespace {
std::map<uint64_t, NSTimer*> timers;
uint64_t nextId = 1;
NSWindowStyleMask styleOf(bool resizable) {
  NSWindowStyleMask m = NSWindowStyleMaskTitled | NSWindowStyleMaskClosable | NSWindowStyleMaskMiniaturizable;
  if (resizable) m |= NSWindowStyleMaskResizable;
  return m;
}
}  // namespace

void init() {
  [NSApplication sharedApplication];
  [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
  [NSApp finishLaunching];
}

bool isMainThread() { return pthread_main_np() != 0; }

void post(std::function<void()> fn) {
  auto f = std::make_shared<std::function<void()>>(std::move(fn));
  dispatch_async(dispatch_get_main_queue(), ^{ (*f)(); });
}

void run() { [NSApp run]; }

void quit() {
  post([] {
    [NSApp stop:nil];
    NSEvent* e = [NSEvent otherEventWithType:NSEventTypeApplicationDefined location:NSZeroPoint modifierFlags:0 timestamp:0
                                windowNumber:0 context:nil subtype:0 data1:0 data2:0];
    [NSApp postEvent:e atStart:YES];       // run returns after the next event
  });
}

uint64_t addTimer(int ms, std::function<void()> cb) {
  uint64_t id = nextId++;
  auto f = std::make_shared<std::function<void()>>(std::move(cb));
  NSTimer* t = [NSTimer timerWithTimeInterval:(ms > 0 ? ms : 1) / 1000.0 repeats:YES block:^(NSTimer*) { (*f)(); }];
  [[NSRunLoop mainRunLoop] addTimer:t forMode:NSRunLoopCommonModes];
  timers[id] = t;
  return id;
}

void removeTimer(uint64_t id) {
  auto it = timers.find(id);
  if (it == timers.end()) return;
  [it->second invalidate];
  timers.erase(it);
}

uint64_t addFd(int, int, std::function<void(int)>) { return 0; }
void removeFd(uint64_t) {}

Window* createWindow(const std::string& title, int w, int h, bool resizable, uint64_t, WindowCallbacks cb) {
  auto* win = new Window();
  win->cb = std::move(cb);
  win->resizable = resizable;
  NSRect r = NSMakeRect(0, 0, w > 0 ? w : 1, h > 0 ? h : 1);
  win->win = [[NSWindow alloc] initWithContentRect:r styleMask:styleOf(resizable) backing:NSBackingStoreBuffered defer:NO];
  [win->win setReleasedWhenClosed:NO];
  [win->win setContentView:[[NSView alloc] initWithFrame:r]];
  win->del = [FLWindowDelegate new];
  win->del.owner = win;
  [win->win setDelegate:win->del];
  setTitle(win, title);
  [win->win center];
  return win;
}

void* nativeHandle(Window* w) { return w ? (__bridge void*)[w->win contentView] : nullptr; }

void setContentSize(Window* w, int width, int height) {
  if (!w || width <= 0 || height <= 0) return;
  w->sizing = true;
  [w->win setContentSize:NSMakeSize(width, height)];
  w->sizing = false;
}

void setResizable(Window* w, bool resizable) {
  if (!w) return;
  w->resizable = resizable;
  [w->win setStyleMask:styleOf(resizable)];
}

void setTitle(Window* w, const std::string& title) {
  if (w) [w->win setTitle:[NSString stringWithUTF8String:title.c_str()]];
}

void show(Window* w) {
  if (!w) return;
  [w->win makeKeyAndOrderFront:nil];
  [NSApp activateIgnoringOtherApps:YES];
}

void hide(Window* w) { if (w) [w->win orderOut:nil]; }

void destroyWindow(Window* w) {
  if (!w) return;
  [w->win setDelegate:nil];
  w->del.owner = nullptr;
  [w->win orderOut:nil];
  [w->win close];
  delete w;
}

double scaleFactor(Window*) { return 1.0; }
const char* vst3PlatformType() { return "NSView"; }
const char* clapWindowApi() { return "cocoa"; }

}  // namespace plat

@implementation FLWindowDelegate
- (BOOL)windowShouldClose:(NSWindow*)sender {
  (void)sender;
  if (self.owner && self.owner->cb.close) self.owner->cb.close();
  return NO;
}
- (void)windowDidResize:(NSNotification*)n {
  plat::Window* w = self.owner;
  if (!w || w->sizing || !w->cb.resized) return;
  NSRect r = [[w->win contentView] frame];
  w->cb.resized((int)r.size.width, (int)r.size.height);
}
@end
