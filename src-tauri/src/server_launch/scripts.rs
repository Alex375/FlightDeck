//! The server half of a launch: the POSIX `sh` scripts it runs there, and the reading of
//! what they answer.
//!
//! Two transports, as in `remote_files`:
//! - most scripts travel on ssh's STDIN (`sh -s`): the login shell (bash, zsh on a Mac
//!   server, fish…) never parses them, so they may hold any quoting; every value is
//!   embedded as a single-quoted assignment ([`shq`]) that only `sh` reads;
//! - the two that carry a PAYLOAD on stdin (the bundle, the staged changes) cannot, so they
//!   go through `sh -c` like `remote_files::upload` — a FIXED string with no `'` and no `\`
//!   (a test checks), every value a positional argument.
//!
//! Framing: every line meant for us starts with [`TAG`]; anything else (a chatty login
//! script) is skipped. Each script ends with `FDLX1 ok[ <value>]` or `FDLX1 error <reason>`.

use crate::ipc::commands::shq;

/// The line tag. Versioned, like `FDREAD1` / `FDUP1`.
pub const TAG: &str = "FDLX1 ";

/// Where Flight Deck keeps its managed clones, under the server's `$HOME`.
pub const CLONES_BASE: &str = "flightdeck/repos";

/// The server user's own facts, and whether it has the tools a launch needs.
pub const FACTS: &str = r#"printf 'FDLX1 os %s\n' "$(uname -s 2>/dev/null)"
printf 'FDLX1 user %s\n' "$(id -un 2>/dev/null)"
printf 'FDLX1 home %s\n' "$HOME"
printf 'FDLX1 host %s\n' "$(uname -n 2>/dev/null)"
if command -v git >/dev/null 2>&1; then printf 'FDLX1 git %s\n' "$(git --version 2>/dev/null)"; fi
if command -v tar >/dev/null 2>&1; then printf 'FDLX1 tar yes\n'; fi
printf 'FDLX1 ok\n'
"#;

/// Every folder under the managed base: a managed clone with its origin and source marker,
/// or just a name already taken.
pub const LIST_CLONES: &str = r#"B="$HOME/flightdeck/repos"
printf 'FDLX1 base %s\n' "$B"
if [ -d "$B" ]; then
  for d in "$B"/* "$B"/.[!.]*; do
    [ -e "$d" ] || continue
    n=${d##*/}
    printf 'FDLX1 name %s\n' "$n"
    [ -d "$d/.git" ] || continue
    m=$(git -C "$d" config --get flightdeck.managed 2>/dev/null)
    [ "$m" = true ] || continue
    o=$(git -C "$d" remote get-url origin 2>/dev/null)
    s=$(git -C "$d" config --get flightdeck.source 2>/dev/null)
    printf 'FDLX1 clone %s\t%s\t%s\n' "$d" "$o" "$s"
  done
fi
printf 'FDLX1 ok\n'
"#;

/// A clone's refs, the branches its worktrees have checked out, and the folders under its
/// `.claude/worktrees/`. Prunes worktrees whose folder is gone first, so a branch they held
/// is free again.
pub fn clone_state(clone: &str) -> String {
    format!(
        r#"C={c}
cd "$C" 2>/dev/null || {{ printf 'FDLX1 error no clone at %s\n' "$C"; exit 0; }}
git worktree prune 2>/dev/null
git for-each-ref --format='FDLX1 ref %(objectname) %(refname)'
git worktree list --porcelain 2>/dev/null | sed -n 's/^branch /FDLX1 checkedout /p'
if [ -d .claude/worktrees ]; then
  for d in .claude/worktrees/* .claude/worktrees/.[!.]*; do
    [ -e "$d" ] && printf 'FDLX1 wtdir %s\n' "${{d##*/}}"
  done
fi
printf 'FDLX1 ok\n'
"#,
        c = shq(clone)
    )
}

/// Everything [`apply_repo`] needs.
pub struct ApplyRepo<'a> {
    pub clone: &'a str,
    /// Create the clone (it must not exist yet) rather than update it.
    pub create: bool,
    /// The uploaded bundle on the server, `None` when nothing new was sent.
    pub bundle: Option<&'a str>,
    pub origin: Option<&'a str>,
    pub source: &'a str,
    pub head: &'a str,
    /// `git update-ref --stdin` commands ([`super::plan::ref_updates`]).
    pub ref_updates: &'a [String],
}

