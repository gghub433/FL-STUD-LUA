// Cross-process shared memory and "doorbells" (wait until a 32-bit counter in shared memory changes).
//   Linux:   shm_open + futex on the shared word
//   macOS:   shm_open + __ulock_wait / __ulock_wake (shared variant), the call libc++ uses for std::atomic::wait
//   Windows: named file mapping + a named auto-reset event per doorbell
#pragma once
#include <atomic>
#include <cstdint>
#include <cstring>
#include <string>

#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#else
#include <fcntl.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <unistd.h>
#include <cerrno>
#include <ctime>
#ifdef __linux__
#include <linux/futex.h>
#include <sys/syscall.h>
#endif
#endif

#ifdef __APPLE__
extern "C" int __ulock_wait(uint32_t operation, void* addr, uint64_t value, uint32_t timeout_us);
extern "C" int __ulock_wake(uint32_t operation, void* addr, uint64_t wake_value);
#endif

namespace fl {

inline std::atomic<uint32_t>& word(uint32_t* p) { return *reinterpret_cast<std::atomic<uint32_t>*>(p); }

class SharedMemory {
 public:
  ~SharedMemory() { close(); }
  // create = true makes a new segment (the host); false opens an existing one (the bridge)
  bool open(const std::string& name, size_t size, bool create) {
    size_ = size; name_ = name; owner_ = create;
#ifdef _WIN32
    std::wstring w = L"Local\\" + std::wstring(name.begin(), name.end());
    if (create) h_ = CreateFileMappingW(INVALID_HANDLE_VALUE, nullptr, PAGE_READWRITE, (DWORD)((uint64_t)size >> 32), (DWORD)(size & 0xffffffff), w.c_str());
    else h_ = OpenFileMappingW(FILE_MAP_ALL_ACCESS, FALSE, w.c_str());
    if (!h_) return false;
    p_ = MapViewOfFile(h_, FILE_MAP_ALL_ACCESS, 0, 0, size);
    if (!p_) { CloseHandle(h_); h_ = nullptr; return false; }
#else
    std::string n = "/" + name;
    int fd = create ? shm_open(n.c_str(), O_CREAT | O_RDWR | O_EXCL, 0600) : shm_open(n.c_str(), O_RDWR, 0600);
    if (fd < 0) return false;
    if (create && ftruncate(fd, (off_t)size) != 0) { ::close(fd); shm_unlink(n.c_str()); return false; }
    p_ = mmap(nullptr, size, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
    ::close(fd);
    if (p_ == MAP_FAILED) { p_ = nullptr; if (create) shm_unlink(n.c_str()); return false; }
#endif
    if (create) std::memset(p_, 0, size);
    return true;
  }
  void close() {
#ifdef _WIN32
    if (p_) UnmapViewOfFile(p_);
    if (h_) CloseHandle(h_);
    h_ = nullptr;
#else
    if (p_) munmap(p_, size_);
    if (owner_ && !name_.empty()) shm_unlink(("/" + name_).c_str());
#endif
    p_ = nullptr; name_.clear();
  }
  // the host removes the name once the bridge has opened the segment (it stays mapped in both)
  void unlinkName() {
#ifndef _WIN32
    if (owner_ && !name_.empty()) shm_unlink(("/" + name_).c_str());
#endif
    owner_ = false;
  }
  void* data() const { return p_; }

 private:
  void* p_ = nullptr;
  size_t size_ = 0;
  std::string name_;
  bool owner_ = false;
#ifdef _WIN32
  HANDLE h_ = nullptr;
#endif
};

// A doorbell rings when its counter changes. The counter lives in the shared memory.
class Doorbell {
 public:
  ~Doorbell() {
#ifdef _WIN32
    if (ev_) CloseHandle(ev_);
#endif
  }
  bool open(uint32_t* counter, const std::string& name, bool create) {
    c_ = counter;
#ifdef _WIN32
    std::wstring w = L"Local\\" + std::wstring(name.begin(), name.end());
    ev_ = create ? CreateEventW(nullptr, FALSE, FALSE, w.c_str()) : OpenEventW(EVENT_MODIFY_STATE | SYNCHRONIZE, FALSE, w.c_str());
    return ev_ != nullptr;
#else
    (void)name; (void)create;
    return true;
#endif
  }
  uint32_t load() const { return word(c_).load(std::memory_order_acquire); }
  // publish a new value and wake the other side
  void ring(uint32_t v) {
    word(c_).store(v, std::memory_order_release);
#ifdef _WIN32
    SetEvent(ev_);
#elif defined(__linux__)
    syscall(SYS_futex, c_, FUTEX_WAKE, 1, nullptr, nullptr, 0);
#elif defined(__APPLE__)
    __ulock_wake(3 /* UL_COMPARE_AND_WAIT_SHARED */, c_, 0);
#endif
  }
  // wait while the counter equals `seen`; false on timeout
  bool wait(uint32_t seen, int timeoutMs) {
    if (load() != seen) return true;
#ifdef _WIN32
    WaitForSingleObject(ev_, (DWORD)timeoutMs);
#elif defined(__linux__)
    struct timespec ts { timeoutMs / 1000, (long)(timeoutMs % 1000) * 1000000L };
    syscall(SYS_futex, c_, FUTEX_WAIT, seen, &ts, nullptr, 0);
#elif defined(__APPLE__)
    __ulock_wait(3 /* UL_COMPARE_AND_WAIT_SHARED */, c_, seen, (uint32_t)timeoutMs * 1000);
#endif
    return load() != seen;
  }

 private:
  uint32_t* c_ = nullptr;
#ifdef _WIN32
  HANDLE ev_ = nullptr;
#endif
};

// sleep for a short time (used by the bridge to look for new blocks from the AudioWorklet)
inline void shortSleep(int micros) {
#ifdef _WIN32
  static thread_local HANDLE timer = CreateWaitableTimerExW(nullptr, nullptr, 0x00000002 /* CREATE_WAITABLE_TIMER_HIGH_RESOLUTION */, TIMER_ALL_ACCESS);
  if (timer) {
    LARGE_INTEGER due; due.QuadPart = -10LL * micros;
    if (SetWaitableTimer(timer, &due, 0, nullptr, nullptr, FALSE)) { WaitForSingleObject(timer, 5); return; }
  }
  Sleep(micros >= 1000 ? micros / 1000 : 0);
#else
  struct timespec ts { 0, (long)micros * 1000L };
  nanosleep(&ts, nullptr);
#endif
}

}  // namespace fl
