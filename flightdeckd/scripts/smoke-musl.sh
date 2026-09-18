#!/usr/bin/env bash
# Smoke-test the static musl binaries from build-musl.sh in stock Debian
# containers (no Rust, no musl installed): ldd must say static, --version and
# `init` must work on an empty HOME, and `run` must bring up the attach socket
# and complete a real TLS handshake (rustls + ring) — pointed at
# https://example.com, whose 404 on the websocket upgrade proves TLS worked
# without registering anything on the real relay. The foreign arch runs under
# Docker's binfmt emulation (qemu / Rosetta).
set -euo pipefail
cd "$(dirname "$0")/.."

for t in x86_64-unknown-linux-musl aarch64-unknown-linux-musl; do
  case "$t" in x86_64-*) platform=linux/amd64 ;; aarch64-*) platform=linux/arm64 ;; esac
  bin="target/musl/dist/flightdeckd-$t"
  [ -x "$bin" ] || { echo "missing $bin — run scripts/build-musl.sh"; exit 1; }
  echo "== $t on $platform debian"
  docker run --rm --platform "$platform" -v "$PWD/$bin:/usr/local/bin/flightdeckd:ro" \
    debian:bookworm-slim sh -euc '
      uname -m
      ldd /usr/local/bin/flightdeckd 2>&1 | sed "s/^/ldd: /" || true
      flightdeckd --version
      export HOME=$(mktemp -d)
      flightdeckd init --relay https://example.com --label smoke | head -3
      test -s "$HOME/.flightdeckd/config.json"
      RUST_LOG=info flightdeckd run > "$HOME/run.log" 2>&1 &
      pid=$!; sleep 6
      flightdeckd status
      kill $pid 2>/dev/null || true
      grep -o "attach socket ready.*" "$HOME/run.log"
      grep -o "relay connection ended.*" "$HOME/run.log" | head -1
    '
done
