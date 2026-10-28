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

/// A scratch tree: a bare "origin", this Mac's clone of it, a fake server home, and the
/// fake `ssh` that runs remote commands under that home.
struct World {
    root: PathBuf,
}

impl World {
    fn new(tag: &str) -> Self {
        let root = std::env::temp_dir().join(format!("fd-launch-{tag}-{}", uuid::Uuid::new_v4()));
        for d in ["origin.git", "mac", "home", "bin", "tmp"] {
            std::fs::create_dir_all(root.join(d)).unwrap();
        }
        let w = World { root };
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

/// The full pipeline, as the IPC layer drives it.
async fn launch(
    ctx: &Ctx<'_>,
    w: &World,
    id: &str,
) -> (ServerFacts, TransferOutcome, CopyOutcome, WorktreeOutcome) {
    let cancel = Cancel::new();
    let mac = w.mac().to_string_lossy().into_owned();
    let facts = check(ctx).await.expect("check");
    let t = transfer(ctx, id, &mac, &w.tmp(), &no_progress, &cancel).await.expect("transfer");
    let c = copy(ctx, id, &t.local, &w.tmp(), &no_progress, &cancel).await.expect("copy");
    let wt = worktree(ctx, &t, c.stage.as_deref()).await.expect("worktree");
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
    assert!(!facts.aligned);
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
    // Same commit, same staged and unstaged changes.
    assert_eq!(git(&srv, &["rev-parse", "HEAD"]), git(&mac, &["rev-parse", "HEAD"]));
    assert_eq!(git(&srv, &["diff", "--cached", "--binary"]), git(&mac, &["diff", "--cached", "--binary"]));
    assert_eq!(git(&srv, &["diff", "--binary"]), git(&mac, &["diff", "--binary"]));
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
    assert_eq!(git(&clone, &["rev-parse", "refs/flightdeck/mac/heads/main"]), git(&mac, &["rev-parse", "main"]));
    assert_eq!(git(&clone, &["config", "--get", "flightdeck.managed"]).trim(), "true");
    // Nothing left in the upload folder.
    let left = w.home().join(format!(".cache/flightdeck/launch/{id}"));
    assert!(std::fs::read_dir(&left).map(|d| d.count()).unwrap_or(0) == 0, "leftovers in {}", left.display());

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
    let t = transfer(&ctx, &id, &w.mac().to_string_lossy(), &w.tmp(), &no_progress, &cancel).await.unwrap();
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
    let t = transfer(&ctx, &id, &w.mac().to_string_lossy(), &w.tmp(), &no_progress, &cancel).await.unwrap();
    let c = copy(&ctx, &id, &t.local, &w.tmp(), &no_progress, &cancel).await.unwrap();
    // A worktree made at the wrong commit: the unstaged patch (against "one-b") cannot apply.
    let clone = PathBuf::from(&t.clone);
    let broken = TransferOutcome { local: LocalState { commit: first, ..t.local.clone() }, ..t.clone() };
    let e = worktree(&ctx, &broken, c.stage.as_deref()).await.unwrap_err();
    assert!(e.contains("unstaged changes do not apply"), "{e}");
    assert!(!clone.join(".claude/worktrees/main").exists(), "rolled back");
    let heads = git(&clone, &["for-each-ref", "--format=%(refname)", "refs/heads/main"]);
    assert!(heads.trim().is_empty(), "the branch it created is gone: {heads}");
    // The staged archive survived the failure: the retry needs no new upload.
    let wt = worktree(&ctx, &t, c.stage.as_deref()).await.expect("retry");
    assert_eq!(std::fs::read_to_string(PathBuf::from(&wt.worktree).join("a.txt")).unwrap(), "two\n");
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
    assert_eq!(remote("git diff --cached --binary"), git(&mac, &["diff", "--cached", "--binary"]));
    assert_eq!(remote("git diff --binary"), git(&mac, &["diff", "--binary"]));
    assert_eq!(remote("od -An -tx1 logo.bin").split_whitespace().collect::<Vec<_>>(), ["09", "08", "07", "00", "00", "ff"]);
    assert_eq!(remote("cat .env"), "API_KEY=secret\n");
    assert_eq!(remote("cat .claude/skills/deploy/SKILL.md"), "# deploy\n");
    assert_eq!(remote("cat notes.md"), "todo\n");
    assert_eq!(remote("test -e node_modules && echo yes || echo no").trim(), "no");
    assert_eq!(remote("test -e debug.log && echo yes || echo no").trim(), "no");

    // Abandon it: worktree and branch removed, the clone stays (a cache).
    cleanup(&ctx, &id, Some((&t.clone, &wt))).await.expect("cleanup");
}
