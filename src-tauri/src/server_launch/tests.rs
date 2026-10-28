//! A whole launch, end to end, against a "server" that is a folder on this machine: a fake
//! `ssh` runs every remote command locally under a home of its own, so the real scripts, the
//! real bundle and the real patches are exercised without a network. The same steps against
//! a real server: `live_launch_on_the_test_box` (ignored).

use std::path::{Path, PathBuf};
use std::process::Command;

use super::*;
use crate::store::MachineRecord;

fn machine() -> MachineRecord {
    MachineRecord {
        id: "m1".into(),
        label: "Test box".into(),
        host: "box.example".into(),
        port: 22,
        user: "agent".into(),
        identity_file: None,
        added_at: 1,
        addresses: Vec::new(),
        daemon_mac_id: None,
        daemon_relay_url: None,
        daemon_label: None,
        phone_provisioned_at: None,
    }
}

/// One end-to-end launch at a time: each runs dozens of `git` and `sh` processes, and run
/// side by side they starve the crate's timing-sensitive tests (300 ms ssh deadlines).
static ONE_AT_A_TIME: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// A scratch tree: a bare "origin", this Mac's clone of it, a fake server home, and the
/// fake `ssh` that runs remote commands under that home.
struct World {
    root: PathBuf,
    // Released after `Drop::drop` removed the tree.
    _serial: std::sync::MutexGuard<'static, ()>,
}

impl World {
    fn new(tag: &str) -> Self {
        let serial = ONE_AT_A_TIME.lock().unwrap_or_else(|e| e.into_inner());
        let root = std::env::temp_dir().join(format!("fd-launch-{tag}-{}", uuid::Uuid::new_v4()));
        for d in ["origin.git", "mac", "home", "bin", "tmp"] {
            std::fs::create_dir_all(root.join(d)).unwrap();
        }
        let w = World { root, _serial: serial };
        let ssh = w.root.join("bin/ssh");
        std::fs::write(
            &ssh,
            format!(
                "#!/bin/sh\nfor a; do last=\"$a\"; done\nHOME={home}; export HOME\nunset GIT_DIR GIT_WORK_TREE\nexec /bin/sh -c \"$last\"\n",
                home = crate::ipc::commands::shq(&w.home().to_string_lossy())
            ),
        )
        .unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&ssh, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        git(&w.root.join("origin.git"), &["init", "-q", "--bare", "-b", "main"]);
        git(&w.root, &["clone", "-q", "origin.git", "mac"]);
        let mac = w.mac();
        git(&mac, &["config", "user.email", "t@example.com"]);
        git(&mac, &["config", "user.name", "T"]);
        git(&mac, &["checkout", "-q", "-b", "main"]);
        w
    }
    fn mac(&self) -> PathBuf {
        self.root.join("mac")
    }
    fn home(&self) -> PathBuf {
        self.root.join("home")
    }
    fn bin(&self) -> PathBuf {
        self.root.join("bin")
    }
    fn tmp(&self) -> PathBuf {
        self.root.join("tmp")
    }
    fn write(&self, rel: &str, body: &[u8]) {
        let p = self.mac().join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, body).unwrap();
    }
    fn commit(&self, msg: &str) {
        git(&self.mac(), &["add", "-A"]);
        git(&self.mac(), &["commit", "-q", "-m", msg]);
    }
}

impl Drop for World {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git").env("LC_ALL", "C").arg("-C").arg(dir).args(args).output().unwrap();
    assert!(out.status.success(), "git {args:?} in {}: {}", dir.display(), String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).into_owned()
}

fn no_progress(_: u64, _: u64) {}

/// This install's id, as the app would have minted it.
const MAC_ID: &str = "3f2c0b1e-0000-4000-8000-test-install";

