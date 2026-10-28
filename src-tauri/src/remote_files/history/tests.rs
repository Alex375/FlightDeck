use super::*;
use crate::store::MachineRecord;
use crate::supervisor::history::{index_one, scan_disk_conversation, score_index};
use serde_json::json;
use std::path::{Path, PathBuf};

const SID_A: &str = "aaaaaaaa-0000-4000-8000-000000000001";
const SID_B: &str = "bbbbbbbb-0000-4000-8000-000000000002";
const SID_NOISE: &str = "cccccccc-0000-4000-8000-000000000003";

fn machine() -> MachineRecord {
    MachineRecord {
        id: "m-hist".into(),
        label: "Target".into(),
        host: "target.example".into(),
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

/// A scratch dir unique to one test.
fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("fd-remote-history-{name}-{}", std::process::id()));
    std::fs::remove_dir_all(&dir).ok();
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// A fake `ssh` that ignores its connection arguments and runs the script it is fed with THIS
/// Mac's `sh -s`, `config` as the remote `$CLAUDE_CONFIG_DIR` — so the real script runs end to
/// end against a scratch "server" tree.
fn fake_ssh(dir: &Path, config: &Path) -> PathBuf {
    use std::os::unix::fs::PermissionsExt as _;
    let bin = dir.join("ssh");
    std::fs::write(
        &bin,
        format!(
            "#!/bin/sh\nCLAUDE_CONFIG_DIR={}\nexport CLAUDE_CONFIG_DIR\nexec /bin/sh -s\n",
            shq(&config.to_string_lossy())
        ),
    )
    .unwrap();
    std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
    bin
}

/// Point every keyed ssh on this test's thread at `bin` for its lifetime.
struct SshSeam;
impl SshSeam {
    fn install(bin: &Path) -> Self {
        crate::ipc::commands::TEST_SSH_BIN.with(|b| *b.borrow_mut() = Some(bin.to_string_lossy().into_owned()));
        SshSeam
    }
}
impl Drop for SshSeam {
    fn drop(&mut self) {
        crate::ipc::commands::TEST_SSH_BIN.with(|b| *b.borrow_mut() = None);
    }
}

fn is_root() -> bool {
    String::from_utf8(std::process::Command::new("id").arg("-u").output().unwrap().stdout).unwrap().trim() == "0"
}

// ---- transcript lines, as the CLI writes them ----

fn user(text: &str) -> String {
    json!({"parentUuid": null, "isSidechain": false, "type": "user",
           "message": {"role": "user", "content": text},
           "uuid": "u1", "cwd": "/srv/proj", "gitBranch": "main", "sessionId": SID_A})
    .to_string()
}

fn user_blocks(blocks: serde_json::Value) -> String {
    json!({"isSidechain": false, "type": "user", "message": {"role": "user", "content": blocks},
           "cwd": "/srv/proj", "sessionId": SID_A})
    .to_string()
}

fn assistant_text(text: &str) -> String {
    json!({"isSidechain": false, "type": "assistant",
           "message": {"role": "assistant", "content": [{"type": "text", "text": text}]},
           "cwd": "/srv/proj"})
    .to_string()
}

fn tool_use() -> String {
    json!({"isSidechain": false, "type": "assistant",
           "message": {"role": "assistant", "content": [{"type": "tool_use", "id": "t1", "name": "Write",
               "input": {"file_path": "/srv/proj/x", "content": "SECRETTOOLINPUT"}}]}})
    .to_string()
}

fn tool_result() -> String {
    user_blocks(json!([{"type": "tool_result", "tool_use_id": "t1",
                        "content": [{"type": "text", "text": "SECRETTOOLOUTPUT"}]}]))
}

fn thinking() -> String {
    json!({"isSidechain": false, "type": "assistant",
           "message": {"role": "assistant", "content": [{"type": "thinking", "thinking": "SECRETTHOUGHT"}]}})
    .to_string()
}

fn ai_title(t: &str) -> String {
    json!({"type": "ai-title", "aiTitle": t, "sessionId": SID_A}).to_string()
}

/// A realistic transcript: everything the pre-filter must drop around what it must keep.
fn rich_transcript() -> String {
    let lines = [
        json!({"type": "queue-operation", "operation": "enqueue"}).to_string(),
        user("Déploie le service d'authentification"),
        json!({"type": "attachment", "isSidechain": false, "attachment": {"type": "skill_listing", "content": "SECRETATTACHMENT"}, "cwd": "/srv/proj"}).to_string(),
        thinking(),
        assistant_text("Je regarde le dépôt."),
        tool_use(),
        tool_result(),
        ai_title("Auth deployment"),
        json!({"isSidechain": true, "type": "user", "message": {"role": "user", "content": "SECRETSIDECHAIN"}}).to_string(),
        json!({"isSidechain": false, "isMeta": true, "type": "user", "message": {"role": "user", "content": "SECRETSKILLBODY"}}).to_string(),
        user_blocks(json!([
            {"type": "text", "text": "voici la capture"},
            {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": "iVBORw0KGgo".repeat(2000)}}
        ])),
        assistant_text("Déployé sur staging."),
        "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"partial".to_string(),
    ];
    lines.join("\n")
}

/// `<config>/projects/<slug>/<sid>.jsonl`, with `content`.
fn write_transcript(config: &Path, slug: &str, sid: &str, content: &str) -> PathBuf {
    let dir = config.join("projects").join(slug);
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join(format!("{sid}.jsonl"));
    std::fs::write(&path, content).unwrap();
    path
}

fn set_mtime(path: &Path, secs: u64) {
    let f = std::fs::OpenOptions::new().write(true).open(path).unwrap();
    f.set_modified(std::time::UNIX_EPOCH + Duration::from_secs(secs)).unwrap();
}

/// Run one round of the real script and return its raw answer.
async fn raw_round(server: &Server<'_>, known: &[String], limits: &ScanLimits) -> String {
    let raw = run_script(server, &scan_script(known, limits), SCAN_TIMEOUT, false, 64 * 1024 * 1024)
        .await
        .unwrap();
    String::from_utf8(raw).unwrap()
}

// ---- the answer ----

#[test]
fn the_answer_parses_every_status_and_skips_login_noise() {
    let rel_a = format!("-srv-proj/{SID_A}.jsonl");
    let rel_b = format!("-srv-proj/{SID_B}.jsonl");
    let raw = format!(
        "Welcome to the box!\nFDHIST1 begin\nFDHIST1 count 3\nFDHIST1 same 10 20 {rel_b}\n\
         FDHIST1 file 30 40 {rel_a}\n{{\"a\":1}}\nnot json is ignored\n{{\"b\":2}}\nFDHIST1 done {rel_a}\n\
         FDHIST1 unreadable 1 2 -srv-proj/{SID_NOISE}.jsonl permission denied\nFDHIST1 end\n"
    );
    let a = parse_scan(raw.as_bytes()).unwrap();
    assert_eq!(a.count, Some(3));
    assert_eq!(a.end, ScanEnd::Complete);
    assert_eq!(a.skipped, 0);
    assert_eq!(
        a.items,
        vec![
            ScanItem::Same { rel: rel_b },
            ScanItem::File { size: 30, mtime_s: 40, rel: rel_a, lines: "{\"a\":1}\n{\"b\":2}\n".into() },
            ScanItem::Unreadable { rel: format!("-srv-proj/{SID_NOISE}.jsonl"), reason: "permission denied".into() },
        ]
    );
}

#[test]
fn an_incomplete_block_or_a_foreign_name_is_never_listed() {
    let rel_a = format!("-srv-proj/{SID_A}.jsonl");
    // A block interrupted by another header, a block whose `done` names another file, a name no
    // CLI writes, and an answer that stops mid-block (the link, a size refusal).
    let raw = format!(
        "FDHIST1 begin\nFDHIST1 file 1 1 {rel_a}\n{{}}\nFDHIST1 same 1 1 {rel_a}\n\
         FDHIST1 file 1 1 {rel_a}\n{{}}\nFDHIST1 done -srv-proj/{SID_B}.jsonl\n\
         FDHIST1 same 1 1 ../../etc/passwd.jsonl\nFDHIST1 same 1 1 -srv-proj/notes.txt\n\
         FDHIST1 file 1 1 {rel_a}\n{{}}\n"
    );
    let a = parse_scan(raw.as_bytes()).unwrap();
    assert_eq!(a.end, ScanEnd::Cut);
    assert_eq!(a.items, vec![ScanItem::Same { rel: rel_a }]);
    assert_eq!(a.skipped, 5);
    assert_eq!(parse_scan(b"FDHIST1 begin\nFDHIST1 more\n").unwrap().end, ScanEnd::More);
}

#[test]
fn what_is_not_a_listing_is_an_error() {
    assert!(parse_scan(b"").is_err());
    assert!(parse_scan(b"bash: sh: command not found\n").is_err());
    assert_eq!(
        parse_scan(b"FDHIST1 begin\nFDHIST1 error cannot read /h/.claude/projects\n").unwrap_err(),
        "cannot read /h/.claude/projects"
    );
    assert!(parse_scan(b"FDHIST1 begin\nFDHIST1 maybe\n").is_err());
    // A content line that looks like a header before `begin` is login noise, not an answer.
    assert!(parse_scan(b"FDHIST1 end\n").is_err());
}

#[test]
fn names_must_be_a_slug_and_a_session_id() {
    assert_eq!(session_of_rel(&format!("-home-josty-Documents/{SID_A}.jsonl")), Some(SID_A));
    for bad in [
        format!("{SID_A}.jsonl"),
        format!("a/b/{SID_A}.jsonl"),
        format!("../{SID_A}.jsonl"),
        format!("-srv/{SID_A}.json"),
        "-srv/a b.jsonl".to_string(),
        "-srv/notes.jsonl".to_string(),
        format!("-srv/{}.jsonl", SID_A.replace('-', "_")),
        "-srv/.jsonl".to_string(),
    ] {
        assert_eq!(session_of_rel(&bad), None, "{bad}");
    }
}

// ---- the cache ----

fn file(sid: &str, size: u64, mtime_s: i64, lines: &str) -> ScanItem {
    ScanItem::File { size, mtime_s, rel: format!("-srv-proj/{sid}.jsonl"), lines: lines.to_string() }
}

fn complete(items: Vec<ScanItem>) -> ScanAnswer {
    ScanAnswer { count: Some(items.len() as u64), items, end: ScanEnd::Complete, skipped: 0 }
}

#[test]
fn the_cache_keeps_what_did_not_change_and_prunes_only_on_a_complete_round() {
    let mut state = ScanState::default();
    let a = format!("{}\n{}\n", user("first prompt"), assistant_text("reply"));
    let b = format!("{}\n", user("other prompt"));
    let s = state.apply(complete(vec![file(SID_A, 10, 100, &a), file(SID_B, 20, 200, &b)]), "m");
    assert_eq!(s, RoundSummary { end: ScanEnd::Complete, completed: 2, pending: 0 });
    assert_eq!(
        state.known(),
        vec![format!("10 100 -srv-proj/{SID_A}.jsonl"), format!("20 200 -srv-proj/{SID_B}.jsonl")]
    );

    // A round cut by its budget that only reached B: A is NOT pruned (the rest is unknown).
    let cut = ScanAnswer {
        count: Some(2),
        items: vec![ScanItem::Same { rel: format!("-srv-proj/{SID_B}.jsonl") }],
        end: ScanEnd::More,
        skipped: 0,
    };
    assert_eq!(state.apply(cut, "m").pending, 1);
    assert_eq!(state.publish().rows.len(), 2);

    // A complete round that no longer lists A: it is gone on the server, gone here.
    state.apply(complete(vec![ScanItem::Same { rel: format!("-srv-proj/{SID_B}.jsonl") }]), "m");
    let p = state.publish();
    assert_eq!(p.rows.iter().map(|r| r.session_id.as_str()).collect::<Vec<_>>(), vec![SID_B]);

    // A changed transcript replaces its row.
    let b2 = format!("{}\n", user("edited prompt"));
    state.apply(complete(vec![file(SID_B, 21, 201, &b2)]), "m");
    let p = state.publish();
    assert_eq!(p.rows[0].excerpt, "edited prompt");
    assert_eq!(p.rows[0].mtime_ms, 201_000);
}

#[test]
fn unreadable_transcripts_are_counted_until_they_read_again() {
    let mut state = ScanState::default();
    let rel = format!("-srv-proj/{SID_A}.jsonl");
    state.apply(complete(vec![ScanItem::Unreadable { rel: rel.clone(), reason: "permission denied".into() }]), "m");
    assert_eq!(state.publish().unreadable, 1);
    assert!(state.known().is_empty(), "an unreadable transcript is asked for again");
    state.apply(complete(vec![file(SID_A, 1, 1, &user("now readable"))]), "m");
    let p = state.publish();
    assert_eq!((p.unreadable, p.rows.len()), (0, 1));
    // Gone from the server: no longer counted either.
    state.apply(complete(vec![ScanItem::Unreadable { rel, reason: "x".into() }]), "m");
    state.apply(complete(vec![]), "m");
    assert_eq!(state.publish().unreadable, 0);
}

#[test]
fn rows_are_stamped_deduplicated_by_session_and_most_recent_first() {
    let mut state = ScanState::default();
    let lines = |t: &str| format!("{}\n{}\n", user(t), ai_title(&format!("title {t}")));
    state.apply(
        complete(vec![
            file(SID_A, 1, 300, &lines("old")),
            // The same session under another slug (its cwd moved), written later: that one wins.
            ScanItem::File { size: 1, mtime_s: 500, rel: format!("-srv-moved/{SID_A}.jsonl"), lines: lines("new") },
            file(SID_B, 1, 400, &lines("b")),
            // No human message: known, never listed.
            file(SID_NOISE, 1, 900, &format!("{}\n", assistant_text("hello?"))),
        ]),
        "m-1",
    );
    let p = state.publish();
    let got: Vec<(&str, &str, i64)> = p.rows.iter().map(|r| (r.session_id.as_str(), r.excerpt.as_str(), r.mtime_ms)).collect();
    assert_eq!(got, vec![(SID_A, "new", 500_000), (SID_B, "b", 400_000)]);
    assert!(p.rows.iter().all(|r| r.machine_id.as_deref() == Some("m-1") && r.backend == "claude"));
    assert_eq!(p.index.len(), 2);
    let hits = score_index(p.index(), "new");
    assert_eq!(hits.len(), 1);
    assert_eq!((hits[0].session_id.as_str(), hits[0].machine_id.as_deref()), (SID_A, Some("m-1")));
    assert_eq!(state.known().len(), 4, "the noise transcript is known too: not re-shipped");
}

#[test]
fn the_script_quotes_what_it_is_given() {
    let known = vec![format!("12 34 -srv-proj/{SID_A}.jsonl")];
    let s = scan_script(&known, &ScanLimits::default());
    assert!(s.contains(&format!("<<'FDKNOWN'\n#\n12 34 -srv-proj/{SID_A}.jsonl\nFDKNOWN\n")), "{s}");
    assert!(scan_script(&[], &ScanLimits::default()).contains("<<'FDKNOWN'\n#\nFDKNOWN\n"));
    // The awk program travels single-quoted, whole.
    assert!(s.contains(&format!("AWK={}\n", shq(FILTER_AWK))));
}

// ---- end to end through the fake ssh ----

#[tokio::test]
async fn the_real_script_lists_and_prefilters_on_the_server() {
    let dir = scratch("e2e");
    let config = dir.join("config");
    let a = write_transcript(&config, "-srv-proj", SID_A, &rich_transcript());
    write_transcript(&config, "-srv-proj", SID_NOISE, &format!("{}\n{}\n", tool_use(), thinking()));
    // Not conversations: a symbolic link, and a file no CLI names so.
    std::os::unix::fs::symlink(&a, config.join("projects/-srv-proj").join(format!("{SID_B}.jsonl"))).unwrap();
    write_transcript(&config, "-srv-proj", "notes", &user("not a session"));
    // A sub-agent's transcript one level deeper is never a conversation of its own.
    write_transcript(&config, &format!("-srv-proj/{SID_A}/subagents"), "agent-x", &user("SECRETSUBAGENT"));
    set_mtime(&a, 1_700_000_000);
    let _seam = SshSeam::install(&fake_ssh(&dir, &config));
    let m = machine();
    let server = Server { machine: &m, known_hosts: None };

    let raw = raw_round(&server, &[], &ScanLimits::default()).await;
    for secret in [
        "SECRETTOOLINPUT",
        "SECRETTOOLOUTPUT",
        "SECRETTHOUGHT",
        "SECRETATTACHMENT",
        "SECRETSIDECHAIN",
        "SECRETSKILLBODY",
        "SECRETSUBAGENT",
        "iVBORw0KGgo",
        "not a session",
    ] {
        assert!(!raw.contains(secret), "{secret} was shipped:\n{raw}");
    }
    assert!(raw.contains("FDHIST1 count 2\n"), "the two transcripts: no link, no misnamed file:\n{raw}");
    assert!(raw.ends_with("FDHIST1 end\n"), "{raw}");

    let cache = ServerHistoryCache::default();
    let listed = list_server_conversations(&server, &cache).await.unwrap();
    assert_eq!((listed.pending, listed.unreadable), (0, 0));
    assert_eq!(listed.conversations.len(), 1, "{:?}", listed.conversations);
    let row = &listed.conversations[0];
    assert_eq!(row.session_id, SID_A);
    assert_eq!(row.machine_id.as_deref(), Some("m-hist"));
    assert_eq!(row.title.as_deref(), Some("Auth deployment"));
    assert_eq!(row.excerpt, "Déploie le service d'authentification");
    assert_eq!((row.cwd.as_str(), row.git_branch.as_deref()), ("/srv/proj", Some("main")));
    assert_eq!(row.mtime_ms, 1_700_000_000_000);

    // Searchable exactly as this Mac's own reader indexes the same file.
    let published = cache.published(&["m-hist".to_string()]);
    let idx: Vec<&IndexedConversation> = published[0].index().collect();
    assert_eq!(idx[0].body(), index_one(&a).unwrap().body());
    assert_eq!(score_index(idx.iter().copied(), "deploye staging").len(), 1);
    assert_eq!(score_index(idx.iter().copied(), "capture").len(), 1, "an image's caption is searchable");
    assert!(cache.published(&["another".to_string()]).is_empty(), "an unpaired server is never searched");
    std::fs::remove_dir_all(&dir).ok();
}

#[tokio::test]
async fn a_second_listing_ships_only_what_changed_and_drops_what_is_gone() {
    let dir = scratch("incr");
    let config = dir.join("config");
    let a = write_transcript(&config, "-srv-proj", SID_A, &user("prompt a"));
    let b = write_transcript(&config, "-srv-other", SID_B, &user("prompt b"));
    set_mtime(&a, 1_700_000_100);
    set_mtime(&b, 1_700_000_000);
    let _seam = SshSeam::install(&fake_ssh(&dir, &config));
    let m = machine();
    let server = Server { machine: &m, known_hosts: None };
    let cache = ServerHistoryCache::default();
    let first = list_server_conversations(&server, &cache).await.unwrap();
    assert_eq!(first.conversations.iter().map(|r| r.session_id.as_str()).collect::<Vec<_>>(), vec![SID_A, SID_B]);

    // Nothing changed: every transcript answers `same`, none is shipped.
    let known = cache.entry("m-hist").scan.lock().await.known();
    let raw = raw_round(&server, &known, &ScanLimits::default()).await;
    assert_eq!(raw.matches("FDHIST1 same ").count(), 2, "{raw}");
    assert!(!raw.contains("FDHIST1 file "), "{raw}");

    // B is appended to and becomes the most recent; A is deleted.
    std::fs::write(&b, format!("{}\n{}\n", user("prompt b"), assistant_text("an answer to find"))).unwrap();
    set_mtime(&b, 1_700_000_200);
    let raw = raw_round(&server, &known, &ScanLimits::default()).await;
    assert_eq!(raw.matches("FDHIST1 file ").count(), 1, "{raw}");
    std::fs::remove_file(&a).unwrap();
    let again = list_server_conversations(&server, &cache).await.unwrap();
    assert_eq!(again.conversations.iter().map(|r| r.session_id.as_str()).collect::<Vec<_>>(), vec![SID_B]);
    let published = cache.published(&["m-hist".to_string()]);
    assert_eq!(score_index(published[0].index(), "answer").len(), 1);
    std::fs::remove_dir_all(&dir).ok();
}

#[tokio::test]
async fn a_listing_past_its_budget_goes_on_over_rounds_and_says_what_it_did_not_reach() {
    let dir = scratch("rounds");
    let config = dir.join("config");
    let sids: Vec<String> = (0..5).map(|i| format!("dddddddd-0000-4000-8000-00000000000{i}")).collect();
    for (i, sid) in sids.iter().enumerate() {
        let p = write_transcript(&config, "-srv-proj", sid, &format!("{}\n", user(&format!("prompt {i}"))));
        set_mtime(&p, 1_700_000_000 + i as u64);
    }
    let _seam = SshSeam::install(&fake_ssh(&dir, &config));
    let m = machine();
    let server = Server { machine: &m, known_hosts: None };
    // One transcript per round (any byte spent ends it).
    let tight = ScanLimits { round_max: 1, ..ScanLimits::default() };

    let short = ServerHistoryCache::default();
    let partial = list_server_conversations_with(&server, &short, &ScanLimits { max_rounds: 2, ..tight }).await.unwrap();
    assert_eq!(partial.conversations.len(), 2, "{:?}", partial.conversations);
    assert_eq!(partial.pending, 3);
    // Most recent first: the two newest made it.
    assert_eq!(partial.conversations[0].excerpt, "prompt 4");
    assert_eq!(partial.conversations[1].excerpt, "prompt 3");
    // The next listing goes on from there.
    let rest = list_server_conversations_with(&server, &short, &ScanLimits { max_rounds: 10, ..tight }).await.unwrap();
    assert_eq!((rest.conversations.len(), rest.pending), (5, 0));

    let full = list_server_conversations_with(&server, &ServerHistoryCache::default(), &ScanLimits { max_rounds: 10, ..tight })
        .await
        .unwrap();
    assert_eq!((full.conversations.len(), full.pending), (5, 0));
    std::fs::remove_dir_all(&dir).ok();
}

#[tokio::test]
async fn a_long_transcript_ships_its_budget_and_still_lists() {
    let dir = scratch("budget");
    let config = dir.join("config");
    // A huge first prompt (past the per-file budget, under the line cap), then lots of prose.
    let mut lines = vec![user(&format!("start {}", "x".repeat(40_000)))];
    lines.extend((0..200).map(|i| assistant_text(&format!("paragraph {i} {}", "y".repeat(1000)))));
    lines.push(user("the very last prompt"));
    let a = write_transcript(&config, "-srv-proj", SID_A, &lines.join("\n"));
    // A single line past the line cap is never shipped, the rest of its transcript is.
    let mut b_lines = vec![user(&"z".repeat(70_000)), user("second prompt")];
    b_lines.push(assistant_text("after the huge line"));
    write_transcript(&config, "-srv-proj", SID_B, &b_lines.join("\n"));
    let _seam = SshSeam::install(&fake_ssh(&dir, &config));
    let m = machine();
    let server = Server { machine: &m, known_hosts: None };
    let limits = ScanLimits { file_max: 64 * 1024, line_max: 64 * 1024, ..ScanLimits::default() };

    let raw = raw_round(&server, &[], &limits).await;
    let shipped = raw.split(&format!("FDHIST1 file ")).find(|b| b.contains(SID_A)).unwrap();
    assert!(shipped.len() < 64 * 1024 + 8 * 1024, "bounded by the per-file budget: {}", shipped.len());
    assert!(!raw.contains("the very last prompt"));

    let listed = list_server_conversations_with(&server, &ServerHistoryCache::default(), &limits).await.unwrap();
    let row_a = listed.conversations.iter().find(|r| r.session_id == SID_A).unwrap();
    assert!(row_a.excerpt.starts_with("start x"), "{}", row_a.excerpt);
    let row_b = listed.conversations.iter().find(|r| r.session_id == SID_B).unwrap();
    assert_eq!(row_b.excerpt, "second prompt");
    let _ = a;
    std::fs::remove_dir_all(&dir).ok();
}

#[tokio::test]
async fn what_the_server_cannot_read_is_said() {
    use std::os::unix::fs::PermissionsExt as _;
    if is_root() {
        return; // root reads everything: the permission cases cannot be staged
    }
    let dir = scratch("perm");
    let config = dir.join("config");
    write_transcript(&config, "-srv-proj", SID_A, &user("readable"));
    let locked = write_transcript(&config, "-srv-proj", SID_B, &user("locked"));
    std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o000)).unwrap();
    let _seam = SshSeam::install(&fake_ssh(&dir, &config));
    let m = machine();
    let server = Server { machine: &m, known_hosts: None };
    let listed = list_server_conversations(&server, &ServerHistoryCache::default()).await.unwrap();
    assert_eq!((listed.conversations.len(), listed.unreadable), (1, 1));

    // `projects/` itself unreadable: an error naming the server, never "no conversations".
    let projects = config.join("projects");
    std::fs::set_permissions(&projects, std::fs::Permissions::from_mode(0o000)).unwrap();
    let err = list_server_conversations(&server, &ServerHistoryCache::default()).await.unwrap_err();
    std::fs::set_permissions(&projects, std::fs::Permissions::from_mode(0o755)).unwrap();
    std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o644)).unwrap();
    assert!(
        matches!(&err, FileReadError::Io { server: Some(s), reason } if s == "Target" && reason.contains("cannot read")),
        "{err:?}"
    );
    std::fs::remove_dir_all(&dir).ok();
}

