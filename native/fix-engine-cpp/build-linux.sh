#!/usr/bin/env bash
# Cerious FIX Engine — Linux build script.
# Produces: native/fix-engine-cpp/build/cerious_fix_engine
#
# Prerequisites:
#   sudo apt-get install -y build-essential cmake ninja-build git pkg-config \
#                            curl zip unzip tar libssl-dev

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
PROJECT="$ROOT/native/fix-engine-cpp"
BUILD="$PROJECT/build"
VCPKG="$ROOT/.tools/vcpkg"
TOOLCHAIN="$VCPKG/scripts/buildsystems/vcpkg.cmake"
CONFIG="${1:-RelWithDebInfo}"

echo "=== cerious_fix_engine build ==="
echo "  root:    $ROOT"
echo "  config:  $CONFIG"

# ── vcpkg ──────────────────────────────────────────────────────────
if [ ! -d "$VCPKG" ]; then
  echo "  cloning vcpkg..."
  git clone https://github.com/microsoft/vcpkg.git "$VCPKG"
fi
if [ ! -f "$VCPKG/vcpkg" ]; then
  echo "  bootstrapping vcpkg..."
  "$VCPKG/bootstrap-vcpkg.sh" -disableMetrics
fi
echo "  installing vcpkg packages..."
"$VCPKG/vcpkg" install openssl:x64-linux zstd:x64-linux

# ── cmake configure + build ────────────────────────────────────────
mkdir -p "$BUILD"

cmake -S "$PROJECT" -B "$BUILD" -G Ninja \
  -DCMAKE_BUILD_TYPE="$CONFIG" \
  -DCMAKE_TOOLCHAIN_FILE="$TOOLCHAIN" \
  -DVCPKG_TARGET_TRIPLET=x64-linux

cmake --build "$BUILD" --config "$CONFIG"

echo "=== build complete ==="
echo "  binary: $BUILD/cerious_fix_engine"
echo ""
echo "Run:"
echo "  $BUILD/cerious_fix_engine --mode sim --http-port 8010"