#[tokio::test]
async fn a_clone_git_cannot_read_is_reported_not_doubled() {
    let w = World::new("unreadable");
    w.write("a.txt", b"one\n");
    w.commit("first");
    let m = machine();
    let bin = w.bin();
    let ctx = Ctx { machine: &m, known_hosts: None, ssh_bin: Some(&bin) };
    let cancel = Cancel::new();
    check(&ctx).await.unwrap();
    let mac = w.mac().to_string_lossy().into_owned();
    let t = transfer(&ctx, &uuid::Uuid::new_v4().to_string(), &mac, MAC_ID, &w.tmp(), &no_progress, &cancel).await.unwrap();
    // Break the clone: git can no longer read it (a broken HEAD).
    std::fs::write(PathBuf::from(&t.clone).join(".git/HEAD"), "garbage\n").unwrap();
    let e = transfer(&ctx, &uuid::Uuid::new_v4().to_string(), &mac, MAC_ID, &w.tmp(), &no_progress, &cancel)
        .await
        .unwrap_err();
    assert!(e.contains("can't be read by git"), "{e}");
    let names: Vec<_> = std::fs::read_dir(w.home().join("flightdeck/repos")).unwrap().flatten().collect();
    assert_eq!(names.len(), 1, "no second clone beside it");
}

/// The full pipeline, as the IPC layer drives it.
async fn launch(
    ctx: &Ctx<'_>,
    w: &World,
    id: &str,
) -> (ServerFacts, TransferOutcome, CopyOutcome, WorktreeOutcome) {
    let cancel = Cancel::new();
    let mac = w.mac().to_string_lossy().into_owned();
    let facts = check(ctx).await.expect("check");
    let t = transfer(ctx, id, &mac, MAC_ID, &w.tmp(), &no_progress, &cancel).await.expect("transfer");
    let c = copy(ctx, id, &t.local, &w.tmp(), &no_progress, &cancel).await.expect("copy");
    let wt = worktree(ctx, id, &t, &c).await.expect("worktree");
    (facts, t, c, wt)
}

/// This Mac's repository in the state the acceptance criterion names: commits not pushed,
/// staged and unstaged changes (a binary one among them), untracked work, a `.env`,
/// project skills, Claude's local settings — and what must NOT travel.
fn dirty_repository(w: &World) {
    w.write(".gitignore", b".env\nnode_modules/\n.claude/settings.local.json\n.claude/worktrees/\n*.log\n");
    w.write("a.txt", b"one\n");
    w.write("logo.bin", &[0u8, 1, 2, 3, 255, 254]);
    w.commit("first");
    git(&w.mac(), &["push", "-q", "-u", "origin", "main"]);
    w.write("b.txt", b"unpushed\n");
    w.commit("second, not pushed");
    // Staged, then changed again unstaged.
    w.write("a.txt", b"two\n");
    git(&w.mac(), &["add", "a.txt"]);
    w.write("a.txt", b"three\n");
    // A binary change, staged.
    w.write("logo.bin", &[9u8, 8, 7, 0, 0, 255]);
    git(&w.mac(), &["add", "logo.bin"]);
    // Untracked work, project skills (untracked, not ignored).
    w.write("notes.md", b"todo\n");
    w.write(".claude/skills/deploy/SKILL.md", b"# deploy\n");
    // Ignored, but needed.
    w.write(".env", b"API_KEY=secret\n");
    w.write(".claude/settings.local.json", b"{\"x\":1}\n");
    // Ignored, and stays.
    w.write("node_modules/dep/index.js", b"x\n");
    w.write("debug.log", b"noise\n");
    w.write(".claude/worktrees/other/.env", b"OTHER=1\n");
    // A user config porcelain `diff` follows and `apply` must not see: no a/ b/ prefixes,
    // and a textconv driver on the text files.
    git(&w.mac(), &["config", "diff.noprefix", "true"]);
    git(&w.mac(), &["config", "diff.upper.textconv", "tr a-z A-Z <"]);
    std::fs::write(w.mac().join(".git/info/attributes"), "*.txt diff=upper\n").unwrap();
}