#[tokio::test]
async fn a_server_with_no_transcripts_lists_nothing_without_error() {
    let dir = scratch("empty");
    let config = dir.join("config");
    std::fs::create_dir_all(&config).unwrap();
    let _seam = SshSeam::install(&fake_ssh(&dir, &config));
    let m = machine();
    let server = Server { machine: &m, known_hosts: None };
    let listed = list_server_conversations(&server, &ServerHistoryCache::default()).await.unwrap();
    assert!(listed.conversations.is_empty());
    std::fs::create_dir_all(config.join("projects")).unwrap();
    let listed = list_server_conversations(&server, &ServerHistoryCache::default()).await.unwrap();
    assert!(listed.conversations.is_empty());
    std::fs::remove_dir_all(&dir).ok();
}

/// The server path against this Mac's own readers, over every real transcript on this Mac: the
/// script run through the fake ssh (this Mac's `sh`, awk and `stat -f`) must list each
/// conversation as `scan_disk_conversation` does and index the same body as `index_one`
/// (whenever that body fits the per-file budget).
#[tokio::test]
#[ignore = "reads every real ~/.claude transcript of this Mac"]
async fn live_the_server_reader_agrees_with_this_macs_on_real_transcripts() {
    let config = crate::supervisor::history::claude_config_dir().expect("a Claude config dir");
    let dir = scratch("live-equiv");
    let _seam = SshSeam::install(&fake_ssh(&dir, &config));
    let m = machine();
    let server = Server { machine: &m, known_hosts: None };
    let limits = ScanLimits { round_max: u64::MAX / 4, round_seconds: 600, ..ScanLimits::default() };
    let cache = ServerHistoryCache::default();
    let listed = list_server_conversations_with(&server, &cache, &limits).await.unwrap();
    let by_sid: HashMap<&str, &DiskConversation> = listed.conversations.iter().map(|r| (r.session_id.as_str(), r)).collect();
    let published = cache.published(&["m-hist".to_string()]);
    let index: HashMap<&str, &IndexedConversation> = published[0].index().map(|i| (i.session_id.as_str(), i)).collect();
    let (mut rows, mut bodies, mut capped, mut live) = (0, 0, 0, 0);
    for path in crate::supervisor::history::transcript_files_in(&config) {
        let Some(local) = scan_disk_conversation(&path) else { continue };
        if std::fs::symlink_metadata(&path).map(|m| m.file_type().is_symlink()).unwrap_or(true) {
            continue;
        }
        let remote = by_sid.get(local.session_id.as_str()).unwrap_or_else(|| panic!("{} not listed", path.display()));
        // The pre-filtered lines bring a late `ai-title` within the head-read's grace window: the
        // server reader may find a title this Mac's raw head-read gave up on — never another one.
        let title_ok = local.title == remote.title || (local.title.is_none() && remote.title.is_some());
        if local.excerpt != remote.excerpt || !title_ok || local.cwd != remote.cwd {
            // Two transcripts of one session (a moved cwd) list once, the most recent.
            assert!(
                crate::supervisor::history::transcript_files_in(&config)
                    .iter()
                    .filter(|p| p.file_stem() == path.file_stem())
                    .count()
                    > 1,
                "{}: local {:?} / server {:?}",
                path.display(),
                (&local.excerpt, &local.title, &local.cwd),
                (&remote.excerpt, &remote.title, &remote.cwd),
            );
        }
        if local.mtime_ms / 1000 != remote.mtime_ms / 1000 {
            // Written while the test ran (a conversation at work on this Mac): not comparable.
            assert!(remote.mtime_ms <= local.mtime_ms, "{}", path.display());
            live += 1;
            continue;
        }
        rows += 1;
        let local_body = index_one(&path).unwrap();
        let remote_body = index[local.session_id.as_str()].body();
        if local_body.body() == remote_body {
            bodies += 1;
        } else {
            // Only a body the per-file budget cut short may differ — and then as its prefix.
            assert!(local_body.body().starts_with(remote_body), "{}", path.display());
            capped += 1;
        }
    }
    eprintln!("{rows} rows agree; {bodies} bodies identical, {capped} cut by the per-file budget; {live} written during the test");
    assert!(rows > 0);
    std::fs::remove_dir_all(&dir).ok();
}