/// The delimiter of the ref updates' here-document. A line of `update-ref` input is
/// `update|delete <ref> …`, never this.
const REFS_EOF: &str = "FDLX1_REFS_END";

/// Bring the clone up to date with the transfer: create it if asked (marked managed, its
/// origin the Mac's — redacted — url, `.claude/worktrees/` excluded), store the bundle's
/// objects, move the refs in ONE transaction. A clone this script created and could not
/// finish is removed; the uploaded bundle is removed either way.
pub fn apply_repo(a: &ApplyRepo<'_>) -> String {
    let mut refs = String::new();
    for l in a.ref_updates {
        // Ref names cannot hold a newline (git refuses them), so a line never splits; the
        // check keeps a malformed one from ending the here-document early.
        if !l.contains('\n') && l != REFS_EOF {
            refs.push_str(l);
            refs.push('\n');
        }
    }
    format!(
        r#"C={c}
NEW={new}
B={b}
ORIGIN={origin}
SOURCE={source}
HEADSHA={head}
export GIT_LFS_SKIP_SMUDGE=1
fail() {{
  printf 'FDLX1 error %s\n' "$*"
  [ -n "$B" ] && rm -f "$B"
  if [ "$NEW" = 1 ] && [ "$MADE" = 1 ]; then rm -rf "$C"; fi
  exit 0
}}
MADE=0
if [ "$NEW" = 1 ]; then
  [ -e "$C" ] && fail "$C already exists on the server"
  mkdir -p "$(dirname "$C")" 2>/dev/null || fail "cannot create $(dirname "$C")"
  out=$(git init -q "$C" 2>&1) || fail "git init failed: $out"
  MADE=1
  git -C "$C" config flightdeck.managed true || fail "cannot write the clone's config"
  git -C "$C" config flightdeck.source "$SOURCE" || fail "cannot write the clone's config"
  if [ -n "$ORIGIN" ]; then git -C "$C" remote add origin "$ORIGIN" || fail "cannot set the clone's origin"; fi
  mkdir -p "$C/.git/info" && printf '/.claude/worktrees/\n' >> "$C/.git/info/exclude"
fi
[ -d "$C/.git" ] || fail "no clone at $C"
if [ -n "$B" ]; then
  out=$(git -C "$C" bundle verify -q "$B" 2>&1) || fail "the transferred bundle does not apply to this clone: $out"
  out=$(git -C "$C" bundle unbundle "$B" 2>&1 >/dev/null) || fail "storing the transferred commits failed: $out"
  rm -f "$B"
fi
out=$(git -C "$C" update-ref --stdin 2>&1 <<'{eof}'
{refs}{eof}
) || fail "updating the clone's refs failed: $out"
if [ "$NEW" = 1 ]; then
  out=$(git -C "$C" -c advice.detachedHead=false checkout -q --detach "$HEADSHA" 2>&1) || printf 'FDLX1 note the clone folder itself was left empty: %s\n' "$out"
fi
printf 'FDLX1 ok\n'
"#,
        c = shq(a.clone),
        new = if a.create { 1 } else { 0 },
        b = shq(a.bundle.unwrap_or("")),
        origin = shq(a.origin.unwrap_or("")),
        source = shq(a.source),
        head = shq(a.head),
        eof = REFS_EOF,
        refs = refs,
    )
}

/// The upload script (`sh -c SCRIPT fd-launch <launch id> <file name> <size>`): writes stdin
/// to `~/.cache/flightdeck/launch/<launch id>/<file name>` (`umask 077`) and checks it
/// arrived whole. ⚠️ No `'` and no `\` — it is single-quoted for the login shell.
pub const UPLOAD: &str = r#"umask 077
D="$HOME/.cache/flightdeck/launch/$1"
mkdir -p "$D" 2>/dev/null
if [ ! -d "$D" ] || [ ! -w "$D" ]; then echo "FDLX1 error cannot write to $D"; exit 0; fi
F="$D/$2"
cat > "$F"
S=$(wc -c < "$F" | tr -d " ")
if [ "$S" != "$3" ]; then rm -f "$F"; echo "FDLX1 short $S"; exit 0; fi
echo "FDLX1 ok $F"
"#;