#[tokio::test]
async fn a_launch_reproduces_the_exact_state_on_the_server() {
    let w = World::new("exact");
    dirty_repository(&w);
    let m = machine();
    let bin = w.bin();
    let ctx = Ctx { machine: &m, known_hosts: None, ssh_bin: Some(&bin) };
    let id = uuid::Uuid::new_v4().to_string();
    let (facts, t, c, wt) = launch(&ctx, &w, &id).await;

    let home = w.home().to_string_lossy().into_owned();
    assert_eq!(facts.home, home);
    assert!(facts.git.starts_with("git version"), "{facts:?}");
    assert!(facts.align.is_none(), "aligning is the IPC layer's (it needs the app)");
    assert!(t.created);
    assert!(t.bundle_bytes > 0);
    assert_eq!(t.clone, format!("{home}/flightdeck/repos/origin"));
    assert_eq!(t.local.branch.as_deref(), Some("main"));
    assert_eq!(t.local.unpushed, Some(1));
    assert_eq!(wt.worktree, format!("{}/.claude/worktrees/main", t.clone));
    assert_eq!(wt.branch.as_deref(), Some("main"));
    assert!(wt.created_branch);
    assert_eq!((c.staged, c.unstaged), (2, 1));

    let mac = w.mac();
    let srv = PathBuf::from(&wt.worktree);
    // Same commit, same index (blob for blob: the staged state exactly), same status.
    assert_eq!(git(&srv, &["rev-parse", "HEAD"]), git(&mac, &["rev-parse", "HEAD"]));
    assert_eq!(git(&srv, &["ls-files", "-s"]), git(&mac, &["ls-files", "-s"]));
    assert_eq!(git(&srv, &["status", "--porcelain"]), git(&mac, &["status", "--porcelain"]));
    assert_eq!(std::fs::read(srv.join("logo.bin")).unwrap(), [9u8, 8, 7, 0, 0, 255]);
    assert_eq!(std::fs::read_to_string(srv.join("a.txt")).unwrap(), "three\n");
    // What travels, and what does not.
    assert_eq!(std::fs::read_to_string(srv.join(".env")).unwrap(), "API_KEY=secret\n");
    assert_eq!(std::fs::read_to_string(srv.join("notes.md")).unwrap(), "todo\n");
    assert!(srv.join(".claude/skills/deploy/SKILL.md").is_file());
    assert!(srv.join(".claude/settings.local.json").is_file());
    assert!(!srv.join("node_modules").exists());
    assert!(!srv.join("debug.log").exists());
    assert!(!srv.join(".claude/worktrees").exists());
    let skipped: Vec<(&str, SkipWhy)> = c.skipped.iter().map(|s| (s.path.as_str(), s.why)).collect();
    assert!(skipped.contains(&("node_modules/", SkipWhy::Regenerable)), "{skipped:?}");
    assert!(skipped.contains(&("debug.log", SkipWhy::Ignored)), "{skipped:?}");
    assert!(skipped.contains(&(".claude/worktrees/", SkipWhy::Worktrees)), "{skipped:?}");
    let copied: Vec<(&str, CopyWhy)> = c.copied.iter().map(|f| (f.path.as_str(), f.why)).collect();
    assert!(copied.contains(&(".env", CopyWhy::Secret)), "{copied:?}");
    assert!(copied.contains(&(".claude/settings.local.json", CopyWhy::Claude)), "{copied:?}");
    assert!(copied.contains(&("notes.md", CopyWhy::Untracked)), "{copied:?}");
    // The clone: origin is the Mac's, its view of origin and of the Mac's branches are there.
    let clone = PathBuf::from(&t.clone);
    assert_eq!(git(&clone, &["remote", "get-url", "origin"]).trim(), git(&mac, &["remote", "get-url", "origin"]).trim());
    assert_eq!(git(&clone, &["rev-parse", "refs/remotes/origin/main"]), git(&mac, &["rev-parse", "origin/main"]));
    let ns = plan::mac_namespace(&t.local.host_id);
    assert_eq!(git(&clone, &["rev-parse", &format!("{ns}heads/main")]), git(&mac, &["rev-parse", "main"]));
    // The clone's own folder sits on a branch nobody wants, with nothing checked out.
    assert_eq!(git(&clone, &["symbolic-ref", "HEAD"]).trim(), scripts::CLONE_ROOT_BRANCH);
    assert!(!clone.join("a.txt").exists());
    assert_eq!(git(&clone, &["config", "--get", "flightdeck.managed"]).trim(), "true");
    // The upload folder keeps what a re-run of the worktree step needs, until the launch ends.
    let left = w.home().join(format!(".cache/flightdeck/launch/{id}"));
    let mut kept: Vec<String> =
        std::fs::read_dir(&left).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
    kept.sort();
    assert_eq!(kept, ["stage.tar", "worktree.done"]);

    // The header says it all.
    let header = context_header("Test box", &facts, &t, &c, &wt);
    assert!(header.contains(&wt.worktree), "{header}");
    assert!(header.contains("`.env`"), "{header}");
    assert!(header.contains("`node_modules/`"), "{header}");

    cleanup(&ctx, &id, None).await.expect("cleanup");
    assert!(!left.exists());
}

