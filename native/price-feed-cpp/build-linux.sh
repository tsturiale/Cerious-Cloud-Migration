#!/usr/bin/env bash
set -euo pipefail

CONFIGURATION="${1:-RelWithDebInfo}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
PROJECT="$ROOT/native/price-feed-cpp"
BUILD="$PROJECT/build"
VCPKG="$ROOT/.tools/vcpkg"
TOOLCHAIN="$VCPKG/scripts/buildsystems/vcpkg.cmake"

if [ ! -d "$VCPKG" ]; then
  git clone https://github.com/microsoft/vcpkg.git "$VCPKG"
fi
if [ ! -x "$VCPKG/vcpkg" ]; then
  "$VCPKG/bootstrap-vcpkg.sh" -disableMetrics
fi

"$VCPKG/vcpkg" install openssl:x64-linux zstd:x64-linux

cmake -S "$PROJECT" -B "$BUILD" -G Ninja \
  -DCMAKE_BUILD_TYPE="$CONFIGURATION" \
  -DCMAKE_TOOLCHAIN_FILE="$TOOLCHAIN" \
  -DVCPKG_TARGET_TRIPLET=x64-linux
cmake --build "$BUILD" --config "$CONFIGURATION"
