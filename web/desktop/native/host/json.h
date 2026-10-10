// A small JSON value with a parser and a writer: enough for the command lines between FL LUA and the host and for
// the moduleinfo.json files inside VST3 bundles (comments and trailing commas are tolerated).
#pragma once
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <map>
#include <memory>
#include <string>
#include <vector>

namespace json {

struct Value {
  enum Type { Null, Bool, Number, String, Array, Object } type = Null;
  bool b = false;
  double n = 0;
  std::string s;
  std::vector<Value> a;
  std::map<std::string, Value> o;

  Value() {}
  Value(bool v) : type(Bool), b(v) {}
  Value(int v) : type(Number), n(v) {}
  Value(unsigned v) : type(Number), n(v) {}
  Value(int64_t v) : type(Number), n((double)v) {}
  Value(uint64_t v) : type(Number), n((double)v) {}
  Value(double v) : type(Number), n(v) {}
  Value(const char* v) : type(String), s(v) {}
  Value(const std::string& v) : type(String), s(v) {}
  static Value array() { Value v; v.type = Array; return v; }
  static Value object() { Value v; v.type = Object; return v; }

  const Value& operator[](const std::string& k) const {
    static const Value none;
    if (type != Object) return none;
    auto it = o.find(k);
    return it == o.end() ? none : it->second;
  }
  Value& set(const std::string& k, Value v) { type = Object; o[k] = std::move(v); return *this; }
  Value& push(Value v) { type = Array; a.push_back(std::move(v)); return *this; }
  bool has(const std::string& k) const { return type == Object && o.count(k); }
  std::string str(const std::string& def = "") const { return type == String ? s : def; }
  double num(double def = 0) const { return type == Number ? n : (type == Bool ? (b ? 1 : 0) : def); }
  int64_t i64(int64_t def = 0) const { return type == Number ? (int64_t)n : def; }
  bool truthy() const { return type == Bool ? b : type == Number ? n != 0 : type == String ? !s.empty() : type != Null; }
};

class Parser {
 public:
  explicit Parser(const std::string& t) : t_(t) {}
  bool parse(Value& out) {
    ws();
    if (!value(out)) return false;
    ws();
    return i_ == t_.size();
  }

 private:
  const std::string& t_;
  size_t i_ = 0;
  void ws() {
    for (;;) {
      while (i_ < t_.size() && (t_[i_] == ' ' || t_[i_] == '\t' || t_[i_] == '\n' || t_[i_] == '\r')) i_++;
      if (i_ + 1 < t_.size() && t_[i_] == '/' && t_[i_ + 1] == '/') { while (i_ < t_.size() && t_[i_] != '\n') i_++; continue; }
      if (i_ + 1 < t_.size() && t_[i_] == '/' && t_[i_ + 1] == '*') { i_ += 2; while (i_ + 1 < t_.size() && !(t_[i_] == '*' && t_[i_ + 1] == '/')) i_++; i_ += 2; continue; }
      break;
    }
  }
  bool lit(const char* w) { size_t n = std::char_traits<char>::length(w); if (t_.compare(i_, n, w) == 0) { i_ += n; return true; } return false; }
  bool value(Value& v) {
    if (i_ >= t_.size()) return false;
    char c = t_[i_];
    if (c == '{') return object(v);
    if (c == '[') return array(v);
    if (c == '"') { v.type = Value::String; return string(v.s); }
    if (lit("true")) { v = Value(true); return true; }
    if (lit("false")) { v = Value(false); return true; }
    if (lit("null")) { v = Value(); return true; }
    const char* b = t_.c_str() + i_;
    char* e = nullptr;
    double d = std::strtod(b, &e);
    if (e == b) return false;
    i_ += (size_t)(e - b);
    v = Value(d);
    return true;
  }
  static void utf8(std::string& o, uint32_t cp) {
    if (cp < 0x80) o += (char)cp;
    else if (cp < 0x800) { o += (char)(0xC0 | (cp >> 6)); o += (char)(0x80 | (cp & 0x3F)); }
    else if (cp < 0x10000) { o += (char)(0xE0 | (cp >> 12)); o += (char)(0x80 | ((cp >> 6) & 0x3F)); o += (char)(0x80 | (cp & 0x3F)); }
    else { o += (char)(0xF0 | (cp >> 18)); o += (char)(0x80 | ((cp >> 12) & 0x3F)); o += (char)(0x80 | ((cp >> 6) & 0x3F)); o += (char)(0x80 | (cp & 0x3F)); }
  }
  bool hex4(uint32_t& cp) {
    if (i_ + 4 > t_.size()) return false;
    cp = (uint32_t)std::strtoul(t_.substr(i_, 4).c_str(), nullptr, 16);
    i_ += 4;
    return true;
  }
  bool string(std::string& o) {
    i_++;
    while (i_ < t_.size()) {
      char c = t_[i_++];
      if (c == '"') return true;
      if (c != '\\') { o += c; continue; }
      if (i_ >= t_.size()) return false;
      char e = t_[i_++];
      switch (e) {
        case 'n': o += '\n'; break; case 't': o += '\t'; break; case 'r': o += '\r'; break;
        case 'b': o += '\b'; break; case 'f': o += '\f'; break;
        case 'u': {
          uint32_t cp;
          if (!hex4(cp)) return false;
          if (cp >= 0xD800 && cp < 0xDC00 && i_ + 6 <= t_.size() && t_[i_] == '\\' && t_[i_ + 1] == 'u') {
            i_ += 2; uint32_t lo; if (!hex4(lo)) return false;
            cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00);
          }
          utf8(o, cp);
          break;
        }
        default: o += e;
      }
    }
    return false;
  }
  bool array(Value& v) {
    v = Value::array(); i_++; ws();
    if (i_ < t_.size() && t_[i_] == ']') { i_++; return true; }
    for (;;) {
      Value x; ws();
      if (i_ < t_.size() && t_[i_] == ']') { i_++; return true; }      // trailing comma
      if (!value(x)) return false;
      v.a.push_back(std::move(x)); ws();
      if (i_ < t_.size() && t_[i_] == ',') { i_++; continue; }
      if (i_ < t_.size() && t_[i_] == ']') { i_++; return true; }
      return false;
    }
  }
  bool object(Value& v) {
    v = Value::object(); i_++; ws();
    if (i_ < t_.size() && t_[i_] == '}') { i_++; return true; }
    for (;;) {
      ws();
      if (i_ < t_.size() && t_[i_] == '}') { i_++; return true; }      // trailing comma
      std::string k;
      if (i_ >= t_.size() || t_[i_] != '"' || !string(k)) return false;
      ws();
      if (i_ >= t_.size() || t_[i_] != ':') return false;
      i_++; ws();
      Value x;
      if (!value(x)) return false;
      v.o[k] = std::move(x); ws();
      if (i_ < t_.size() && t_[i_] == ',') { i_++; continue; }
      if (i_ < t_.size() && t_[i_] == '}') { i_++; return true; }
      return false;
    }
  }
};

