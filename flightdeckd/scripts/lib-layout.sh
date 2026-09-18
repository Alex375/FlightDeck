# Sourced by the build/smoke scripts: where the crate, its Cargo workspace (if
# any) and the musl outputs live. The same scripts work for a STANDALONE crate
# (flightdeck-server/flightdeckd, or tosse-code/flightdeckd imported as its own
# package) and for a WORKSPACE MEMBER (tosse-code's Cargo workspace): the
# workspace is the nearest ancestor Cargo.toml with a [workspace] table WITHIN
# the crate's git repository that really lists the crate as a member (like
# cargo); anything else means standalone. WORKSPACE_ROOT=<dir> forces it.
#
# Sets: FD_CRATE_DIR, FD_ROOT (what is mounted in the builder: the workspace
# root, or the crate itself), FD_WORKSPACE (1/0), FD_CRATE_REL, FD_PROFILE,
# FD_PROFILE_DIR, FD_TARGET_DIR, FD_DIST_DIR, FD_TARGETS.
# The TOML array `key = [ ... ]` of the [workspace] table in $1/Cargo.toml,
# one entry per line, quotes and trailing slashes stripped. Multi-line arrays
# are fine; `default-members` never matches `members`.
fd_workspace_list() {
  awk '/^\[workspace\][[:space:]]*$/ { w = 1; next } /^\[/ { w = 0 } w' "$1/Cargo.toml" | tr '\n' ' ' \
    | sed -nE "s/^(.*[[:space:]])?$2[[:space:]]*=[[:space:]]*\[([^]]*)\].*$/\2/p" \
    | tr ',' '\n' | sed -E 's/^[[:space:]]*"?//; s/"?[[:space:]]*$//; s#/$##' | grep -v '^$' || true
}

# Is the crate at $2 (relative to $1) a member of the workspace in
# $1/Cargo.toml? Same rules as cargo: listed in `members` (globs allowed) and
# not in `exclude`. No cargo needed on the host.
fd_is_member() {
  local pat hit=1
  while IFS= read -r pat; do
    # shellcheck disable=SC2053  # unquoted on purpose: glob match
    if [[ "$2" == $pat ]]; then hit=0; break; fi
  done < <(fd_workspace_list "$1" members)
  [ "$hit" = 0 ] || return 1
  while IFS= read -r pat; do
    # shellcheck disable=SC2053
    if [[ "$2" == $pat ]]; then return 1; fi
  done < <(fd_workspace_list "$1" exclude)
  return 0
}

fd_layout() {
  FD_CRATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  FD_ROOT=""
  if [ -n "${WORKSPACE_ROOT:-}" ]; then
    FD_ROOT="$(cd "$WORKSPACE_ROOT" && pwd)"
  else
    # The nearest ancestor with a [workspace] table, never above the git
    # repository the crate lives in, and only if it really lists the crate —
    # an unrelated workspace higher up is ignored (standalone build).
    local d="$FD_CRATE_DIR" rel
    while [ ! -e "$d/.git" ] && [ "$d" != "/" ]; do
      d="$(dirname "$d")"
      if [ -f "$d/Cargo.toml" ] && grep -qs '^\[workspace\]' "$d/Cargo.toml"; then
        rel="${FD_CRATE_DIR#"$d"/}"
        if fd_is_member "$d" "$rel"; then
          FD_ROOT="$d"
        else
          echo "· ignoring the Cargo workspace at $d: flightdeckd ($rel) is not one of its members — building it standalone" >&2
        fi
        break
      fi
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
