#!/usr/bin/env bash
# Tests for lib-layout.sh's workspace detection, on throwaway directory trees
# (run by `cargo test` through tests/scripts_layout.rs).
set -euo pipefail
LIB="$(cd "$(dirname "$0")" && pwd)/lib-layout.sh"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
FAILED=0

# A fake flightdeckd crate at $1 (with the real lib-layout.sh in its scripts/).
crate() {
  mkdir -p "$1/scripts"
  printf '[package]\nname = "flightdeckd"\nversion = "0.0.0"\n' > "$1/Cargo.toml"
  cp "$LIB" "$1/scripts/lib-layout.sh"
}
# "<workspace 0|1>|<root>|<crate rel>|<profile>" as the build scripts see it.
layout() {
  (unset WORKSPACE_ROOT PROFILE; [ -n "${2:-}" ] && export WORKSPACE_ROOT="$2"
   . "$1/scripts/lib-layout.sh"; fd_layout; echo "$FD_WORKSPACE|$FD_ROOT|$FD_CRATE_REL|$FD_PROFILE") 2>/dev/null
}
expect() { # <name> <expected> <actual>
  if [ "$2" = "$3" ]; then echo "ok   $1"; else echo "FAIL $1: expected '$2', got '$3'"; FAILED=1; fi
}
real() { (cd "$1" && pwd); }

# 1. standalone crate inside a repository, no workspace anywhere
crate "$T/1/repo/flightdeckd"; mkdir "$T/1/repo/.git"
expect "standalone in a repo" "0|$(real "$T/1/repo/flightdeckd")|.|release" "$(layout "$T/1/repo/flightdeckd")"

# 2. member of the repo-root workspace, with a daemon profile
crate "$T/2/repo/flightdeckd"; mkdir "$T/2/repo/.git"
printf '[workspace]\nmembers = ["src-tauri", "flightdeckd"]\nresolver = "2"\n\n[profile.daemon]\ninherits = "release"\n' > "$T/2/repo/Cargo.toml"
expect "member at the repo root" "1|$(real "$T/2/repo")|flightdeckd|daemon" "$(layout "$T/2/repo/flightdeckd")"

# 3. member through a glob, multi-line array, no daemon profile
crate "$T/3/repo/crates/flightdeckd"; mkdir "$T/3/repo/.git"
printf '[workspace]\nresolver = "2"\nmembers = [\n    "apps/*",\n    "crates/*",\n]\n' > "$T/3/repo/Cargo.toml"
expect "glob member, multi-line" "1|$(real "$T/3/repo")|crates/flightdeckd|release" "$(layout "$T/3/repo/crates/flightdeckd")"

# 4. a foreign workspace ABOVE the repository boundary is never looked at
crate "$T/4/outer/repo/flightdeckd"; mkdir "$T/4/outer/repo/.git"
printf '[workspace]\nmembers = ["*", "repo/*"]\n' > "$T/4/outer/Cargo.toml"
expect "workspace above .git ignored" "0|$(real "$T/4/outer/repo/flightdeckd")|.|release" "$(layout "$T/4/outer/repo/flightdeckd")"

# 5. a workspace in the repo that does not list the crate → standalone (+ a notice)
crate "$T/5/repo/flightdeckd"; mkdir "$T/5/repo/.git"
printf '[workspace]\nmembers = ["other"]\ndefault-members = ["flightdeckd"]\n' > "$T/5/repo/Cargo.toml"
expect "not a member → standalone" "0|$(real "$T/5/repo/flightdeckd")|.|release" "$(layout "$T/5/repo/flightdeckd")"
notice="$( (. "$T/5/repo/flightdeckd/scripts/lib-layout.sh"; fd_layout) 2>&1 >/dev/null)"
expect "the notice says why" "yes" "$(echo "$notice" | grep -q 'not one of its members' && echo yes || echo no)"

# 6. listed by a glob but excluded
crate "$T/6/repo/flightdeckd"; mkdir "$T/6/repo/.git"
printf '[workspace]\nmembers = ["*"]\nexclude = ["flightdeckd"]\n' > "$T/6/repo/Cargo.toml"
expect "excluded → standalone" "0|$(real "$T/6/repo/flightdeckd")|.|release" "$(layout "$T/6/repo/flightdeckd")"

# 7. the crate is its own repository: no walk at all
crate "$T/7/ws/flightdeckd"; mkdir "$T/7/ws/flightdeckd/.git"
printf '[workspace]\nmembers = ["flightdeckd"]\n' > "$T/7/ws/Cargo.toml"
expect "crate is a repo root" "0|$(real "$T/7/ws/flightdeckd")|.|release" "$(layout "$T/7/ws/flightdeckd")"

# 8. WORKSPACE_ROOT forces the root
crate "$T/8/x/flightdeckd"
expect "WORKSPACE_ROOT override" "1|$(real "$T/8/x")|flightdeckd|release" "$(layout "$T/8/x/flightdeckd" "$T/8/x")"

# 9. THIS crate, at its real position in its real host repo (not a throwaway
# tree, not a copy of lib-layout.sh) — imported into tosse-code as a
# standalone package (docs/MONOREPO-MOVE.md's lower-risk variant): as long as
# tosse-code has no root [workspace] Cargo.toml, this crate must self-report
# standalone. Guards the actual regression this move could introduce: an
# ancestor Cargo.toml (tosse-code's own, or something above the checkout) with
# a stray [workspace] table being picked up by mistake.
real_crate="$(cd "$(dirname "$LIB")/.." && pwd)"
expect "real position: standalone in tosse-code" "0|$real_crate|.|release" "$(layout "$real_crate")"

[ "$FAILED" = 0 ] && echo "lib-layout: all cases pass" || { echo "lib-layout: FAILURES"; exit 1; }
