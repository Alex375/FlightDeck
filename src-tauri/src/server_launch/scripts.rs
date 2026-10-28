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

/// The server user's own facts, and whether it has the tools a launch needs. Also sweeps the
/// upload folders of launches older than a day (one the app never ended — quit or crash in
/// the middle — leaves a staged archive, secrets included): best effort, at every launch.
pub const FACTS: &str = r#"L="$HOME/.cache/flightdeck/launch"
if [ -d "$L" ]; then find "$L" -mindepth 1 -maxdepth 1 -mtime +0 -exec rm -rf {} + 2>/dev/null; fi
printf 'FDLX1 os %s\n' "$(uname -s 2>/dev/null)"
printf 'FDLX1 user %s\n' "$(id -un 2>/dev/null)"
printf 'FDLX1 home %s\n' "$HOME"
printf 'FDLX1 host %s\n' "$(uname -n 2>/dev/null)"
if command -v git >/dev/null 2>&1; then printf 'FDLX1 git %s\n' "$(git --version 2>/dev/null)"; fi
if command -v tar >/dev/null 2>&1; then printf 'FDLX1 tar yes\n'; fi
printf 'FDLX1 ok\n'
"#;

/// Every folder under the managed base: a managed clone with its origin and source marker,
/// or just a name already taken — or a clone git cannot read (`unreadable`, with git's
/// words: an ownership `safe.directory` refusal, a corrupt config), which the Mac reports
/// rather than quietly creating a second clone beside it.
pub const LIST_CLONES: &str = r#"B="$HOME/flightdeck/repos"
printf 'FDLX1 base %s\n' "$B"
if [ -d "$B" ]; then
  for d in "$B"/* "$B"/.[!.]*; do
    [ -e "$d" ] || continue
    n=${d##*/}
    printf 'FDLX1 name %s\n' "$n"
    [ -e "$d/.git" ] || continue
    # `config --get` answers a refusal (dubious ownership, a broken .git) like a missing key:
    # exit 1, nothing said. `rev-parse` says it.
    if ! e=$(git -C "$d" rev-parse --git-dir 2>&1 >/dev/null); then
      printf 'FDLX1 unreadable %s\t%s\n' "$d" "$(printf '%s' "$e" | tr '\n\t' '  ')"
      continue
    fi
    m=$(git -C "$d" config --local --get flightdeck.managed 2>/dev/null)
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
# A failed listing must not read as "the clone has nothing" (that would resend everything).
refs=$(git for-each-ref --format='FDLX1 ref %(objectname) %(refname)' 2>&1) || {{ printf 'FDLX1 error cannot list the refs of %s: %s\n' "$C" "$(printf '%s' "$refs" | tr '\n' ' ')"; exit 0; }}
wl=$(git worktree list --porcelain 2>&1) || {{ printf 'FDLX1 error cannot list the worktrees of %s: %s\n' "$C" "$(printf '%s' "$wl" | tr '\n' ' ')"; exit 0; }}
[ -n "$refs" ] && printf '%s\n' "$refs"
printf '%s\n' "$wl" | sed -n 's/^branch /FDLX1 checkedout /p'
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
    /// `git update-ref --stdin` commands ([`super::plan::ref_updates`]): the deletes, run as
    /// their own transaction BEFORE the updates (git refuses deleting `x` and creating `x/y`
    /// in one).
    pub deletes: &'a [String],
    pub updates: &'a [String],
}

/// The unborn branch a NEW clone's own folder sits on: no worktree will ever want it, so it
/// never blocks one (`worktree add` refuses a branch checked out anywhere — an unborn
/// `main` of `git init` included), and nothing is checked out in the clone's folder itself.
pub const CLONE_ROOT_BRANCH: &str = "refs/heads/flightdeck-clone-root";

