#!/usr/bin/env bash
# Bootstrap live-test fixtures (see Dockerfile / docs/B6-FIXTURES.md).
#
#   bootstrap-fixtures/fixture.sh up    <a|b|c|d|all>   build + (re)start
#   bootstrap-fixtures/fixture.sh check <a|b|c|d|all>   scripted auth-mode checks
#   bootstrap-fixtures/fixture.sh down  <a|b|c|d|all>   remove the container(s)
#   bootstrap-fixtures/fixture.sh ssh   <a|b|c|d> [cmd] password ssh as the fixture's user
#
# Fixed ports and credentials (throwaway, local-only, 127.0.0.1):
#   a :2231  deploy / deploy-pw   (sudo, password required)
#   b :2232  root   / root-pw
#   c :2233  josty  / josty-pw    (sudo; flightdeckd system unit pre-installed)
#   d :2234  nosudo / nosudo-pw   (no sudo binary)
#
# Env: BASE (ubuntu:20.04 — the real test server's distro),
#      FLIGHTDECKD_BIN (fixture c: a static linux binary for Docker's arch;
#      default: the flightdeckd/scripts/build-musl.sh output, built if missing).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
BASE="${BASE:-ubuntu:20.04}"

port_of() { case "$1" in a) echo 2231 ;; b) echo 2232 ;; c) echo 2233 ;; d) echo 2234 ;; esac; }
user_of() { case "$1" in a) echo deploy ;; b) echo root ;; c) echo josty ;; d) echo nosudo ;; esac; }
pass_of() { echo "$(user_of "$1")-pw"; }
name_of() { echo "fd-fixture-$1"; }
image_of() { echo "flightdeck-fixture-$1"; }

# Password ssh without sshpass: ssh asks askpass.sh, which prints $FIXTURE_PASSWORD.
pssh() { # <user> <password> <port> <cmd...>
  local user="$1" pw="$2" port="$3"; shift 3
  FIXTURE_PASSWORD="$pw" SSH_ASKPASS="$HERE/askpass.sh" SSH_ASKPASS_REQUIRE=force DISPLAY=:0 \
    ssh -T -p "$port" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR \
      -o PubkeyAuthentication=no -o PreferredAuthentications=password -o NumberOfPasswordPrompts=1 \
      -o ConnectTimeout=10 "$user@127.0.0.1" "$@" </dev/null
}
fx() { pssh "$(user_of "$1")" "$(pass_of "$1")" "$(port_of "$1")" "${@:2}"; }

flightdeckd_bin() {
  if [ -n "${FLIGHTDECKD_BIN:-}" ]; then echo "$FLIGHTDECKD_BIN"; return; fi
  local arch; arch="$(docker info -f '{{.Architecture}}')"
  case "$arch" in arm64) arch=aarch64 ;; amd64) arch=x86_64 ;; esac
  local bin="$HERE/../flightdeckd/target/musl/dist/flightdeckd-$arch-unknown-linux-musl"
  [ -x "$bin" ] || "$HERE/../flightdeckd/scripts/build-musl.sh" >&2
  echo "$bin"
}

up() {
  local f="$1" ctx; ctx="$(mktemp -d)"
  cp "$HERE/Dockerfile" "$HERE/flightdeckd.service" "$ctx/"
  if [ "$f" = c ]; then cp "$(flightdeckd_bin)" "$ctx/flightdeckd"; fi
  echo "· building $(image_of "$f") (BASE=$BASE)"
  docker build -q --build-arg BASE="$BASE" --target "fixture-$f" -t "$(image_of "$f")" "$ctx" >/dev/null
  rm -rf "$ctx"
  docker rm -f "$(name_of "$f")" >/dev/null 2>&1 || true
  # systemd as PID 1: its own cgroup namespace + writable cgroupfs + tmpfs /run.
  docker run -d --name "$(name_of "$f")" --hostname "fixture-$f" \
    --privileged --cgroupns=private --tmpfs /run --tmpfs /run/lock \
    -p "127.0.0.1:$(port_of "$f"):22" "$(image_of "$f")" >/dev/null
  local st=""
  for _ in $(seq 1 60); do
    st="$(docker exec "$(name_of "$f")" systemctl is-system-running 2>/dev/null || true)"
    case "$st" in running|degraded) break ;; esac
    sleep 1
  done
  for _ in $(seq 1 30); do  # sshd reachable through the port mapping
    ssh-keyscan -T 2 -p "$(port_of "$f")" 127.0.0.1 2>/dev/null | grep -q . && break
    sleep 1
  done
  echo "· $(name_of "$f") up on 127.0.0.1:$(port_of "$f") — systemd: $st — login $(user_of "$f") / $(pass_of "$f")"
}

