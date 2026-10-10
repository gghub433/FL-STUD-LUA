{
  "targets": [{
    "target_name": "fllua_bridge",
    "sources": ["bridge.cc"],
    "include_dirs": [".."],
    "cflags_cc": ["-std=c++17", "-fexceptions"],
    "xcode_settings": { "CLANG_CXX_LANGUAGE_STANDARD": "c++17", "GCC_ENABLE_CPP_EXCEPTIONS": "YES", "MACOSX_DEPLOYMENT_TARGET": "12.0" },
    "msvs_settings": { "VCCLCompilerTool": { "AdditionalOptions": ["/std:c++17", "/EHsc"] } },
    "conditions": [["OS=='linux'", { "libraries": ["-lrt", "-lpthread"] }]]
  }]
}
