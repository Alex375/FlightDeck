#!/usr/bin/env bash
# Build + (re)start the M1 container, inject secrets, print the pairing link.
#
#   m1-daemon/scripts/up.sh            # container flightdeck-m1, ssh on 2224
#
# Secrets injected at runtime (never baked into the image):
#   - the M0 SSH public key -> agent's authorized_keys (the Mac's attach path)
#   - the Mac's Claude OAuth credentials -> ~agent/.claude/.credentials.json
#     (stand-in for a real server's own `claude` login; rerun this script when
#     the token rotates)
#
# The image carries flightdeckd's STATIC musl binary for Docker's arch, built
# here from the current source by the crate's scripts/build-musl.sh
# (incremental); FLIGHTDECKD_BIN=<path> uses a given binary instead.
set -euo pipefail
BENCH="$(cd "$(dirname "$0")/.." && pwd)" # m1-daemon/ today, flightdeckd/live/m1/ once moved

NAME="${NAME:-flightdeck-m1}"
PORT="${PORT:-2224}"
KEY="${KEY:-$HOME/.ssh/flightdeck_m0_ed25519}"

# The flightdeckd crate: a sibling of this bench today, its grandparent once
# the bench lives under it.
crate=""
for c in "$BENCH/../flightdeckd" "$BENCH/../.."; do
  if grep -qs '^name = "flightdeckd"' "$c/Cargo.toml"; then crate="$(cd "$c" && pwd)"; break; fi
done
if [ -n "${FLIGHTDECKD_BIN:-}" ]; then
  bin="$FLIGHTDECKD_BIN"
else
  [ -n "$crate" ] || { echo "cannot find the flightdeckd crate from $BENCH — set FLIGHTDECKD_BIN" >&2; exit 1; }
  arch="$(docker info -f '{{.Architecture}}')"
  case "$arch" in arm64) arch=aarch64 ;; amd64) arch=x86_64 ;; esac
  echo "· building flightdeckd ($arch-unknown-linux-musl, static) from $crate"
  TARGETS="$arch-unknown-linux-musl" "$crate/scripts/build-musl.sh" >/dev/null
  bin="$("$crate/scripts/build-musl.sh" --print-dist-dir)/flightdeckd-$arch-unknown-linux-musl"
fi

echo "· building image flightdeck-m1 around $bin"
ctx="$(mktemp -d)"
trap 'rm -rf "$ctx"' EXIT
cp "$BENCH/Dockerfile" "$BENCH/entrypoint.sh" "$ctx/"
cp "$bin" "$ctx/flightdeckd"
docker build -q -t flightdeck-m1 "$ctx" >/dev/null

# The image generates SSH host keys when it is built: carry the previous
# container's keys over, so a rebuild never changes the box's identity
# (known_hosts on the Mac, the app's paired server, StrictHostKeyChecking).
# The old container holds the ONLY copy: if they cannot be saved, stop before
# removing it (FORCE=1 accepts a new identity instead).
hostkeys="$ctx/hostkeys"
if docker ps -a --format '{{.Names}}' | grep -qx "$NAME"; then
  if docker cp "$NAME:/etc/ssh" "$hostkeys" && ls "$hostkeys"/ssh_host_*_key >/dev/null 2>&1; then
    echo "· saved $NAME's SSH host keys"
  elif [ "${FORCE:-0}" = 1 ]; then
    echo "!! could not save $NAME's SSH host keys — FORCE=1: replacing it anyway, its SSH identity WILL change" >&2
    rm -rf "$hostkeys"
  else
    echo "!! could not save $NAME's SSH host keys — NOT replacing it: its SSH identity would change" >&2
    echo "   (known_hosts and the app's pairing would reject the new box). Fix the cause, or rerun" >&2
    echo "   with FORCE=1 to accept a new identity." >&2
    exit 1
  fi
  echo "· removing previous container $NAME"
  docker rm -f "$NAME" >/dev/null
fi

echo "· starting $NAME (ssh on 127.0.0.1:$PORT)"
docker run -d --name "$NAME" --hostname "$NAME" -p "127.0.0.1:$PORT:22" flightdeck-m1 >/dev/null
if ls "$hostkeys"/ssh_host_*_key >/dev/null 2>&1; then
  for f in "$hostkeys"/ssh_host_*; do docker cp "$f" "$NAME:/etc/ssh/"; done
  docker exec "$NAME" sh -c 'chown root:root /etc/ssh/ssh_host_* && chmod 600 /etc/ssh/ssh_host_*_key \
    && chmod 644 /etc/ssh/ssh_host_*.pub && pkill -HUP -x sshd'
  # sshd refuses private host keys readable by others: check before trusting it.
  bad="$(docker exec "$NAME" sh -c 'for k in /etc/ssh/ssh_host_*_key; do
    [ "$(stat -c %U:%a "$k")" = root:600 ] || echo "$k ($(stat -c %U:%a "$k"))"; done')"
  if [ -n "$bad" ]; then
    echo "!! restored host keys with the wrong owner/mode: $bad" >&2
    exit 1
  fi
  sleep 1
  docker exec "$NAME" pgrep -x sshd >/dev/null || { echo "!! sshd is not running after reloading the host keys" >&2; exit 1; }
  echo "· kept the previous container's SSH host keys (root:600)"
else
  echo "· no previous SSH host keys to carry over (first run, or FORCE=1) — this box has a NEW SSH identity"
fi

echo "· injecting SSH public key"
if [ ! -f "$KEY.pub" ]; then
  echo "  (no key at $KEY.pub — generating)"
  ssh-keygen -t ed25519 -N "" -q -f "$KEY"
fi
docker exec -i -u agent "$NAME" bash -c 'mkdir -p ~/.ssh && cat > ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys' < "$KEY.pub"

echo "· injecting Claude credentials from the macOS Keychain"
security find-generic-password -s "Claude Code-credentials" -w \
  | docker exec -i -u agent "$NAME" bash -c 'mkdir -p ~/.claude && cat > ~/.claude/.credentials.json && chmod 600 ~/.claude/.credentials.json'

echo "· seeding /work/demo (a repo to open conversations in)"
docker exec -u agent "$NAME" bash -c 'mkdir -p /work/demo && cd /work/demo \
  && { [ -d .git ] || { git init -q && git config user.email agent@flightdeck \
       && git config user.name agent && echo "# demo" > README.md \
       && git add -A && git commit -qm init; }; }'

sleep 1
echo
echo "· daemon says:"
docker logs "$NAME" 2>&1 | grep -E 'pairing link|relay connected|attach socket' | tail -3
echo
echo "· phone pairing link:"
docker exec -u agent "$NAME" flightdeckd pairing
echo
echo "Mac attach path: ssh -p $PORT -i $KEY agent@127.0.0.1 flightdeckd attach --cwd /work/demo"
