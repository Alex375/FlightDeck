# Sourced by the build/smoke scripts: where the crate, its Cargo workspace (if
# any) and the musl outputs live. The same scripts work for a STANDALONE crate
# (flightdeck-server/flightdeckd, or tosse-code/flightdeckd imported as its own
# package) and for a WORKSPACE MEMBER (tosse-code's Cargo workspace): the
# workspace is detected like cargo does — the nearest ancestor Cargo.toml with a
# [workspace] table — or forced with WORKSPACE_ROOT=<dir>.
#
# Sets: FD_CRATE_DIR, FD_ROOT (what is mounted in the builder: the workspace
# root, or the crate itself), FD_WORKSPACE (1/0), FD_CRATE_REL, FD_PROFILE,
# FD_PROFILE_DIR, FD_TARGET_DIR, FD_DIST_DIR, FD_TARGETS.
fd_layout() {
  FD_CRATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  FD_ROOT=""
  if [ -n "${WORKSPACE_ROOT:-}" ]; then
    FD_ROOT="$(cd "$WORKSPACE_ROOT" && pwd)"
  else
    local d; d="$(dirname "$FD_CRATE_DIR")"
    while [ "$d" != "/" ]; do
      if [ -f "$d/Cargo.toml" ] && grep -q '^\[workspace\]' "$d/Cargo.toml"; then
        FD_ROOT="$d"
        break
      fi
      d="$(dirname "$d")"
    done
  fi
  if [ -n "$FD_ROOT" ] && [ "$FD_ROOT" != "$FD_CRATE_DIR" ]; then
    FD_WORKSPACE=1
    FD_CRATE_REL="${FD_CRATE_DIR#"$FD_ROOT"/}"
  else
    FD_WORKSPACE=0
    FD_ROOT="$FD_CRATE_DIR"
    FD_CRATE_REL="."
  fi
  # A workspace's [profile.release] belongs to the desktop app (panic = "abort":
  # one panicking session task would take the whole daemon down) — use its
  # dedicated [profile.daemon] when it has one. PROFILE=<name> overrides.
  if [ -n "${PROFILE:-}" ]; then
    FD_PROFILE="$PROFILE"
  elif [ "$FD_WORKSPACE" = 1 ] && grep -qs '^\[profile\.daemon\]' "$FD_ROOT/Cargo.toml"; then
    FD_PROFILE=daemon
  else
    FD_PROFILE=release
  fi
  case "$FD_PROFILE" in dev | test) FD_PROFILE_DIR=debug ;; bench) FD_PROFILE_DIR=release ;; *) FD_PROFILE_DIR="$FD_PROFILE" ;; esac
  FD_TARGET_DIR="$FD_ROOT/target/musl"
  FD_DIST_DIR="$FD_TARGET_DIR/dist"
  FD_TARGETS="${TARGETS:-x86_64-unknown-linux-musl aarch64-unknown-linux-musl}"
}

fd_describe() {
  if [ "$FD_WORKSPACE" = 1 ]; then
    echo "workspace member ${FD_CRATE_REL} of ${FD_ROOT}, profile ${FD_PROFILE}"
  else
    echo "standalone crate ${FD_CRATE_DIR}, profile ${FD_PROFILE}"
  fi
}
