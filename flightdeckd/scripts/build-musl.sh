#!/usr/bin/env bash
# Cross-compile static flightdeckd binaries for Linux (musl) into
#   <root>/target/musl/dist/flightdeckd-x86_64-unknown-linux-musl
#   <root>/target/musl/dist/flightdeckd-aarch64-unknown-linux-musl
# where <root> is the crate itself (standalone) or its Cargo workspace root
# (workspace member) — detected, see lib-layout.sh.
#
#   scripts/build-musl.sh                     # both targets, from anywhere
#   TARGETS=aarch64-unknown-linux-musl scripts/build-musl.sh
#   scripts/build-musl.sh --print-dist-dir    # where the binaries land
#
# Needs only Docker (any host arch). <root> is bind-mounted (the workspace's
# Cargo.lock is the one used, --locked); cargo's registry + zig's cache live
# under <root>/target/musl/, so reruns are incremental and nothing is written
# as root.
#
# RUST_IMAGE / CARGO_ZIGBUILD_VERSION / ZIG_VERSION, when set, pin the builder image
# (by digest, e.g. "rust:1-alpine@sha256:...") and the exact cargo-zigbuild/zig apk
# package versions — see musl-builder.Dockerfile's own doc. Unset (the default): the
# Dockerfile's own floating defaults, fine for local/dev iteration.
set -euo pipefail
. "$(dirname "$0")/lib-layout.sh"
fd_layout
if [ "${1:-}" = "--print-dist-dir" ]; then
  echo "$FD_DIST_DIR"
  exit 0
fi

IMAGE="${IMAGE:-flightdeckd-musl-builder}"
echo "· $(fd_describe)"
echo "· builder image $IMAGE"
# shellcheck disable=SC2086  # deliberately unquoted: 0 or 2 words each, ":+"-guarded
docker build -q -t "$IMAGE" \
  ${RUST_IMAGE:+--build-arg "RUST_IMAGE=$RUST_IMAGE"} \
  ${CARGO_ZIGBUILD_VERSION:+--build-arg "CARGO_ZIGBUILD_VERSION=$CARGO_ZIGBUILD_VERSION"} \
  ${ZIG_VERSION:+--build-arg "ZIG_VERSION=$ZIG_VERSION"} \
  -f "$FD_CRATE_DIR/scripts/musl-builder.Dockerfile" "$FD_CRATE_DIR/scripts" >/dev/null

mkdir -p "$FD_DIST_DIR" "$FD_TARGET_DIR/home"
echo "· cargo zigbuild -p flightdeckd --profile $FD_PROFILE $FD_TARGETS"
# shellcheck disable=SC2086  # FD_TARGETS is a word list
docker run --rm \
  -u "$(id -u):$(id -g)" \
  -v "$FD_ROOT:/src" \
  -w /src \
  -e HOME=/src/target/musl/home \
  -e CARGO_HOME=/src/target/musl/cargo-home \
  -e CARGO_TARGET_DIR=/src/target/musl \
  "$IMAGE" \
  sh -c 'profile="$1"; shift; cargo zigbuild --locked -p flightdeckd --profile "$profile" $(printf -- "--target %s " "$@")' \
  _ "$FD_PROFILE" $FD_TARGETS

for t in $FD_TARGETS; do
  cp "$FD_TARGET_DIR/$t/$FD_PROFILE_DIR/flightdeckd" "$FD_DIST_DIR/flightdeckd-$t"
done
ls -l "$FD_DIST_DIR"
