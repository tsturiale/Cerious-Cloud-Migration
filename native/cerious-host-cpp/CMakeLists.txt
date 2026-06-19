cmake_minimum_required(VERSION 3.24)

project(cerious_host LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

add_executable(cerious_host_service
  src/host_service.cpp
)

add_executable(cerious_tray WIN32
  src/tray.cpp
)

if(WIN32)
  target_compile_definitions(cerious_host_service PRIVATE NOMINMAX WIN32_LEAN_AND_MEAN)
  target_compile_definitions(cerious_tray PRIVATE NOMINMAX WIN32_LEAN_AND_MEAN)
  target_compile_options(cerious_host_service PRIVATE /W4 /O2)
  target_compile_options(cerious_tray PRIVATE /W4 /O2)
  target_link_libraries(cerious_host_service PRIVATE advapi32 winhttp)
  target_link_libraries(cerious_tray PRIVATE advapi32 shell32 user32 gdi32 winhttp)
else()
  target_compile_options(cerious_host_service PRIVATE -Wall -Wextra -Wpedantic -O3)
  target_compile_options(cerious_tray PRIVATE -Wall -Wextra -Wpedantic -O3)
endif()
