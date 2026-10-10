// Windows only: the bridge does not link against node.lib. The Node-API functions it uses are looked up when first
// called, in the program that loaded it (node.exe, electron.exe and the packaged app's exe all export them), so the
// same fllua_bridge.node works in Node (the tests) and in the desktop app. Built with NAPI_EXTERN defined empty, so the
// declarations in node_api.h are plain functions that this file defines.
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>

#include <node_api.h>

namespace {

void* find(const char* name) {
  static const HMODULE mods[] = {GetModuleHandleW(nullptr), GetModuleHandleW(L"node.dll"), GetModuleHandleW(L"libnode.dll")};
  for (HMODULE m : mods)
    if (m)
      if (FARPROC p = GetProcAddress(m, name)) return reinterpret_cast<void*>(p);
  return nullptr;
}

template <typename Fn>
Fn api(const char* name) { return reinterpret_cast<Fn>(find(name)); }

}  // namespace

#define FORWARD(name, params, args)                                \
  napi_status NAPI_CDECL name params {                             \
    static const auto fn = api<decltype(&name)>(#name);            \
    return fn ? fn args : napi_generic_failure;                    \
  }

FORWARD(napi_create_object, (napi_env env, napi_value* result), (env, result))
FORWARD(napi_create_double, (napi_env env, double value, napi_value* result), (env, value, result))
FORWARD(napi_create_string_utf8, (napi_env env, const char* str, size_t length, napi_value* result), (env, str, length, result))
FORWARD(napi_get_boolean, (napi_env env, bool value, napi_value* result), (env, value, result))
FORWARD(napi_set_named_property, (napi_env env, napi_value object, const char* utf8name, napi_value value), (env, object, utf8name, value))
FORWARD(napi_define_properties, (napi_env env, napi_value object, size_t property_count, const napi_property_descriptor* properties),
        (env, object, property_count, properties))
FORWARD(napi_get_cb_info, (napi_env env, napi_callback_info cbinfo, size_t* argc, napi_value* argv, napi_value* this_arg, void** data),
        (env, cbinfo, argc, argv, this_arg, data))
FORWARD(napi_get_value_string_utf8, (napi_env env, napi_value value, char* buf, size_t bufsize, size_t* result), (env, value, buf, bufsize, result))
FORWARD(napi_get_typedarray_info, (napi_env env, napi_value typedarray, napi_typedarray_type* type, size_t* length, void** data,
                                   napi_value* arraybuffer, size_t* byte_offset),
        (env, typedarray, type, length, data, arraybuffer, byte_offset))
FORWARD(napi_create_reference, (napi_env env, napi_value value, uint32_t initial_refcount, napi_ref* result), (env, value, initial_refcount, result))
FORWARD(napi_delete_reference, (node_api_basic_env env, napi_ref ref), (env, ref))
