cmake_minimum_required(VERSION 3.24)

project(cerious_gateway LANGUAGES CXX)

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

add_executable(cerious_gateway
  src/main.cpp
)

target_link_libraries(cerious_gateway PRIVATE httplib::httplib)

if(WIN32)
  target_compile_definitions(cerious_gateway PRIVATE NOMINMAX WIN32_LEAN_AND_MEAN)
  target_compile_options(cerious_gateway PRIVATE /W4 /O2)
else()
  target_compile_options(cerious_gateway PRIVATE -Wall -Wextra -Wpedantic -O3)
endif()
