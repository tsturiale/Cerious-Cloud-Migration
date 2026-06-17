cmake_minimum_required(VERSION 3.24)

project(cerious_price_feed LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

include(FetchContent)

FetchContent_Declare(
  databento
  GIT_REPOSITORY https://github.com/databento/databento-cpp.git
  GIT_TAG main
)

FetchContent_MakeAvailable(databento)

add_executable(cerious_price_feed
  src/main.cpp
)

target_link_libraries(cerious_price_feed PRIVATE databento::databento)

add_executable(cerious_price_history
  src/history.cpp
)

target_link_libraries(cerious_price_history PRIVATE databento::databento)

if(WIN32)
  target_compile_definitions(cerious_price_feed PRIVATE NOMINMAX WIN32_LEAN_AND_MEAN)
  target_compile_definitions(cerious_price_history PRIVATE NOMINMAX WIN32_LEAN_AND_MEAN)
endif()