inline bool parse(const std::string& text, Value& out) { return Parser(text).parse(out); }

inline void writeString(std::string& o, const std::string& s) {
  o += '"';
  for (unsigned char c : s) {
    switch (c) {
      case '"': o += "\\\""; break; case '\\': o += "\\\\"; break;
      case '\n': o += "\\n"; break; case '\r': o += "\\r"; break; case '\t': o += "\\t"; break;
      default:
        if (c < 0x20) { char b[8]; std::snprintf(b, sizeof b, "\\u%04x", c); o += b; }
        else o += (char)c;
    }
  }
  o += '"';
}

inline void write(std::string& o, const Value& v) {
  switch (v.type) {
    case Value::Null: o += "null"; break;
    case Value::Bool: o += v.b ? "true" : "false"; break;
    case Value::Number: {
      char b[40];
      if (v.n == (double)(int64_t)v.n && v.n > -9e15 && v.n < 9e15) std::snprintf(b, sizeof b, "%lld", (long long)v.n);
      else std::snprintf(b, sizeof b, "%.17g", v.n);
      o += b; break;
    }
    case Value::String: writeString(o, v.s); break;
    case Value::Array: {
      o += '[';
      for (size_t i = 0; i < v.a.size(); i++) { if (i) o += ','; write(o, v.a[i]); }
      o += ']'; break;
    }
    case Value::Object: {
      o += '{';
      bool first = true;
      for (auto& kv : v.o) { if (!first) o += ','; first = false; writeString(o, kv.first); o += ':'; write(o, kv.second); }
      o += '}'; break;
    }
  }
}

inline std::string stringify(const Value& v) { std::string o; write(o, v); return o; }

// base64 for plugin state
inline std::string base64(const std::string& in) {
  static const char* t = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  std::string o;
  o.reserve((in.size() + 2) / 3 * 4);
  size_t i = 0;
  for (; i + 2 < in.size(); i += 3) {
    uint32_t n = ((uint8_t)in[i] << 16) | ((uint8_t)in[i + 1] << 8) | (uint8_t)in[i + 2];
    o += t[n >> 18]; o += t[(n >> 12) & 63]; o += t[(n >> 6) & 63]; o += t[n & 63];
  }
  if (i + 1 == in.size()) { uint32_t n = (uint8_t)in[i] << 16; o += t[n >> 18]; o += t[(n >> 12) & 63]; o += "=="; }
  else if (i + 2 == in.size()) { uint32_t n = ((uint8_t)in[i] << 16) | ((uint8_t)in[i + 1] << 8); o += t[n >> 18]; o += t[(n >> 12) & 63]; o += t[(n >> 6) & 63]; o += '='; }
  return o;
}

inline std::string unbase64(const std::string& in) {
  auto val = [](char c) -> int {
    if (c >= 'A' && c <= 'Z') return c - 'A';
    if (c >= 'a' && c <= 'z') return c - 'a' + 26;
    if (c >= '0' && c <= '9') return c - '0' + 52;
    if (c == '+' || c == '-') return 62;
    if (c == '/' || c == '_') return 63;
    return -1;
  };
  std::string o;
  uint32_t acc = 0; int bits = 0;
  for (char c : in) {
    int v = val(c);
    if (v < 0) continue;
    acc = (acc << 6) | (uint32_t)v; bits += 6;
    if (bits >= 8) { bits -= 8; o += (char)((acc >> bits) & 0xFF); }
  }
  return o;
}

}  // namespace json
