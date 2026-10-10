// Small helpers shared by the format modules.
#pragma once
#include <array>
#include <atomic>
#include <cstdint>
#include <string>

// single-producer single-consumer queue without locks or allocation (audio thread <-> main thread)
template <class T, size_t N>
class SpscQueue {
 public:
  bool push(const T& v) {
    size_t h = head_.load(std::memory_order_relaxed), n = (h + 1) % N;
    if (n == tail_.load(std::memory_order_acquire)) return false;
    buf_[h] = v;
    head_.store(n, std::memory_order_release);
    return true;
  }
  bool pop(T& v) {
    size_t t = tail_.load(std::memory_order_relaxed);
    if (t == head_.load(std::memory_order_acquire)) return false;
    v = buf_[t];
    tail_.store((t + 1) % N, std::memory_order_release);
    return true;
  }

 private:
  std::array<T, N> buf_{};
  std::atomic<size_t> head_{0}, tail_{0};
};

struct ParamMsg { uint32_t id; double value; };

// UTF-16 (VST3 strings) to UTF-8
inline std::string utf8(const char16_t* s, size_t max = 4096) {
  std::string o;
  for (size_t i = 0; i < max && s[i]; i++) {
    uint32_t c = s[i];
    if (c >= 0xD800 && c < 0xDC00 && s[i + 1] >= 0xDC00 && s[i + 1] < 0xE000) { c = 0x10000 + ((c - 0xD800) << 10) + (s[i + 1] - 0xDC00); i++; }
    if (c < 0x80) o += (char)c;
    else if (c < 0x800) { o += (char)(0xC0 | (c >> 6)); o += (char)(0x80 | (c & 0x3F)); }
    else if (c < 0x10000) { o += (char)(0xE0 | (c >> 12)); o += (char)(0x80 | ((c >> 6) & 0x3F)); o += (char)(0x80 | (c & 0x3F)); }
    else { o += (char)(0xF0 | (c >> 18)); o += (char)(0x80 | ((c >> 12) & 0x3F)); o += (char)(0x80 | ((c >> 6) & 0x3F)); o += (char)(0x80 | (c & 0x3F)); }
  }
  return o;
}

inline void toUtf16(const std::string& s, char16_t* out, size_t max) {
  size_t o = 0;
  for (size_t i = 0; i < s.size() && o + 1 < max;) {
    uint32_t c = (unsigned char)s[i];
    int n = c < 0x80 ? 1 : c < 0xE0 ? 2 : c < 0xF0 ? 3 : 4;
    if (n == 2) c = ((c & 0x1F) << 6) | (s[i + 1] & 0x3F);
    else if (n == 3) c = ((c & 0x0F) << 12) | ((s[i + 1] & 0x3F) << 6) | (s[i + 2] & 0x3F);
    else if (n == 4) c = ((c & 0x07) << 18) | ((s[i + 1] & 0x3F) << 12) | ((s[i + 2] & 0x3F) << 6) | (s[i + 3] & 0x3F);
    i += (size_t)n;
    if (c >= 0x10000 && o + 2 < max) { c -= 0x10000; out[o++] = (char16_t)(0xD800 + (c >> 10)); out[o++] = (char16_t)(0xDC00 + (c & 0x3FF)); }
    else out[o++] = (char16_t)c;
  }
  out[o] = 0;
}

inline std::string trimNul(const char* s, size_t max) {
  size_t n = 0;
  while (n < max && s[n]) n++;
  return std::string(s, n);
}