down() { docker rm -f "$(name_of "$1")" >/dev/null 2>&1 && echo "· $(name_of "$1") removed" || true; }

ok()   { echo "   ok   $*"; }
fail() { echo "   FAIL $*"; FAILED=1; }
expect() { # <label> <expected> <actual>
  if [ "$2" = "$3" ]; then ok "$1 = $3"; else fail "$1: expected '$2', got '$3'"; fi
}
refused() { # <label> <user> <password> <port>
  if pssh "$2" "$3" "$4" true 2>/dev/null; then fail "$1 was accepted"; else ok "$1 refused"; fi
}

check() {
  local f="$1" port; port="$(port_of "$f")"
  echo "== fixture $f ($(name_of "$f"), :$port)"
  expect "password login as $(user_of "$f")" "$(user_of "$f")" "$(fx "$f" whoami 2>&1)"
  expect "systemd is PID 1" systemd "$(fx "$f" 'ps -o comm= -p 1' 2>&1)"
  expect "sshd PasswordAuthentication" "passwordauthentication yes" \
    "$(docker exec "$(name_of "$f")" sshd -T 2>/dev/null | grep '^passwordauthentication')"
  case "$f" in
    a)
      expect "sudo with the password" 0 "$(fx a "echo deploy-pw | sudo -S -p '' id -u" 2>&1)"
      if fx a 'sudo -n true' 2>/dev/null; then fail "sudo -n succeeded (should need a password)"; else ok "sudo -n needs a password"; fi
      refused "root login" root root-pw 2231
      ;;
    b)
      expect "uid" 0 "$(fx b 'id -u')"
      expect "can run systemctl" 0 "$(fx b 'systemctl list-units >/dev/null; echo $?')"
      ;;
    c)
      expect "flightdeckd.service" active "$(fx c 'systemctl is-active flightdeckd')"
      expect "unit owner/mode" "root:root 644" "$(fx c 'stat -c "%U:%G %a" /etc/systemd/system/flightdeckd.service')"
      expect "binary owner/mode" "root:root 777" "$(fx c 'stat -c "%U:%G %a" /usr/local/bin/flightdeckd')"
      expect "unit User/Restart" "User=josty Restart=always" \
        "$(fx c 'echo $(systemctl show -p User --value flightdeckd) $(systemctl show -p Restart --value flightdeckd)' | sed 's/^/User=/; s/ / Restart=/')"
      expect "fd_status via the running daemon" fd_status \
        "$(fx c 'flightdeckd status' | sed -n 's/.*"type":"\([a-z_]*\)".*/\1/p')"
      expect "sudo with the password" 0 "$(fx c "echo josty-pw | sudo -S -p '' id -u" 2>&1)"
      refused "root login" root root-pw 2233
      ;;
    d)
      expect "sudo binary" absent "$(fx d 'command -v sudo || echo absent')"
      expect "user systemd manager during the session" running \
        "$(fx d 'systemctl --user is-system-running 2>/dev/null || true')"
      refused "root login" root root-pw 2234
      ;;
  esac
}

cmd="${1:-}"; target="${2:-}"
[ -n "$cmd" ] && [ -n "$target" ] || { sed -n '2,20p' "$0"; exit 2; }
fixtures="$target"; [ "$target" = all ] && fixtures="a b c d"
FAILED=0
case "$cmd" in
  up)    for f in $fixtures; do up "$f"; done ;;
  down)  for f in $fixtures; do down "$f"; done ;;
  check) for f in $fixtures; do check "$f"; done
         [ "$FAILED" = 0 ] && echo "ALL CHECKS PASSED" || { echo "SOME CHECKS FAILED"; exit 1; } ;;
  ssh)   fx "$target" "${@:3}" ;;
  *)     echo "unknown command $cmd"; exit 2 ;;
esac