/// One launch at a time in a clone (`mkdir` is atomic): two launches of the same repository —
/// a cancelled one still running beside its restart, two conversations — never interleave
/// their ref moves, worktree creations and rollbacks. A lock older than 30 minutes is a
/// leftover (a killed script) and is taken over; past two minutes of waiting, the step says so.
/// Released on exit, whatever the outcome. Needs `$C`.
const CLONE_LOCK: &str = r#"LOCK="$C/.git/flightdeck.lock"
n=0
while ! mkdir "$LOCK" 2>/dev/null; do
  if [ -n "$(find "$LOCK" -maxdepth 0 -mmin +30 2>/dev/null)" ]; then rmdir "$LOCK" 2>/dev/null; continue; fi
  n=$((n + 1))
  if [ "$n" -gt 120 ]; then printf 'FDLX1 error another launch has been using %s for over two minutes — retry once it is done\n' "$C"; exit 0; fi
  sleep 1
done
trap 'rmdir "$LOCK" 2>/dev/null' EXIT
"#;

/// `update-ref --stdin` input: one command per line. A line holding a newline is dropped (a
/// ref name never does — git refuses them), so the input can't be split into other commands.
fn ref_input(lines: &[String]) -> String {
    lines.iter().filter(|l| !l.contains('\n')).map(|l| format!("{l}\n")).collect()
}