/// The remote command line of one upload. The values are validated by the caller (a uuid, a
/// fixed file name) and quoted here anyway.
pub fn upload_command(launch_id: &str, file_name: &str, size: u64) -> String {
    format!("sh -c {} fd-launch {} {} {size}", shq(UPLOAD), shq(launch_id), shq(file_name))
}

/// How the worktree's branch is set up, as the script takes it.
pub enum BranchStep<'a> {
    Create { name: &'a str },
    FastForward { name: &'a str, old: &'a str },
    Detached,
}

/// Everything [`create_worktree`] needs.
pub struct CreateWorktree<'a> {
    pub clone: &'a str,
    pub worktree: &'a str,
    pub commit: &'a str,
    pub branch: BranchStep<'a>,
    /// The uploaded archive of the uncommitted state (`index.patch`, `worktree.patch`,
    /// `files.tar`), `None` when there was none.
    pub stage: Option<&'a str>,
}

/// Create the worktree at the commit, on its branch, and lay the Mac's uncommitted state
/// over it: the staged changes into the index AND the files, the unstaged ones into the
/// files only, then the copied files. All or nothing — any failure removes the worktree and
/// puts the branch back as it was, and KEEPS the staged archive, so a retry needs no new
/// upload (the launch's cleanup removes it). Removed once applied.
pub fn create_worktree(c: &CreateWorktree<'_>) -> String {
    let (mode, br, old) = match c.branch {
        BranchStep::Create { name } => ("create", name, ""),
        BranchStep::FastForward { name, old } => ("ff", name, old),
        BranchStep::Detached => ("detached", "", ""),
    };
    format!(
        r#"C={c}
W={w}
COMMIT={commit}
MODE={mode}
BR={br}
OLD={old}
STAGE={stage}
export GIT_LFS_SKIP_SMUDGE=1
X=""
WT=0
BRDONE=""
cleanup() {{
  if [ "$WT" = 1 ]; then git -C "$C" worktree remove --force "$W" >/dev/null 2>&1; rm -rf "$W"; git -C "$C" worktree prune >/dev/null 2>&1; fi
  case "$BRDONE" in
    created) git -C "$C" update-ref -d "refs/heads/$BR" "$COMMIT" >/dev/null 2>&1 ;;
    moved) git -C "$C" update-ref "refs/heads/$BR" "$OLD" "$COMMIT" >/dev/null 2>&1 ;;
  esac
  [ -n "$X" ] && rm -rf "$X"
}}
fail() {{ printf 'FDLX1 error %s\n' "$*"; cleanup; exit 0; }}
[ -d "$C/.git" ] || fail "no clone at $C"
[ -e "$W" ] && fail "$W already exists on the server"
if [ -n "$STAGE" ]; then
  X="$STAGE.d"
  rm -rf "$X"; mkdir -p "$X" || fail "cannot unpack the uncommitted changes"
  out=$(tar -xf "$STAGE" -C "$X" 2>&1) || fail "cannot unpack the uncommitted changes: $out"
fi
case "$MODE" in
  create)
    out=$(git -C "$C" update-ref "refs/heads/$BR" "$COMMIT" "" 2>&1) || fail "cannot create the branch $BR: $out"
    BRDONE=created
    out=$(git -C "$C" worktree add -q "$W" "$BR" 2>&1) || fail "git worktree add failed: $out" ;;
  ff)
    if [ "$OLD" != "$COMMIT" ]; then
      out=$(git -C "$C" update-ref "refs/heads/$BR" "$COMMIT" "$OLD" 2>&1) || fail "cannot move the branch $BR: $out"
      BRDONE=moved
    fi
    out=$(git -C "$C" worktree add -q "$W" "$BR" 2>&1) || fail "git worktree add failed: $out" ;;
  detached)
    out=$(git -C "$C" worktree add -q --detach "$W" "$COMMIT" 2>&1) || fail "git worktree add failed: $out" ;;
  *) fail "unknown branch mode $MODE" ;;
esac
WT=1
if [ -n "$X" ]; then
  if [ -s "$X/index.patch" ]; then
    out=$(git -C "$W" apply --index --binary --whitespace=nowarn "$X/index.patch" 2>&1) || fail "the staged changes do not apply: $out"
  fi
  if [ -s "$X/worktree.patch" ]; then
    out=$(git -C "$W" apply --binary --whitespace=nowarn "$X/worktree.patch" 2>&1) || fail "the unstaged changes do not apply: $out"
  fi
  if [ -s "$X/files.tar" ]; then
    out=$(tar -xf "$X/files.tar" -C "$W" --no-same-owner 2>&1) || fail "the copied files could not be written: $out"
  fi
  rm -rf "$X"
  rm -f "$STAGE"