#[tokio::test]
async fn a_second_launch_reuses_the_clone_and_never_shares_a_checked_out_branch() {
    let w = World::new("reuse");
    w.write("a.txt", b"one\n");
    w.commit("first");
    git(&w.mac(), &["push", "-q", "-u", "origin", "main"]);
    let m = machine();
    let bin = w.bin();
    let ctx = Ctx { machine: &m, known_hosts: None, ssh_bin: Some(&bin) };
    let (_, t1, _, w1) = launch(&ctx, &w, &uuid::Uuid::new_v4().to_string()).await;
    assert_eq!(w1.branch.as_deref(), Some("main"));

    w.write("c.txt", b"later\n");
    w.commit("third");
    let id2 = uuid::Uuid::new_v4().to_string();
    let (_, t2, c2, w2) = launch(&ctx, &w, &id2).await;
    assert!(!t2.created, "the clone is found again by its origin");
    assert_eq!(t2.clone, t1.clone);
    assert!(t2.bundle_bytes > 0, "the new commit is sent");
    assert!(c2.stage.is_none(), "nothing uncommitted");
    // `main` is checked out by the first worktree: the second gets its own branch.
    assert_eq!(w2.branch.as_deref(), Some("main-2"));
    assert_eq!(w2.worktree, format!("{}/.claude/worktrees/main-2", t2.clone));
    let srv = PathBuf::from(&w2.worktree);
    assert_eq!(git(&srv, &["rev-parse", "HEAD"]), git(&w.mac(), &["rev-parse", "HEAD"]));
    // The first worktree's branch was left where it was.
    assert_eq!(git(&PathBuf::from(&w1.worktree), &["rev-parse", "HEAD"]).trim(), t1.local.commit);

    // Abandoning the second launch removes its worktree and the branch it created.
    cleanup(&ctx, &id2, Some((&t2.clone, &w2))).await.expect("discard");
    assert!(!srv.exists());
    let heads = git(&PathBuf::from(&t2.clone), &["for-each-ref", "--format=%(refname)", "refs/heads"]);
    assert!(!heads.contains("main-2"), "{heads}");
    assert!(heads.contains("refs/heads/main"), "{heads}");
}

#[tokio::test]
async fn the_copy_refuses_a_repository_that_moved_on_since_the_transfer() {
    let w = World::new("moved");
    w.write("a.txt", b"one\n");
    w.commit("first");
    let m = machine();
    let bin = w.bin();
    let ctx = Ctx { machine: &m, known_hosts: None, ssh_bin: Some(&bin) };
    let id = uuid::Uuid::new_v4().to_string();
    let cancel = Cancel::new();
    check(&ctx).await.unwrap();
    let t = transfer(&ctx, &id, &w.mac().to_string_lossy(), MAC_ID, &w.tmp(), &no_progress, &cancel).await.unwrap();
    w.write("a.txt", b"two\n");
    w.commit("meanwhile");
    let e = copy(&ctx, &id, &t.local, &w.tmp(), &no_progress, &cancel).await.unwrap_err();
    assert!(e.contains("moved on"), "{e}");
}

#[tokio::test]
async fn a_repository_without_origin_is_launched_and_found_again_by_its_marker() {
    let w = World::new("noorigin");
    git(&w.mac(), &["remote", "remove", "origin"]);
    w.write("a.txt", b"one\n");
    w.commit("first");
    let m = machine();
    let bin = w.bin();
    let ctx = Ctx { machine: &m, known_hosts: None, ssh_bin: Some(&bin) };
    let (_, t1, _, _) = launch(&ctx, &w, &uuid::Uuid::new_v4().to_string()).await;
    assert!(t1.created);
    assert!(t1.clone.ends_with("/flightdeck/repos/mac"), "named after the folder: {}", t1.clone);
    let (_, t2, _, _) = launch(&ctx, &w, &uuid::Uuid::new_v4().to_string()).await;
    assert!(!t2.created);
    assert_eq!(t2.clone, t1.clone);
}

