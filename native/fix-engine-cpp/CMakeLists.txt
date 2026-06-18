cmake_minimum_required(VERSION 3.24)

project(cerious_fix_engine LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

# ── Options ──────────────────────────────────────────────────────────
option(CERIOUS_FIX_ENABLE_AERON  "Build with Aeron IPC transport"  ON)
option(CERIOUS_FIX_ENABLE_TLS    "Build with OpenSSL TLS support"  ON)

# ── Dependencies via FetchContent ────────────────────────────────────
include(FetchContent)

# cpp-httplib — header-only embedded HTTP server for local status/command API.
# The FIX engine runs as a standalone daemon and exposes its own REST endpoints.
# Python gateway proxies UI traffic here. No subprocess bridge.
FetchContent_Declare(
  httplib
  GIT_REPOSITORY https://github.com/yhirose/cpp-httplib.git
  GIT_TAG        v0.18.3
  GIT_SHALLOW    TRUE
)
FetchContent_MakeAvailable(httplib)

if(CERIOUS_FIX_ENABLE_AERON)
  FetchContent_Declare(
    aeron
    GIT_REPOSITORY https://github.com/real-logic/aeron.git
    GIT_TAG        1.46.2
    GIT_SHALLOW    TRUE
  )
  set(AERON_BUILD_SAMPLES OFF CACHE BOOL "" FORCE)
  set(AERON_BUILD_TOOLS   OFF CACHE BOOL "" FORCE)
  set(BUILD_AERON_DRIVER  OFF CACHE BOOL "" FORCE)
  FetchContent_MakeAvailable(aeron)
endif()

# ── Find system packages ────────────────────────────────────────────
find_package(Threads REQUIRED)

if(CERIOUS_FIX_ENABLE_TLS)
  find_package(OpenSSL REQUIRED)
endif()

# ── FIX Engine executable ───────────────────────────────────────────
add_executable(cerious_fix_engine
  src/main.cpp
)

target_include_directories(cerious_fix_engine PRIVATE src)

target_link_libraries(cerious_fix_engine PRIVATE
  Threads::Threads
  httplib::httplib
)

if(CERIOUS_FIX_ENABLE_AERON)
  target_link_libraries(cerious_fix_engine PRIVATE aeron_client)
  target_compile_definitions(cerious_fix_engine PRIVATE CERIOUS_AERON_ENABLED=1)
endif()

if(CERIOUS_FIX_ENABLE_TLS)
  target_link_libraries(cerious_fix_engine PRIVATE OpenSSL::SSL OpenSSL::Crypto)
  target_compile_definitions(cerious_fix_engine PRIVATE CERIOUS_TLS_ENABLED=1)
endif()

if(WIN32)
  target_compile_definitions(cerious_fix_engine PRIVATE NOMINMAX WIN32_LEAN_AND_MEAN)
  target_link_libraries(cerious_fix_engine PRIVATE ws2_32)
endif()

if(UNIX AND NOT APPLE)
  target_compile_options(cerious_fix_engine PRIVATE -O3 -march=native -flto)
  target_link_options(cerious_fix_engine PRIVATE -flto)
endif()