/// Bring the clone up to date with the transfer: create it if asked (marked managed, its
/// origin the Mac's — redacted — url, `.claude/worktrees/` excluded), store the bundle's
/// objects, move the refs (deletes, then updates, each one transaction). A clone this script
/// created and could not finish is removed; the uploaded bundle is removed either way.
///
/// ⚠️ The ref names (another person can push a branch to the origin this Mac fetches) reach
/// `git` ONLY as the value of a top-level single-quoted assignment, piped with `printf`. Never
/// inside `$( … )`: bash 3.2 — a Mac server's `sh` — scans a command substitution as text
/// and lets a `)` in a here-document there close it, running the rest as shell.
pub fn apply_repo(a: &ApplyRepo<'_>) -> String {
    format!(
        r#"C={c}
NEW={new}
B={b}
ORIGIN={origin}
SOURCE={source}
DELETES={deletes}
UPDATES={updates}
ROOT={root}
export GIT_LFS_SKIP_SMUDGE=1
MADE=0
fail() {{
  printf 'FDLX1 error %s\n' "$*"
  [ -n "$B" ] && rm -f "$B"
  if [ "$NEW" = 1 ] && [ "$MADE" = 1 ]; then rm -rf "$C"; fi
  exit 0
}}
if [ "$NEW" = 1 ]; then
  mkdir -p "$(dirname "$C")" 2>/dev/null || fail "cannot create $(dirname "$C")"
  # Atomic: only the launch whose mkdir succeeded owns (and may remove) this folder.
  mkdir "$C" 2>/dev/null || fail "$C already exists on the server — retry to use it"
  MADE=1
  out=$(git init -q "$C" 2>&1) || fail "git init failed: $out"
  out=$(git -C "$C" symbolic-ref HEAD "$ROOT" 2>&1) || fail "cannot set up the clone: $out"
  git -C "$C" config flightdeck.source "$SOURCE" || fail "cannot write the clone's config"
  if [ -n "$ORIGIN" ]; then git -C "$C" remote add origin "$ORIGIN" || fail "cannot set the clone's origin"; fi
  mkdir -p "$C/.git/info" && printf '/.claude/worktrees/\n' >> "$C/.git/info/exclude" || fail "cannot write the clone's exclude file"
fi
[ -d "$C/.git" ] || fail "no clone at $C"
{lock}
if [ -n "$B" ]; then
  out=$(git -C "$C" bundle verify "$B" 2>&1) || fail "the transferred bundle does not apply to this clone: $out"
  out=$(git -C "$C" bundle unbundle "$B" 2>&1 >/dev/null) || fail "storing the transferred commits failed: $out"
  rm -f "$B"
fi
if [ -n "$DELETES" ]; then
  out=$(printf '%s' "$DELETES" | git -C "$C" update-ref --stdin 2>&1) || fail "removing the clone's stale refs failed: $out"
fi
out=$(printf '%s' "$UPDATES" | git -C "$C" update-ref --stdin 2>&1) || fail "updating the clone's refs failed: $out"
# Marked LAST: until then another launch sees a folder name taken, never a clone to adopt
# half-made (and this one's `fail` may still remove it).
if [ "$NEW" = 1 ]; then git -C "$C" config flightdeck.managed true || fail "cannot write the clone's config"; fi
printf 'FDLX1 ok\n'
"#,
        lock = CLONE_LOCK,
        c = shq(a.clone),
        new = if a.create { 1 } else { 0 },
        b = shq(a.bundle.unwrap_or("")),
        origin = shq(a.origin.unwrap_or("")),
        source = shq(a.source),
        deletes = shq(&ref_input(a.deletes)),
        updates = shq(&ref_input(a.updates)),
        root = shq(CLONE_ROOT_BRANCH),
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
    /// The launch: what it made is recorded in its folder, so the step run again (its answer
    /// lost to a dropped link) answers with THAT worktree instead of making a second one.
    pub launch_id: &'a str,
    pub clone: &'a str,
    pub worktree: &'a str,
    /// The subfolder the conversation runs in (`""`: the worktree itself) — made when the
    /// checkout and the copies did not bring it (a folder of untracked work only).
    pub subdir: &'a str,
    pub commit: &'a str,
    pub branch: BranchStep<'a>,
    /// The uploaded archive of the uncommitted state (`index.patch`, `worktree.patch`,
    /// `files.tar`), `None` when there was none.
    pub stage: Option<&'a str>,
    /// Which of the three this Mac put in it: one expected and missing is an error (the
    /// archive went away under the step — a cancel), never quietly skipped.
    pub expect_index: bool,
    pub expect_worktree: bool,
    pub expect_files: bool,
}

/// Create the worktree at the commit, on its branch, and lay the Mac's uncommitted state
/// over it: the staged changes into the index AND the files, the unstaged ones into the
/// files only, then the copied files. All or nothing — any failure removes the worktree and
/// puts the branch back as it was (and says so if THAT fails). The staged archive is never
/// removed here (the launch's cleanup removes its whole folder): a retry needs no new upload.
///
/// Answers `FDLX1 branch <name>` (empty when detached) and `FDLX1 created <0|1>` before its
/// `ok <worktree>` — what was REALLY done, which a re-run reads back from the launch's record.
pub fn create_worktree(c: &CreateWorktree<'_>) -> String {
    let (mode, br, old) = match c.branch {
        BranchStep::Create { name } => ("create", name, ""),
        BranchStep::FastForward { name, old } => ("ff", name, old),
        BranchStep::Detached => ("detached", "", ""),
    };
    let flag = |b: bool| if b { 1 } else { 0 };
    format!(
        r#"C={c}
W={w}
SUB={sub}
COMMIT={commit}
MODE={mode}
BR={br}
OLD={old}
STAGE={stage}
EXP_INDEX={ei}
EXP_WT={ew}
EXP_FILES={ef}
export GIT_LFS_SKIP_SMUDGE=1
X=""
WT=0
BRDONE=""
LEFT=""
cleanup() {{
  if [ "$WT" = 1 ]; then
    git -C "$C" worktree remove --force "$W" >/dev/null 2>&1
    rm -rf "$W"
    git -C "$C" worktree prune >/dev/null 2>&1
    [ -e "$W" ] && LEFT="$LEFT the worktree $W;"
  fi
  case "$BRDONE" in
    created) git -C "$C" update-ref -d "refs/heads/$BR" "$COMMIT" >/dev/null 2>&1 || LEFT="$LEFT the branch $BR;" ;;
    moved) git -C "$C" update-ref "refs/heads/$BR" "$OLD" "$COMMIT" >/dev/null 2>&1 || LEFT="$LEFT the branch $BR, moved to the new commit;" ;;
  esac
  [ -n "$X" ] && rm -rf "$X"
}}
fail() {{
  msg="$*"
  cleanup
  [ -n "$LEFT" ] && msg="$msg (and this could not be undone:$LEFT)"
  printf 'FDLX1 error %s\n' "$msg"
  exit 0
}}
[ -d "$C/.git" ] || fail "no clone at $C"
{lock}
# Made already by this launch (the answer lost on the way back): that one, as it was made.
DONE="$HOME/.cache/flightdeck/launch/"{id}"/worktree.done"
if [ -s "$DONE" ]; then
  {{ read -r W0; read -r BR0; read -r CR0; }} < "$DONE"
  if [ -d "$W0" ]; then
    printf 'FDLX1 branch %s\nFDLX1 created %s\nFDLX1 ok %s\n' "$BR0" "$CR0" "$W0"
    exit 0
  fi
fi
[ -e "$W" ] && fail "$W already exists on the server"
if [ -n "$STAGE" ]; then
  [ -s "$STAGE" ] || fail "the uncommitted changes sent earlier are gone from the server — copy them again"
  X="$STAGE.d"
  rm -rf "$X"; mkdir -p "$X" || fail "cannot unpack the uncommitted changes"
  out=$(tar -xf "$STAGE" -C "$X" 2>&1) || fail "cannot unpack the uncommitted changes: $out"
  for p in "index.patch:$EXP_INDEX" "worktree.patch:$EXP_WT" "files.tar:$EXP_FILES"; do
    f=${{p%%:*}}
    if [ "${{p##*:}}" = 1 ] && [ ! -s "$X/$f" ]; then fail "the uncommitted changes arrived without $f — copy them again"; fi
  done
fi
case "$MODE" in
  create)
    out=$(git -C "$C" update-ref "refs/heads/$BR" "$COMMIT" "" 2>&1) || fail "cannot create the branch $BR: $out"
    BRDONE=created
    out=$(git -C "$C" worktree add "$W" "$BR" 2>&1) || fail "git worktree add failed: $out" ;;
  ff)
    if [ "$OLD" != "$COMMIT" ]; then
      out=$(git -C "$C" update-ref "refs/heads/$BR" "$COMMIT" "$OLD" 2>&1) || fail "cannot move the branch $BR: $out"
      BRDONE=moved
    fi
    out=$(git -C "$C" worktree add "$W" "$BR" 2>&1) || fail "git worktree add failed: $out" ;;
  detached)
    out=$(git -C "$C" worktree add --detach "$W" "$COMMIT" 2>&1) || fail "git worktree add failed: $out" ;;
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
fi
if [ -n "$SUB" ] && [ ! -d "$W/$SUB" ]; then mkdir -p "$W/$SUB" || fail "cannot create $W/$SUB"; fi
CREATED=0
[ "$MODE" = create ] && CREATED=1
mkdir -p "$(dirname "$DONE")" && printf '%s\n%s\n%s\n' "$W" "$BR" "$CREATED" > "$DONE" || fail "cannot record the worktree made"
[ -n "$X" ] && rm -rf "$X"
printf 'FDLX1 branch %s\nFDLX1 created %s\nFDLX1 ok %s\n' "$BR" "$CREATED" "$W"
"#,
        lock = CLONE_LOCK,
        id = shq(c.launch_id),
        c = shq(c.clone),
        w = shq(c.worktree),
        sub = shq(c.subdir),
        commit = shq(c.commit),
        mode = mode,
        br = shq(br),
        old = shq(old),
        stage = shq(c.stage.unwrap_or("")),
        ei = flag(c.expect_index),
        ew = flag(c.expect_worktree),
        ef = flag(c.expect_files),
    )
}