#[tokio::test]
async fn a_failed_worktree_step_leaves_nothing_behind_and_can_be_retried() {
    let w = World::new("rollback");
    w.write("a.txt", b"one\n");
    w.commit("first");
    let first = git(&w.mac(), &["rev-parse", "HEAD"]).trim().to_string();
    w.write("a.txt", b"one-b\n");
    w.commit("second");
    w.write("a.txt", b"two\n");
    let m = machine();
    let bin = w.bin();
    let ctx = Ctx { machine: &m, known_hosts: None, ssh_bin: Some(&bin) };
    let id = uuid::Uuid::new_v4().to_string();
    let cancel = Cancel::new();
    check(&ctx).await.unwrap();
    let t = transfer(&ctx, &id, &w.mac().to_string_lossy(), MAC_ID, &w.tmp(), &no_progress, &cancel).await.unwrap();
    let c = copy(&ctx, &id, &t.local, &w.tmp(), &no_progress, &cancel).await.unwrap();
    // A worktree made at the wrong commit: the unstaged patch (against "one-b") cannot apply.
    let clone = PathBuf::from(&t.clone);
    let broken = TransferOutcome { local: LocalState { commit: first, ..t.local.clone() }, ..t.clone() };
    let e = worktree(&ctx, &id, &broken, &c).await.unwrap_err();
    assert!(e.contains("unstaged changes do not apply"), "{e}");
    assert!(!clone.join(".claude/worktrees/main").exists(), "rolled back");
    let heads = git(&clone, &["for-each-ref", "--format=%(refname)", "refs/heads/main"]);
    assert!(heads.trim().is_empty(), "the branch it created is gone: {heads}");
    // The staged archive survived the failure: the retry needs no new upload.
    let wt = worktree(&ctx, &id, &t, &c).await.expect("retry");
    assert_eq!(std::fs::read_to_string(PathBuf::from(&wt.worktree).join("a.txt")).unwrap(), "two\n");
    // Run again (its answer lost on the way back): the same worktree, not a second one.
    let again = worktree(&ctx, &id, &t, &c).await.expect("idempotent");
    assert_eq!(again, wt);
    let dirs = std::fs::read_dir(clone.join(".claude/worktrees")).unwrap().count();
    assert_eq!(dirs, 1);
}

#[tokio::test]
async fn a_monorepo_subfolder_keeps_its_place_in_the_worktree() {
    let w = World::new("subdir");
    w.write(".gitignore", b".env\n");
    w.write("pkg/api/main.rs", b"fn main() {}\n");
    w.write("README.md", b"root\n");
    w.commit("first");
    w.write("pkg/api/.env", b"PKG=1\n");
    w.write("pkg/api/new.rs", b"// new\n");
    w.write("pkg/api/main.rs", b"fn main() { run() }\n");
    let m = machine();
    let bin = w.bin();
    let ctx = Ctx { machine: &m, known_hosts: None, ssh_bin: Some(&bin) };
    let id = uuid::Uuid::new_v4().to_string();
    let cancel = Cancel::new();
    check(&ctx).await.unwrap();
    let sub = w.mac().join("pkg/api");
    let t = transfer(&ctx, &id, &sub.to_string_lossy(), MAC_ID, &w.tmp(), &no_progress, &cancel).await.unwrap();
    assert_eq!(t.local.subdir, "pkg/api");
    let c = copy(&ctx, &id, &t.local, &w.tmp(), &no_progress, &cancel).await.unwrap();
    let wt = worktree(&ctx, &id, &t, &c).await.unwrap();
    assert_eq!(wt.cwd, format!("{}/pkg/api", wt.worktree));
    let srv = PathBuf::from(&wt.worktree);
    // Where they belong, not at the root.
    assert_eq!(std::fs::read_to_string(srv.join("pkg/api/.env")).unwrap(), "PKG=1\n");
    assert!(srv.join("pkg/api/new.rs").is_file());
    assert!(!srv.join(".env").exists() && !srv.join("new.rs").exists());
    assert_eq!(std::fs::read_to_string(srv.join("pkg/api/main.rs")).unwrap(), "fn main() { run() }\n");
}