/// Against the real test server (josty-CC, its own `~/.claude`): the conversation closed in the
/// app on 28/10 is listed — archived on its daemon, transcript intact — and found by the search.
#[tokio::test]
#[ignore = "needs the josty-CC test box over Tailscale"]
async fn live_josty_cc_lists_and_finds_the_archived_conversation() {
    let key = format!("{}/.ssh/flightdeck_box_ed25519", std::env::var("HOME").unwrap());
    let m = MachineRecord {
        id: "josty-cc".into(),
        label: "josty-CC".into(),
        host: "josty-cc".into(),
        user: "josty".into(),
        identity_file: Some(key),
        ..machine()
    };
    let server = Server { machine: &m, known_hosts: None };
    let cache = ServerHistoryCache::default();
    let started = std::time::Instant::now();
    let listed = list_server_conversations(&server, &cache).await.unwrap();
    let first = started.elapsed();
    let row = listed
        .conversations
        .iter()
        .find(|r| r.session_id == "c296297d-73d2-4807-8d7d-ff96e375bdba")
        .expect("the archived conversation is listed");
    assert_eq!(row.cwd, "/home/josty/Documents");
    assert_eq!(row.title.as_deref(), Some("Dentapoche décompilation preparation"));
    assert_eq!(row.machine_id.as_deref(), Some("josty-cc"));
    let published = cache.published(&["josty-cc".to_string()]);
    let hits = score_index(published[0].index(), "dentapoche");
    assert!(hits.iter().any(|h| h.session_id == row.session_id), "{hits:?}");
    let started = std::time::Instant::now();
    let again = list_server_conversations(&server, &cache).await.unwrap();
    eprintln!(
        "{} conversations ({} pending, {} unreadable); first listing {first:?}, second {:?}",
        listed.conversations.len(),
        listed.pending,
        listed.unreadable,
        started.elapsed()
    );
    assert_eq!(again.conversations.len(), listed.conversations.len());
}
