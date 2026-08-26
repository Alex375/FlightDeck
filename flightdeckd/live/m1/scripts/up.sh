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
set -euo pipefail
cd "$(dirname "$0")/../.."

NAME="${NAME:-flightdeck-m1}"
PORT="${PORT:-2224}"
KEY="${KEY:-$HOME/.ssh/flightdeck_m0_ed25519}"

echo "· building image flightdeck-m1 (builder stage caches cargo)"
docker build -q -f m1-daemon/Dockerfile -t flightdeck-m1 . >/dev/null

if docker ps -a --format '{{.Names}}' | grep -qx "$NAME"; then
  echo "· removing previous container $NAME"
  docker rm -f "$NAME" >/dev/null
fi

echo "· starting $NAME (ssh on 127.0.0.1:$PORT)"
docker run -d --name "$NAME" --hostname "$NAME" -p "127.0.0.1:$PORT:22" flightdeck-m1 >/dev/null

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