#[tokio::test]
async fn a_branch_renamed_into_a_folder_does_not_block_the_next_transfer() {
    let w = World::new("dfconflict");
    w.write("a.txt", b"one\n");
    w.commit("first");
    git(&w.mac(), &["branch", "fix"]);
    let m = machine();
    let bin = w.bin();
    let ctx = Ctx { machine: &m, known_hosts: None, ssh_bin: Some(&bin) };
    let cancel = Cancel::new();
    check(&ctx).await.unwrap();
    let mac = w.mac().to_string_lossy().into_owned();
    transfer(&ctx, &uuid::Uuid::new_v4().to_string(), &mac, MAC_ID, &w.tmp(), &no_progress, &cancel).await.unwrap();
    // `fix` becomes `fix/x`: one transaction deleting `fix` and creating `fix/x` is refused.
    git(&w.mac(), &["branch", "-m", "fix", "fix/x"]);
    let t = transfer(&ctx, &uuid::Uuid::new_v4().to_string(), &mac, MAC_ID, &w.tmp(), &no_progress, &cancel)
        .await
        .expect("the stale ref is deleted first");
    let ns = plan::mac_namespace(&t.local.host_id);
    let refs = git(&PathBuf::from(&t.clone), &["for-each-ref", "--format=%(refname)", &ns]);
    assert!(refs.contains(&format!("{ns}heads/fix/x")) && !refs.lines().any(|r| r == format!("{ns}heads/fix")), "{refs}");
}

#[tokio::test]
async fn a_cancelled_upload_stops_at_once() {
    let w = World::new("cancel");
    // A server that never reads what it is sent.
    std::fs::write(w.bin().join("ssh"), "#!/bin/sh\nexec sleep 30\n").unwrap();
    let big = w.tmp().join("big");
    std::fs::write(&big, vec![7u8; 8 * 1024 * 1024]).unwrap();
    let m = machine();
    let cancel = Cancel::new();
    let c2 = cancel.clone();
    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        c2.cancel();
    });
    let started = std::time::Instant::now();
    let bin = w.bin();
    let r = stream::send_file(&m, None, "cat > /dev/null", &big, 8 * 1024 * 1024, &no_progress, &cancel, Some(&bin)).await;
    assert_eq!(r.err(), Some(SendError::Cancelled));
    assert!(started.elapsed() < std::time::Duration::from_secs(5));
}

/// The same launch against the real test box (`josty@josty-cc`, see the project memory):
/// a repository with commits not pushed, staged and unstaged changes, a binary file, a
/// `.env` and project skills, checked byte for byte over ssh afterwards.
///
/// `FD_LIVE_HOST=josty-cc FD_LIVE_USER=josty FD_LIVE_KEY=~/.ssh/flightdeck_box_ed25519 \
///  cargo test --lib live_launch_on_the_test_box -- --ignored --nocapture`
#[tokio::test]
#[ignore]
async fn live_launch_on_the_test_box() {
    let host = std::env::var("FD_LIVE_HOST").unwrap_or_else(|_| "josty-cc".into());
    let user = std::env::var("FD_LIVE_USER").unwrap_or_else(|_| "josty".into());
    let key = std::env::var("FD_LIVE_KEY").unwrap_or_else(|_| {
        format!("{}/.ssh/flightdeck_box_ed25519", std::env::var("HOME").unwrap())
    });
    let m = MachineRecord { host: host.clone(), user: user.clone(), identity_file: Some(key.clone()), ..machine() };
    let w = World::new("live");
    dirty_repository(&w);
    let ctx = Ctx { machine: &m, known_hosts: None, ssh_bin: None };
    let id = uuid::Uuid::new_v4().to_string();
    let (facts, t, c, wt) = launch(&ctx, &w, &id).await;
    println!("facts: {facts:?}\nclone: {} (created {}), bundle {} B", t.clone, t.created, t.bundle_bytes);
    println!("worktree: {wt:?}\ncopied: {:?}", c.copied.iter().map(|f| &f.path).collect::<Vec<_>>());
    println!("{}", context_header(&host, &facts, &t, &c, &wt));

    // Read the state back over ssh and compare with this Mac's.
    let remote = |cmd: &str| -> String {
        let out = Command::new("ssh")
            .args(["-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes", "-i", &key])
            .arg(format!("{user}@{host}"))
            .arg(format!("cd {} && {cmd}", crate::ipc::commands::shq(&wt.worktree)))
            .output()
            .unwrap();
        assert!(out.status.success(), "{cmd}: {}", String::from_utf8_lossy(&out.stderr));
        String::from_utf8_lossy(&out.stdout).into_owned()
    };
    let mac = w.mac();
    assert_eq!(remote("git rev-parse HEAD"), git(&mac, &["rev-parse", "HEAD"]));
    assert_eq!(remote("git ls-files -s"), git(&mac, &["ls-files", "-s"]));
    assert_eq!(remote("git status --porcelain"), git(&mac, &["status", "--porcelain"]));
    assert_eq!(remote("cat a.txt"), "three\n");
    assert_eq!(remote("od -An -tx1 logo.bin").split_whitespace().collect::<Vec<_>>(), ["09", "08", "07", "00", "00", "ff"]);
    assert_eq!(remote("cat .env"), "API_KEY=secret\n");
    assert_eq!(remote("cat .claude/skills/deploy/SKILL.md"), "# deploy\n");
    assert_eq!(remote("cat notes.md"), "todo\n");
    assert_eq!(remote("test -e node_modules && echo yes || echo no").trim(), "no");
    assert_eq!(remote("test -e debug.log && echo yes || echo no").trim(), "no");

    // Abandon it: worktree and branch removed, the clone stays (a cache).
    cleanup(&ctx, &id, Some((&t.clone, &wt))).await.expect("cleanup");
}