fi
printf 'FDLX1 ok %s\n' "$W"
"#,
        c = shq(c.clone),
        w = shq(c.worktree),
        commit = shq(c.commit),
        mode = mode,
        br = shq(br),
        old = shq(old),
        stage = shq(c.stage.unwrap_or("")),
    )
}

/// Remove this launch's leftovers on the server: its upload folder and — when the launch is
/// abandoned after the worktree was made — that worktree and the branch it created.
pub fn cleanup(launch_id: &str, discard: Option<(&str, &str, Option<&str>)>) -> String {
    let mut s = format!(
        "rm -rf \"$HOME/.cache/flightdeck/launch/\"{id}\n",
        id = shq(launch_id)
    );
    if let Some((clone, worktree, created_branch)) = discard {
        s.push_str(&format!(
            "C={c}\nW={w}\nBR={br}\n\
             if [ -e \"$W\" ]; then git -C \"$C\" worktree remove --force \"$W\" >/dev/null 2>&1; rm -rf \"$W\"; fi\n\
             git -C \"$C\" worktree prune >/dev/null 2>&1\n\
             if [ -n \"$BR\" ]; then git -C \"$C\" branch -D \"$BR\" >/dev/null 2>&1; fi\n",
            c = shq(clone),
            w = shq(worktree),
            br = shq(created_branch.unwrap_or("")),
        ));
    }
    s.push_str("printf 'FDLX1 ok\\n'\n");
    s
}

// ---- Reading the answers ----------------------------------------------------------------

/// The tagged lines of a script's stdout, as `(kind, rest)`.
pub fn tagged(stdout: &str) -> Vec<(&str, &str)> {
    stdout
        .lines()
        .filter_map(|l| l.strip_prefix(TAG))
        .map(|l| l.split_once(' ').unwrap_or((l, "")))
        .collect()
}

/// How a script ended: `Ok(value after "ok")`, `Err(reason)` on `error`, `Err` too when it
/// never said (the shell died, ssh failed — `fallback` says what is known).
pub fn outcome<'a>(lines: &[(&'a str, &'a str)], fallback: impl FnOnce() -> String) -> Result<&'a str, String> {
    for (k, v) in lines.iter().rev() {
        match *k {
            "ok" => return Ok(v),
            "error" => return Err(crate::remote_files::sanitize(v)),
            "short" => return Err(format!("the upload arrived incomplete ({} bytes)", crate::remote_files::sanitize(v))),
            _ => {}
        }
    }
    Err(fallback())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_payload_script_survives_single_quoting_in_any_login_shell() {
        assert!(!UPLOAD.contains('\''), "a quote would end the single-quoted script");
        assert!(!UPLOAD.contains('\\'), "fish reads a backslash in single quotes");
    }

    #[test]
    fn tagged_lines_skip_login_noise_and_read_the_outcome() {
        let out = "Welcome!\nFDLX1 home /home/j\nFDLX1 ok\n";
        let l = tagged(out);
        assert_eq!(l, [("home", "/home/j"), ("ok", "")]);
        assert_eq!(outcome(&l, || "none".into()), Ok(""));
        let l = tagged("FDLX1 error no clone at /x\n");
        assert_eq!(outcome(&l, || "none".into()), Err("no clone at /x".to_string()));
        assert_eq!(outcome(&tagged("garbage"), || "ssh failed".into()), Err("ssh failed".to_string()));
    }

    #[test]
    fn a_ref_line_cannot_end_the_here_document() {
        let refs = vec!["update refs/heads/a 1".to_string(), REFS_EOF.to_string(), "x\ny".to_string()];
        let s = apply_repo(&ApplyRepo {
            clone: "/c",
            create: false,
            bundle: None,
            origin: None,
            source: "m:/p",
            head: "1",
            ref_updates: &refs,
        });
        assert_eq!(s.matches(REFS_EOF).count(), 2, "{s}");
        assert!(!s.contains("x\ny"));
    }
}