/// Remove this launch's leftovers on the server: its upload folder and — when the launch is
/// abandoned after the worktree was made — that worktree and the branch it created. What
/// could not be removed is named in an `error` answer, never reported as done.
pub fn cleanup(launch_id: &str, discard: Option<(&str, &str, Option<&str>)>) -> String {
    let mut s = format!(
        "LEFT=\"\"\nD=\"$HOME/.cache/flightdeck/launch/\"{id}\nrm -rf \"$D\"\n[ -e \"$D\" ] && LEFT=\"$LEFT $D;\"\n",
        id = shq(launch_id)
    );
    if let Some((clone, worktree, created_branch)) = discard {
        s.push_str(&format!(
            "C={c}\nW={w}\nBR={br}\n\
             if [ -d \"$C/.git\" ]; then\n{lock}fi\n\
             if [ -e \"$W\" ]; then git -C \"$C\" worktree remove --force \"$W\" >/dev/null 2>&1; rm -rf \"$W\"; fi\n\
             git -C \"$C\" worktree prune >/dev/null 2>&1\n\
             [ -e \"$W\" ] && LEFT=\"$LEFT the worktree $W;\"\n\
             if [ -n \"$BR\" ] && git -C \"$C\" show-ref --verify -q \"refs/heads/$BR\"; then\n\
               git -C \"$C\" branch -D \"$BR\" >/dev/null 2>&1 || LEFT=\"$LEFT the branch $BR;\"\n\
             fi\n",
            lock = CLONE_LOCK,
            c = shq(clone),
            w = shq(worktree),
            br = shq(created_branch.unwrap_or("")),
        ));
    }
    s.push_str("if [ -n \"$LEFT\" ]; then printf 'FDLX1 error could not remove:%s\\n' \"$LEFT\"; else printf 'FDLX1 ok\\n'; fi\n");
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
    fn a_line_with_a_newline_never_reaches_update_ref() {
        assert_eq!(ref_input(&["update a 1".into(), "x\ny".into()]), "update a 1\n");
    }

    /// The ref names are another person's text (anyone who can push a branch to the origin
    /// this Mac fetches). Run under THIS Mac's `/bin/sh` — bash 3.2, a Mac server's `sh`, the
    /// shell that read a `)` in a here-document inside `$( )` as the end of it.
    #[test]
    fn a_hostile_ref_name_is_data_even_under_bash_3() {
        use std::process::{Command, Stdio};
        let dir = std::env::temp_dir().join(format!("fd-hostile-ref-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let git = |args: &[&str]| {
            let o = Command::new("git").arg("-C").arg(&dir).args(args).output().unwrap();
            assert!(o.status.success(), "{args:?}: {}", String::from_utf8_lossy(&o.stderr));
            String::from_utf8_lossy(&o.stdout).trim().to_string()
        };
        git(&["init", "-q"]);
        git(&["-c", "user.email=t@e", "-c", "user.name=T", "commit", "-q", "--allow-empty", "-m", "x"]);
        let sha = git(&["rev-parse", "HEAD"]);
        // Both valid ref names (`git check-ref-format` takes `)`, `$`, `{`, quotes, backquotes).
        let hostile = "refs/remotes/origin/x);touch${IFS}pwned;(true'\"`";
        let other = "refs/remotes/origin/y);touch${IFS}pwned;(true";
        let updates = vec![format!("update {other} {sha}"), format!("update {hostile} {sha}")];
        let script = apply_repo(&ApplyRepo {
            clone: dir.to_str().unwrap(),
            create: false,
            bundle: None,
            origin: None,
            source: "m:/p",
            deletes: &[],
            updates: &updates,
        });
        let mut child = Command::new("/bin/sh")
            .arg("-s")
            .current_dir(&dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        use std::io::Write as _;
        child.stdin.take().unwrap().write_all(script.as_bytes()).unwrap();
        let out = child.wait_with_output().unwrap();
        let stdout = String::from_utf8_lossy(&out.stdout);
        assert!(!dir.join("pwned").exists(), "a ref name ran as shell");
        assert!(stdout.contains("FDLX1 ok"), "{stdout}\n{}", String::from_utf8_lossy(&out.stderr));
        let refs = git(&["for-each-ref", "--format=%(refname)"]);
        assert!(refs.lines().any(|r| r == hostile) && refs.lines().any(|r| r == other), "{refs}");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