/// The last step, live: the conversation started in the launched worktree through the real
/// `flightdeckd attach`, with the context header as the app sends it — and the agent knows
/// where it runs. Same box and env as [`live_launch_on_the_test_box`].
#[tokio::test]
#[ignore]
async fn live_conversation_knows_it_runs_on_the_server() {
    use crate::supervisor::protocol::CliMessage;
    use crate::supervisor::transport::{RemoteTarget, SpawnConfig, Transport};
    let host = std::env::var("FD_LIVE_HOST").unwrap_or_else(|_| "josty-cc".into());
    let user = std::env::var("FD_LIVE_USER").unwrap_or_else(|_| "josty".into());
    let key = std::env::var("FD_LIVE_KEY").unwrap_or_else(|_| {
        format!("{}/.ssh/flightdeck_box_ed25519", std::env::var("HOME").unwrap())
    });
    let m = MachineRecord { host: host.clone(), user: user.clone(), identity_file: Some(key.clone()), ..machine() };
    let w = World::new("live-agent");
    dirty_repository(&w);
    let ctx = Ctx { machine: &m, known_hosts: None, ssh_bin: None };
    let id = uuid::Uuid::new_v4().to_string();
    let (facts, t, c, wt) = launch(&ctx, &w, &id).await;
    let header = context_header(&host, &facts, &t, &c, &wt);

    let mut cfg = SpawnConfig::new(&wt.worktree);
    cfg.model = Some("haiku".into());
    cfg.permission_mode = Some("default".into());
    cfg.append_system_prompt = Some(header);
    cfg.remote = Some(RemoteTarget {
        host: host.clone(),
        port: 22,
        user: user.clone(),
        identity_file: Some(key.clone()),
        known_hosts_file: None,
        daemon_bin: "flightdeckd".into(),
        addresses: vec![host.clone()],
        machine_id: None,
    });
    let (mut transport, mut rx) = Transport::spawn(cfg).expect("remote spawn");
    transport
        .send_user_text(
            "Without using any tool: on which server, as which user, and in which directory do you run, and on \
             which branch was this working tree transferred? One line.",
        )
        .unwrap();
    let mut reply = String::new();
    let mut conversation = None;
    tokio::time::timeout(std::time::Duration::from_secs(180), async {
        while let Some(msg) = rx.recv().await {
            match msg {
                CliMessage::FdAttach(a) => conversation = Some(a.conversation.clone()),
                CliMessage::Assistant(a) => reply.push_str(&a.message.to_string()),
                CliMessage::Result(_) => break,
                _ => {}
            }
        }
    })
    .await
    .expect("the remote turn should finish");
    println!("reply: {reply}");
    // Stop the daemon's claude, then remove the worktree.
    transport.shutdown(true).await;
    if let Some(conv) = conversation {
        let _ = crate::supervisor::transport::run_remote_stop(
            &RemoteTarget {
                host: host.clone(),
                port: 22,
                user: user.clone(),
                identity_file: Some(key.clone()),
                known_hosts_file: None,
                daemon_bin: "flightdeckd".into(),
                addresses: vec![host.clone()],
                machine_id: None,
            },
            &conv,
        )
        .await;
    }
    cleanup(&ctx, &id, Some((&t.clone, &wt))).await.expect("cleanup");
    let lower = reply.to_lowercase();
    assert!(lower.contains(&host.to_lowercase()), "the agent names the server: {reply}");
    assert!(reply.contains(&wt.worktree) || reply.contains(".claude/worktrees/main"), "and its directory: {reply}");
    assert!(lower.contains("main"), "and the branch: {reply}");
}
