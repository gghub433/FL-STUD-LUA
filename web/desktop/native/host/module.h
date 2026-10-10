// Loading plugin binaries: a dynamic library on Windows / Linux, a CFBundle on macOS. Paths are UTF-8.
#pragma once
#include <string>
#include <vector>

#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#else
#include <dlfcn.h>
#include <sys/stat.h>
#endif
#ifdef __APPLE__
#include <CoreFoundation/CoreFoundation.h>
#endif

namespace mod {

#ifdef _WIN32
inline std::wstring wide(const std::string& s) {
  if (s.empty()) return L"";
  int n = MultiByteToWideChar(CP_UTF8, 0, s.data(), (int)s.size(), nullptr, 0);
  std::wstring w((size_t)n, L'\0');
  MultiByteToWideChar(CP_UTF8, 0, s.data(), (int)s.size(), &w[0], n);
  return w;
}
inline std::string narrow(const std::wstring& w) {
  if (w.empty()) return "";
  int n = WideCharToMultiByte(CP_UTF8, 0, w.data(), (int)w.size(), nullptr, 0, nullptr, nullptr);
  std::string s((size_t)n, '\0');
  WideCharToMultiByte(CP_UTF8, 0, w.data(), (int)w.size(), &s[0], n, nullptr, nullptr);
  return s;
}
#endif

inline bool isDir(const std::string& p) {
#ifdef _WIN32
  DWORD a = GetFileAttributesW(wide(p).c_str());
  return a != INVALID_FILE_ATTRIBUTES && (a & FILE_ATTRIBUTE_DIRECTORY);
#else
  struct stat st;
  return stat(p.c_str(), &st) == 0 && S_ISDIR(st.st_mode);
#endif
}

inline bool exists(const std::string& p) {
#ifdef _WIN32
  return GetFileAttributesW(wide(p).c_str()) != INVALID_FILE_ATTRIBUTES;
#else
  struct stat st;
  return stat(p.c_str(), &st) == 0;
#endif
}

inline std::string stem(const std::string& p) {
  std::string s = p;
  while (!s.empty() && (s.back() == '/' || s.back() == '\\')) s.pop_back();
  size_t slash = s.find_last_of("/\\");
  if (slash != std::string::npos) s = s.substr(slash + 1);
  size_t dot = s.find_last_of('.');
  return dot == std::string::npos ? s : s.substr(0, dot);
}

inline std::string readFile(const std::string& p) {
#ifdef _WIN32
  FILE* f = _wfopen(wide(p).c_str(), L"rb");
#else
  FILE* f = fopen(p.c_str(), "rb");
#endif
  if (!f) return "";
  std::string out;
  char buf[65536];
  size_t n;
  while ((n = fread(buf, 1, sizeof buf, f)) > 0) out.append(buf, n);
  fclose(f);
  return out;
}

class Library {
 public:
  ~Library() { close(); }
  bool open(const std::string& path, std::string& error) {
#ifdef __APPLE__
    CFStringRef s = CFStringCreateWithCString(nullptr, path.c_str(), kCFStringEncodingUTF8);
    CFURLRef url = CFURLCreateWithFileSystemPath(nullptr, s, kCFURLPOSIXPathStyle, isDir(path));
    CFRelease(s);
    bundle_ = CFBundleCreate(nullptr, url);
    CFRelease(url);
    if (!bundle_) { error = "Not a bundle: " + path; return false; }
    CFErrorRef err = nullptr;
    if (!CFBundleLoadExecutableAndReturnError(bundle_, &err)) {
      error = "Could not load " + path;
      if (err) CFRelease(err);
      CFRelease(bundle_); bundle_ = nullptr;
      return false;
    }
    return true;
#elif defined(_WIN32)
    h_ = LoadLibraryExW(wide(path).c_str(), nullptr, LOAD_WITH_ALTERED_SEARCH_PATH);
    if (!h_) { error = "Could not load " + path + " (error " + std::to_string(GetLastError()) + ")"; return false; }
    return true;
#else
    h_ = dlopen(path.c_str(), RTLD_NOW | RTLD_LOCAL);
    if (!h_) { const char* e = dlerror(); error = std::string("Could not load ") + path + (e ? std::string(": ") + e : ""); return false; }
    return true;
#endif
  }
  void* symbol(const char* name) const {
#ifdef __APPLE__
    if (!bundle_) return nullptr;
    CFStringRef s = CFStringCreateWithCString(nullptr, name, kCFStringEncodingUTF8);
    void* p = CFBundleGetFunctionPointerForName(bundle_, s);
    CFRelease(s);
    return p;
#elif defined(_WIN32)
    return h_ ? reinterpret_cast<void*>(GetProcAddress(h_, name)) : nullptr;
#else
    return h_ ? dlsym(h_, name) : nullptr;
#endif
  }
  void close() {
#ifdef __APPLE__
    if (bundle_) { CFRelease(bundle_); bundle_ = nullptr; }      // the executable stays loaded, as hosts usually do
#elif defined(_WIN32)
    if (h_) { FreeLibrary(h_); h_ = nullptr; }
#else
    if (h_) { dlclose(h_); h_ = nullptr; }
#endif
  }
#ifdef __APPLE__
  CFBundleRef bundle() const { return bundle_; }
#endif
  void* handle() const {
#ifdef __APPLE__
    return bundle_;
#else
    return (void*)h_;
#endif
  }

 private:
#ifdef __APPLE__
  CFBundleRef bundle_ = nullptr;
#elif defined(_WIN32)
  HMODULE h_ = nullptr;
#else
  void* h_ = nullptr;
#endif
};

}  // namespace mod
