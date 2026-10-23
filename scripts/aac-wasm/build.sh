#!/usr/bin/env bash
# Rebuilds src/video-editor/engine/aac-encoder.wasm: FFmpeg's native AAC-LC encoder (LGPL-2.1-or-later,
# built without --enable-gpl and without any external library) and scripts/aac-wasm/aac_wrapper.c,
# compiled with clang for wasm32-wasi against wasi-libc. No Emscripten, no JavaScript glue.
#
# Needs: clang/lld 18 with the wasm32 target, wasi-libc and the wasm32 compiler runtime
# (Ubuntu 24.04: apt-get install clang lld wasi-libc libclang-rt-18-dev-wasm32), curl, make.
# Usage: scripts/aac-wasm/build.sh [work-dir]   (the FFmpeg source is downloaded and checked there)
#
# This also documents, for the LGPL, how the shipped binary is made from its sources: FFmpeg 8.1.3
# as released (sha256 below, unmodified) plus aac_wrapper.c from this directory.
set -euo pipefail

FFMPEG_VERSION=8.1.3
FFMPEG_SHA256=7138d28c96d9d3e3af4ee3d8cad72741f8ffb40da90c1112235dea3ecd3178a3
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
work="${1:-${TMPDIR:-/tmp}/aac-wasm-build}"
out="$repo/src/video-editor/engine/aac-encoder.wasm"
mkdir -p "$work"

tarball="$work/ffmpeg-$FFMPEG_VERSION.tar.xz"
[ -f "$tarball" ] || curl -sSfL -o "$tarball" "https://ffmpeg.org/releases/ffmpeg-$FFMPEG_VERSION.tar.xz"
echo "$FFMPEG_SHA256  $tarball" | sha256sum -c -
src="$work/ffmpeg-$FFMPEG_VERSION"
[ -d "$src" ] || tar -xf "$tarball" -C "$work"

build="$work/build-$FFMPEG_VERSION"
mkdir -p "$build"
cd "$build"
if [ ! -f ffbuild/config.mak ]; then
  "$src/configure" \
    --target-os=none --arch=wasm32 --enable-cross-compile \
    --cc=clang --ar=llvm-ar --ranlib=llvm-ranlib --nm=llvm-nm --strip=llvm-strip \
    --extra-cflags="--target=wasm32-wasi -O2 -fno-stack-protector" \
    --extra-ldflags="--target=wasm32-wasi" \
    --disable-everything --enable-encoder=aac \
    --disable-programs --disable-doc --disable-network --disable-autodetect \
    --disable-avdevice --disable-avformat --disable-avfilter --disable-swscale --disable-swresample \
    --disable-pthreads --disable-w32threads --disable-os2threads \
    --disable-asm --disable-inline-asm --disable-runtime-cpudetect --disable-debug
fi
grep -q '^#define CONFIG_GPL 0' config.h || { echo "refusing: this FFmpeg build is not LGPL" >&2; exit 1; }
make -j"$(nproc)" libavcodec/libavcodec.a libavutil/libavutil.a >/dev/null

clang --target=wasm32-wasi -O2 -mexec-model=reactor \
  -I"$src" -I"$build" \
  -Wl,--no-entry -Wl,--gc-sections -Wl,--strip-all \
  -Wl,-z,stack-size=1048576 -Wl,--initial-memory=16777216 -Wl,--max-memory=268435456 \
  "$here/aac_wrapper.c" libavcodec/libavcodec.a libavutil/libavutil.a -lm \
  -o "$out"
echo "wrote $out ($(stat -c %s "$out") bytes)"
