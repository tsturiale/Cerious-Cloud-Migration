#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
cmake -S . -B build -DCMAKE_BUILD_TYPE="${1:-RelWithDebInfo}"
cmake --build build --parallel
