cmake_minimum_required(VERSION 3.24)

project(cerious_exchange LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

include(FetchContent)

FetchContent_Declare(
  httplib
  GIT_REPOSITORY https://github.com/yhirose/cpp-httplib.git
  GIT_TAG        v0.18.3
  GIT_SHALLOW    TRUE
)
FetchContent_MakeAvailable(httplib)

add_library(cerious_exchange_core INTERFACE)
target_include_directories(cerious_exchange_core INTERFACE src)

add_executable(cerious_exchange_sandbox
  src/sandbox.cpp
)
target_link_libraries(cerious_exchange_sandbox PRIVATE cerious_exchange_core)

add_executable(cerious_exchange_server
  src/server.cpp
)
target_link_libraries(cerious_exchange_server PRIVATE
  cerious_exchange_core
  httplib::httplib
)

if(WIN32)
  target_compile_definitions(cerious_exchange_sandbox PRIVATE NOMINMAX WIN32_LEAN_AND_MEAN)
  target_compile_definitions(cerious_exchange_server PRIVATE NOMINMAX WIN32_LEAN_AND_MEAN)
  target_compile_options(cerious_exchange_sandbox PRIVATE /W4 /O2)
  target_compile_options(cerious_exchange_server PRIVATE /W4 /O2)
else()
  target_compile_options(cerious_exchange_sandbox PRIVATE -Wall -Wextra -Wpedantic -O3 -march=native)
  target_compile_options(cerious_exchange_server PRIVATE -Wall -Wextra -Wpedantic -O3 -march=native)
endif()
