#!/usr/bin/env bash
# Cross-compile static flightdeckd binaries for Linux (musl):
#   target/musl/dist/flightdeckd-x86_64-unknown-linux-musl
#   target/musl/dist/flightdeckd-aarch64-unknown-linux-musl
#
#   scripts/build-musl.sh              # from the crate root or anywhere
#
# Needs only Docker (any host arch). Cargo's registry + zig's cache live under
# target/musl/, so reruns are incremental and nothing is written as root.
set -euo pipefail
cd "$(dirname "$0")/.."

IMAGE="${IMAGE:-flightdeckd-musl-builder}"
TARGETS=(x86_64-unknown-linux-musl aarch64-unknown-linux-musl)

echo "· builder image $IMAGE"
docker build -q -t "$IMAGE" -f scripts/musl-builder.Dockerfile scripts >/dev/null

mkdir -p target/musl/dist target/musl/home
echo "· cargo zigbuild --release ${TARGETS[*]}"
docker run --rm \
  -u "$(id -u):$(id -g)" \
  -v "$PWD:/src" \
  -e HOME=/src/target/musl/home \
  -e CARGO_HOME=/src/target/musl/cargo-home \
  -e CARGO_TARGET_DIR=/src/target/musl \
  "$IMAGE" \
  sh -c 'cargo zigbuild --release --locked $(printf -- "--target %s " "$@")' _ "${TARGETS[@]}"

for t in "${TARGETS[@]}"; do
  cp "target/musl/$t/release/flightdeckd" "target/musl/dist/flightdeckd-$t"
done
ls -l target/musl/dist/
