use super::*;
use serde_json::json;

// ---- Fixtures --------------------------------------------------------------------------------

/// A fresh, empty temp dir unique to this test.
fn temp_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("tosse-gsearch-{name}-{}", std::process::id()));
    std::fs::remove_dir_all(&dir).ok();
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn write(path: &Path, content: impl AsRef<[u8]>) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, content).unwrap();
}

fn query(pattern: &str) -> SearchQuery {
    SearchQuery {
        pattern: pattern.to_string(),
        is_regex: false,
        match_case: false,
        whole_word: false,
    }
}

fn compiled(q: SearchQuery) -> CompiledQuery {
    CompiledQuery::new(&q).unwrap()
}

fn no_conversations() -> ConversationSources {
    ConversationSources {
        claude_config_dir: None,
        codex_sessions_dir: None,
    }
}

fn file_request(pattern: &str, roots: &[&Path]) -> GlobalSearchRequest {
    GlobalSearchRequest {
        query: query(pattern),
        roots: roots.iter().map(|r| r.to_string_lossy().into_owned()).collect(),
        files: true,
        conversations: false,
        include: String::new(),
        exclude: String::new(),
    }
}

fn run_request(request: &GlobalSearchRequest, sources: &ConversationSources) -> GlobalSearchResult {
    let search = GlobalSearch::new();
    let ticket = search.begin();
    run_with(&ticket, request, sources).unwrap()
}

fn rel_paths(result: &GlobalSearchResult) -> Vec<&str> {
    result.files.iter().map(|f| f.rel_path.as_str()).collect()
}

fn range(start: u32, end: u32) -> HitRange {
    HitRange { start, end }
}

// ---- Query semantics -------------------------------------------------------------------------

#[test]
fn a_literal_pattern_is_escaped_and_a_regex_one_is_not() {
    let text = "a.b(x)\naxb(y)\n";
    let literal = search_text(text, &compiled(query("a.b("))).unwrap();
    assert_eq!(literal.match_count, 1);
    assert_eq!(literal.lines[0].line, 1);

    let regex = search_text(
        text,
        &compiled(SearchQuery {
            is_regex: true,
            ..query(r"a.b\(")
        }),
    )
    .unwrap();
    assert_eq!(regex.match_count, 2, "`.` is a wildcard in regex mode");
}

#[test]
fn match_case_toggles_case_sensitivity() {
    let text = "Foo foo FOO";
    assert_eq!(search_text(text, &compiled(query("foo"))).unwrap().match_count, 3);
    let sensitive = compiled(SearchQuery {
        match_case: true,
        ..query("foo")
    });
    let hits = search_text(text, &sensitive).unwrap();
    assert_eq!(hits.match_count, 1);
    assert_eq!(hits.lines[0].ranges, vec![range(4, 7)]);
}

#[test]
fn whole_word_respects_word_edges_including_a_punctuation_edge() {
    let text = "foo food foo( barfoo( _foo";
    let word = |pattern: &str, is_regex: bool| {
        compiled(SearchQuery {
            whole_word: true,
            is_regex,
            ..query(pattern)
        })
    };
    // "foo" alone and inside "foo(" — never "food", "barfoo(" or "_foo".
    let hits = search_text(text, &word("foo", false)).unwrap();
    assert_eq!(hits.match_count, 2);
    assert_eq!(hits.lines[0].ranges, vec![range(0, 3), range(9, 12)]);
    // "foo(" ends on punctuation: no boundary demanded after the `(`, so it still matches —
    // but "barfoo(" does not (the `f` edge is a word char).
    let hits = search_text(text, &word("foo(", false)).unwrap();
    assert_eq!(hits.match_count, 1);
    assert_eq!(hits.lines[0].ranges, vec![range(9, 13)]);
    // Regex mode wraps the whole alternation.
    let hits = search_text(text, &word("fo+|bar", true)).unwrap();
    assert_eq!(hits.match_count, 2, "neither `food` nor `barfoo` is a whole word");
}

#[test]
fn an_invalid_regex_is_an_error_naming_it() {
    let err = CompiledQuery::new(&SearchQuery {
        is_regex: true,
        ..query("a(")
    })
    .err()
    .unwrap();
    assert!(err.starts_with("Invalid regular expression: "), "{err}");

    let root = temp_dir("bad-regex");
    let mut request = file_request("a(", &[&root]);
    request.query.is_regex = true;
    let search = GlobalSearch::new();
    let err = run_with(&search.begin(), &request, &no_conversations()).err().unwrap();
    std::fs::remove_dir_all(&root).ok();
    assert!(err.starts_with("Invalid regular expression: "), "{err}");
}

#[test]
fn zero_length_matches_are_never_hits() {
    let regex = |p: &str| {
        compiled(SearchQuery {
            is_regex: true,
            ..query(p)
        })
    };
    let hits = search_text("bbb\naa\n", &regex("a*")).unwrap();
    assert_eq!(hits.match_count, 1, "only the non-empty run counts");
    assert_eq!(hits.lines.len(), 1);
    assert_eq!(hits.lines[0].line, 2);
    assert_eq!(hits.lines[0].ranges, vec![range(0, 2)]);
    assert!(search_text("abc\ndef", &regex("^")).is_none());
    assert!(search_text("abc def", &regex(r"\b")).is_none());
}

#[test]
fn line_anchors_work_per_line_even_with_crlf() {
    let regex = |p: &str| {
        compiled(SearchQuery {
            is_regex: true,
            ..query(p)
        })
    };
    let text = "foo\r\nbar foo\r\nfoo bar\r\n";
    let hits = search_text(text, &regex("foo$")).unwrap();
    assert_eq!(hits.lines.iter().map(|l| l.line).collect::<Vec<_>>(), vec![1, 2]);
    let hits = search_text(text, &regex("^foo")).unwrap();
    assert_eq!(hits.lines.iter().map(|l| l.line).collect::<Vec<_>>(), vec![1, 3]);
    assert!(!hits.lines[0].preview.ends_with('\r'), "the CR is stripped from the preview");
}

#[test]
fn columns_and_ranges_are_utf16_code_units() {
    // é = 1 UTF-16 unit, 😀 = 2 (a surrogate pair).
    let hits = search_text("é😀 foo\n😀foo😀foo", &compiled(query("foo"))).unwrap();
    assert_eq!(hits.lines[0].column, 5);
    assert_eq!(hits.lines[0].ranges, vec![range(4, 7)]);
    assert_eq!(hits.lines[1].column, 3);
    assert_eq!(hits.lines[1].ranges, vec![range(2, 5), range(7, 10)]);
    // A leading BOM is not part of line 1 (Monaco drops it).
    let hits = search_text("\u{feff}foo", &compiled(query("foo"))).unwrap();
    assert_eq!(hits.lines[0].column, 1);
}

#[test]
fn long_lines_are_windowed_around_the_first_match() {
    let q = compiled(query("needle"));
    // Mid-line: 60 chars of lead, 240-char window, cut on both sides.
    let line = format!("{}needle{}", "x".repeat(300), "y".repeat(300));
    let hit = &search_text(&line, &q).unwrap().lines[0];
    assert_eq!(hit.column, 301);
    assert_eq!(hit.preview, format!("…{}needle{}…", "x".repeat(60), "y".repeat(174)));
    assert_eq!(hit.ranges, vec![range(61, 67)]);

    // Near the end: the window is pulled back to stay full, no trailing marker.
    let line = format!("{}needle", "x".repeat(400));
    let hit = &search_text(&line, &q).unwrap().lines[0];
    assert_eq!(hit.preview, format!("…{}needle", "x".repeat(234)));
    assert_eq!(hit.ranges, vec![range(235, 241)]);

    // At the start: no leading marker.
    let line = format!("needle{}", "y".repeat(300));
    let hit = &search_text(&line, &q).unwrap().lines[0];
    assert!(hit.preview.starts_with("needle") && hit.preview.ends_with('…'));
    assert_eq!(hit.ranges, vec![range(0, 6)]);

    // Multi-byte chars are cut on char boundaries, offsets stay UTF-16.
    let line = format!("{}needle{}", "é".repeat(300), "😀".repeat(300));
    let hit = &search_text(&line, &q).unwrap().lines[0];
    assert_eq!(hit.column, 301);
    assert!(hit.preview.starts_with(&format!("…{}needle😀", "é".repeat(60))));
    assert_eq!(hit.ranges, vec![range(61, 67)]);
}

// ---- File walk -------------------------------------------------------------------------------

#[test]
fn gitignore_is_respected_in_and_outside_a_repo_and_hidden_files_are_searched() {
    let base = temp_dir("gitignore");
    // A plain folder (no repo): its .gitignore still applies.
    let plain = base.join("plain");
    write(&plain.join(".gitignore"), "ignored.txt\nbuild/\n");
    write(&plain.join("kept.txt"), "needle");
    write(&plain.join("ignored.txt"), "needle");
    write(&plain.join("build/out.txt"), "needle");
    write(&plain.join(".hidden.txt"), "needle");
    let result = run_request(&file_request("needle", &[&plain]), &no_conversations());
    assert_eq!(rel_paths(&result), vec![".hidden.txt", "kept.txt"]);

    // A repo: its .gitignore applies, its .git internals are never searched.
    let repo = base.join("repo");
    write(&repo.join(".git/HEAD"), "needle");
    write(&repo.join(".gitignore"), "secret.txt\n");
    write(&repo.join("secret.txt"), "needle");
    write(&repo.join("main.txt"), "needle");
    let result = run_request(&file_request("needle", &[&repo]), &no_conversations());
    std::fs::remove_dir_all(&base).ok();
    assert_eq!(rel_paths(&result), vec!["main.txt"]);
    assert_eq!(result.files_scanned, 2, "main.txt + .gitignore (no match)");
}

#[test]
fn vcs_internals_node_modules_and_app_worktrees_are_skipped() {
    let root = temp_dir("worktrees");
    write(&root.join(".git/config"), "needle");
    write(&root.join("node_modules/pkg/index.js"), "needle");
    write(&root.join(".claude/worktrees/feat/a.txt"), "needle");
    write(&root.join(".claude/worktrees/feat/.git"), "gitdir: needle");
    write(&root.join(".claude/settings.json"), "needle");
    write(&root.join("src/a.txt"), "needle");
    let result = run_request(&file_request("needle", &[&root]), &no_conversations());
    assert_eq!(rel_paths(&result), vec![".claude/settings.json", "src/a.txt"]);

    // A root INSIDE a worktree (or the worktrees dir itself) is searched normally.
    let worktree = root.join(".claude/worktrees/feat");
    let result = run_request(&file_request("needle", &[&worktree]), &no_conversations());
    assert_eq!(rel_paths(&result), vec!["a.txt"]);
    let worktrees = root.join(".claude/worktrees");
    let result = run_request(&file_request("needle", &[&worktrees]), &no_conversations());
    std::fs::remove_dir_all(&root).ok();
    assert_eq!(rel_paths(&result), vec!["feat/a.txt"]);
}

#[test]
fn binary_files_are_skipped() {
    let root = temp_dir("binary");
    write(&root.join("blob.bin"), b"needle\0rest of a binary");
    write(&root.join("text.txt"), "needle");
    let result = run_request(&file_request("needle", &[&root]), &no_conversations());
    std::fs::remove_dir_all(&root).ok();
    assert_eq!(rel_paths(&result), vec!["text.txt"]);
    assert_eq!(result.files_scanned, 1);
}

#[test]
fn files_over_the_size_cap_are_counted_not_searched() {
    let root = temp_dir("large");
    let mut big = b"needle\n".to_vec();
    big.resize(MAX_FILE_BYTES as usize + 1, b'a');
    write(&root.join("big.txt"), big);
    write(&root.join("small.txt"), "needle");
    let result = run_request(&file_request("needle", &[&root]), &no_conversations());
    std::fs::remove_dir_all(&root).ok();
    assert_eq!(rel_paths(&result), vec!["small.txt"]);
    assert_eq!(result.large_files_skipped, 1);
}

#[test]
fn include_and_exclude_globs_follow_vs_code_semantics() {
    let root = temp_dir("globs");
    for f in ["src/a.ts", "src/b.rs", "lib/c.ts", "src/gen/d.ts"] {
        write(&root.join(f), "needle");
    }
    let search = |include: &str, exclude: &str| {
        let mut request = file_request("needle", &[&root]);
        request.include = include.to_string();
        request.exclude = exclude.to_string();
        let result = run_request(&request, &no_conversations());
        rel_paths(&result).into_iter().map(str::to_string).collect::<Vec<_>>()
    };
    // No slash → any depth.
    assert_eq!(search("*.ts", ""), vec!["lib/c.ts", "src/a.ts", "src/gen/d.ts"]);
    // A folder name covers its contents, at any depth.
    assert_eq!(search("gen", ""), vec!["src/gen/d.ts"]);
    // With a slash → relative to the root.
    assert_eq!(search("src/**", ""), vec!["src/a.ts", "src/b.rs", "src/gen/d.ts"]);
    assert_eq!(search("./lib", ""), vec!["lib/c.ts"]);
    // Commas separate globs, but not inside a {a,b} alternation.
    assert_eq!(search("*.rs, lib/**", ""), vec!["lib/c.ts", "src/b.rs"]);
    assert_eq!(search("*.{rs,ts}", "").len(), 4);
    // Exclude prunes, and wins over include.
    assert_eq!(search("", "gen"), vec!["lib/c.ts", "src/a.ts", "src/b.rs"]);
    assert_eq!(search("*.ts", "src/gen/**"), vec!["lib/c.ts", "src/a.ts"]);

    // An invalid glob is an error naming it.
    let mut request = file_request("needle", &[&root]);
    request.exclude = "*.md, src/[abc".to_string();
    let search_state = GlobalSearch::new();
    let err = run_with(&search_state.begin(), &request, &no_conversations())
        .err()
        .unwrap();
    std::fs::remove_dir_all(&root).ok();
    assert!(err.starts_with("Invalid glob 'src/[abc': "), "{err}");
}

#[test]
fn nested_roots_report_each_file_once_under_its_most_specific_root() {
    let outer = temp_dir("nested");
    let inner = outer.join("inner");
    write(&outer.join("a.txt"), "needle");
    write(&inner.join("b.txt"), "needle");
    let result = run_request(&file_request("needle", &[&outer, &inner, &outer]), &no_conversations());
    let found: Vec<(String, &str)> = result
        .files
        .iter()
        .map(|f| (f.root.clone(), f.rel_path.as_str()))
        .collect();
    let outer_s = outer.to_string_lossy().into_owned();
    let inner_s = inner.to_string_lossy().into_owned();
    assert_eq!(found, vec![(outer_s.clone(), "a.txt"), (inner_s.clone(), "b.txt")]);
    assert_eq!(result.file_match_count, 2, "nothing reported twice");

    // Results follow the ROOT order of the request, and the inner root's own globs are
    // relative to it.
    let mut request = file_request("needle", &[&inner, &outer]);
    request.include = "./b.txt, ./a.txt".to_string();
    let result = run_request(&request, &no_conversations());
    std::fs::remove_dir_all(&outer).ok();
    let found: Vec<&str> = result.files.iter().map(|f| f.root.as_str()).collect();
    assert_eq!(found, vec![inner_s.as_str(), outer_s.as_str()]);
}

#[test]
fn unusable_roots_are_reported_with_a_reason_not_dropped() {
    let root = temp_dir("roots");
    write(&root.join("a.txt"), "needle");
    let file_root = root.join("a.txt");
    let request = GlobalSearchRequest {
        roots: vec![
            "/definitely/missing/tosse-gsearch".to_string(),
            "relative/path".to_string(),
            file_root.to_string_lossy().into_owned(),
            format!("{}/", root.to_string_lossy()),
        ],
        ..file_request("needle", &[])
    };
    let result = run_request(&request, &no_conversations());
    std::fs::remove_dir_all(&root).ok();
    let reasons: Vec<&str> = result.skipped_roots.iter().map(|s| s.reason.as_str()).collect();
    assert_eq!(reasons, vec!["Folder not found", "Not an absolute path", "Not a folder"]);
    assert_eq!(result.skipped_roots[0].path, "/definitely/missing/tosse-gsearch");
    // The good root (sent with a trailing slash) is still searched and echoed as sent.
    assert_eq!(rel_paths(&result), vec!["a.txt"]);
    assert_eq!(result.files[0].root, format!("{}/", root.to_string_lossy()));
}

#[test]
fn the_per_file_line_cap_keeps_the_full_match_count() {
    let root = temp_dir("line-cap");
    write(&root.join("many.txt"), "needle needle\n".repeat(150));
    let result = run_request(&file_request("needle", &[&root]), &no_conversations());
    std::fs::remove_dir_all(&root).ok();
    let file = &result.files[0];
    assert_eq!(file.lines.len(), MAX_LINES_PER_FILE);
    assert_eq!(file.match_count, 300);
    assert_eq!(result.file_match_count, 300);
    assert!(!result.files_truncated, "the per-file cap is not a global truncation");
}

#[test]
fn the_global_line_cap_truncates_and_says_so() {
    let root = temp_dir("total-cap");
    let content = "needle\n".repeat(MAX_LINES_PER_FILE);
    let file_count = MAX_LINES_TOTAL / MAX_LINES_PER_FILE + 5;
    for i in 0..file_count {
        write(&root.join(format!("f{i:03}.txt")), &content);
    }
    let result = run_request(&file_request("needle", &[&root]), &no_conversations());
    std::fs::remove_dir_all(&root).ok();
    let returned: usize = result.files.iter().map(|f| f.lines.len()).sum();
    assert_eq!(returned, MAX_LINES_TOTAL);
    assert!(result.files_truncated);
    assert!(!result.cancelled);
}

#[test]
fn an_empty_pattern_or_no_scope_is_an_empty_result() {
    let root = temp_dir("empty");
    write(&root.join("a.txt"), "needle");
    let result = run_request(&file_request("  ", &[&root]), &no_conversations());
    assert!(result.files.is_empty() && !result.cancelled);
    let mut request = file_request("needle", &[&root]);
    request.files = false;
    let result = run_request(&request, &no_conversations());
    std::fs::remove_dir_all(&root).ok();
    assert!(result.files.is_empty() && result.files_scanned == 0);
}

#[test]
fn a_superseded_search_reports_cancelled() {
    let root = temp_dir("cancel");
    write(&root.join("a.txt"), "needle");
    let request = file_request("needle", &[&root]);
    let search = GlobalSearch::new();

    // Cancelled before it ran.
    let ticket = search.begin();
    search.cancel();
    let result = run_with(&ticket, &request, &no_conversations()).unwrap();
    assert!(result.cancelled);

    // Superseded by a newer search; the newer one runs normally.
    let older = search.begin();
    let newer = search.begin();
    assert!(run_with(&older, &request, &no_conversations()).unwrap().cancelled);
    let result = run_with(&newer, &request, &no_conversations()).unwrap();
    std::fs::remove_dir_all(&root).ok();
    assert!(!result.cancelled);
    assert_eq!(rel_paths(&result), vec!["a.txt"]);
}

// ---- Conversations ---------------------------------------------------------------------------

fn write_transcript(config: &Path, session_id: &str, lines: &[serde_json::Value]) -> PathBuf {
    let path = config.join("projects").join("-a-repo").join(format!("{session_id}.jsonl"));
    let body: String = lines.iter().map(|l| format!("{l}\n")).collect();
    write(&path, body);
    path
}

fn user(cwd: &str, content: serde_json::Value) -> serde_json::Value {
    json!({ "type": "user", "cwd": cwd, "message": { "role": "user", "content": content } })
}

fn assistant(cwd: &str, blocks: serde_json::Value) -> serde_json::Value {
    json!({ "type": "assistant", "cwd": cwd, "message": { "id": "m", "content": blocks } })
}

fn rollout_line(ty: &str, payload: serde_json::Value) -> serde_json::Value {
    json!({ "timestamp": "2026-07-10T01:00:00Z", "type": ty, "payload": payload })
}

fn conversation_request(pattern: &str, roots: &[&str]) -> GlobalSearchRequest {
    GlobalSearchRequest {
        query: query(pattern),
        roots: roots.iter().map(|r| r.to_string()).collect(),
        files: false,
        conversations: true,
        include: String::new(),
        exclude: String::new(),
    }
}

#[test]
fn conversations_match_prompts_and_prose_only_under_the_roots() {
    let base = temp_dir("conversations");
    let claude = base.join("claude");
    let codex = base.join("codex");
    let sources = ConversationSources {
        claude_config_dir: Some(claude.clone()),
        codex_sessions_dir: Some(codex.clone()),
    };
    // Main conversation: one human prompt + one assistant prose hit. Thinking, tool input,
    // tool output and sub-agent (sidechain) turns also say "zebra" and must NOT match.
    write_transcript(
        &claude,
        "11111111-1111-1111-1111-111111111111",
        &[
            user("/a/repo", json!("please find the zebra bug")),
            assistant(
                "/a/repo",
                json!([
                    { "type": "thinking", "thinking": "zebra thoughts" },
                    { "type": "text", "text": "I found the\n\n   zebra here" },
                    { "type": "tool_use", "id": "t1", "name": "Bash", "input": { "command": "grep zebra" } }
                ]),
            ),
            user(
                "/a/repo",
                json!([{ "type": "tool_result", "tool_use_id": "t1", "content": "zebra in tool output" }]),
            ),
            json!({ "type": "user", "isSidechain": true, "cwd": "/a/repo",
                    "message": { "role": "user", "content": "zebra sub-agent prompt" } }),
            json!({ "type": "assistant", "isSidechain": true, "cwd": "/a/repo",
                    "message": { "content": [{ "type": "text", "text": "zebra from a sub-agent" }] } }),
        ],
    );
    // A worktree of the repo: under the root.
    write_transcript(
        &claude,
        "22222222-2222-2222-2222-222222222222",
        &[user("/a/repo/.claude/worktrees/feat", json!("zebra in a worktree"))],
    );
    // A sibling repo sharing the prefix: NOT under `/a/repo`.
    write_transcript(
        &claude,
        "33333333-3333-3333-3333-333333333333",
        &[user("/a/repo2", json!("zebra next door"))],
    );
    // A Codex thread under the root: user + agent prose match, tool output does not.
    let rollout = codex
        .join("2026/07/10")
        .join("rollout-2026-07-10T01-00-00-44444444-4444-4444-4444-444444444444.jsonl");
    let lines = [
        rollout_line("session_meta", json!({ "id": "44444444-4444-4444-4444-444444444444", "cwd": "/a/repo", "source": "vscode" })),
        rollout_line("event_msg", json!({ "type": "user_message", "message": "codex zebra please", "images": [] })),
        rollout_line("response_item", json!({ "type": "function_call_output", "call_id": "c1", "output": "zebra tool output" })),
        rollout_line("event_msg", json!({ "type": "agent_message", "message": "Zebra handled." })),
    ];
    write(&rollout, lines.iter().map(|l| format!("{l}\n")).collect::<String>());

    let result = run_request(&conversation_request("zebra", &["/a/repo"]), &sources);
    std::fs::remove_dir_all(&base).ok();

    assert!(!result.cancelled && !result.conversations_truncated);
    let mut ids: Vec<&str> = result.conversations.iter().map(|c| c.session_id.as_str()).collect();
    ids.sort();
    assert_eq!(
        ids,
        vec![
            "11111111-1111-1111-1111-111111111111",
            "22222222-2222-2222-2222-222222222222",
            "44444444-4444-4444-4444-444444444444",
        ],
        "the sibling /a/repo2 is not under /a/repo"
    );
    assert_eq!(result.conversations_scanned, 3);
    assert!(result.conversations.iter().all(|c| c.root == "/a/repo"));

    let main = result
        .conversations
        .iter()
        .find(|c| c.session_id.starts_with("1111"))
        .unwrap();
    assert_eq!(main.backend, "claude");
    assert_eq!(main.match_count, 2, "prompt + prose only: {main:#?}");
    let roles: Vec<(&str, u32)> = main
        .hits
        .iter()
        .map(|h| (h.role.as_str(), h.message_index))
        .collect();
    assert_eq!(roles, vec![("user", 0), ("assistant", 1)]);
    assert_eq!(main.hits[0].preview, "please find the zebra bug");
    assert_eq!(main.hits[0].ranges, vec![range(16, 21)]);
    // Whitespace runs are flattened in the preview, the range follows.
    assert_eq!(main.hits[1].preview, "I found the zebra here");
    assert_eq!(main.hits[1].ranges, vec![range(12, 17)]);

    let codex_hit = result
        .conversations
        .iter()
        .find(|c| c.session_id.starts_with("4444"))
        .unwrap();
    assert_eq!(codex_hit.backend, "codex");
    assert_eq!(codex_hit.match_count, 2, "user + agent message, not the tool output");
    assert_eq!(result.conversation_match_count, 5);
}

#[test]
fn the_conversation_cache_follows_a_transcript_that_changes() {
    let base = temp_dir("conv-cache");
    let claude = base.join("claude");
    let sources = ConversationSources {
        claude_config_dir: Some(claude.clone()),
        codex_sessions_dir: None,
    };
    let session = "55555555-5555-5555-5555-555555555555";
    let mut lines = vec![user("/a/repo", json!("first zebra"))];
    write_transcript(&claude, session, &lines);
    let search = GlobalSearch::new();
    let request = conversation_request("zebra", &["/a/repo"]);
    let first = run_with(&search.begin(), &request, &sources).unwrap();
    assert_eq!(first.conversation_match_count, 1);
    assert_eq!(lock(&search.inner.conv_cache).len(), 1, "cached after the first search");

    lines.push(assistant("/a/repo", json!([{ "type": "text", "text": "second zebra" }])));
    write_transcript(&claude, session, &lines);
    let second = run_with(&search.begin(), &request, &sources).unwrap();
    assert_eq!(second.conversation_match_count, 2, "the grown transcript is re-read");

    // A transcript that disappeared is evicted.
    std::fs::remove_dir_all(&claude).ok();
    let third = run_with(&search.begin(), &request, &sources).unwrap();
    std::fs::remove_dir_all(&base).ok();
    assert!(third.conversations.is_empty());
    assert!(lock(&search.inner.conv_cache).is_empty());
}

/// A transcript that cannot be opened/read is COUNTED in `unreadable_conversations` — on the
/// head scan (never mistaken for, and cached as, a noise session) and on the full read of a
/// conversation whose row was already cached — while readable conversations still match.
#[cfg(unix)]
#[test]
fn unreadable_transcripts_are_counted_not_silently_skipped() {
    use std::os::unix::fs::PermissionsExt;
    let set_mode = |path: &Path, mode: u32| {
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).unwrap();
    };
    let base = temp_dir("conv-unreadable");
    let claude = base.join("claude");
    let sources = ConversationSources {
        claude_config_dir: Some(claude.clone()),
        codex_sessions_dir: None,
    };
    write_transcript(
        &claude,
        "66666666-6666-6666-6666-666666666666",
        &[user("/a/repo", json!("readable zebra"))],
    );
    let other = write_transcript(
        &claude,
        "77777777-7777-7777-7777-777777777777",
        &[user("/b/other", json!("other zebra"))],
    );
    let locked = write_transcript(
        &claude,
        "88888888-8888-8888-8888-888888888888",
        &[user("/a/repo", json!("locked zebra"))],
    );
    set_mode(&locked, 0o000);
    if std::fs::File::open(&locked).is_ok() {
        // Running as root: permissions do not block reads, nothing to observe here.
        eprintln!("skipping: file permissions are not enforced for this user");
        std::fs::remove_dir_all(&base).ok();
        return;
    }

    // Head scan: the locked transcript is counted, not cached as noise.
    let search = GlobalSearch::new();
    let first = run_with(&search.begin(), &conversation_request("zebra", &["/a/repo"]), &sources).unwrap();
    assert_eq!(first.unreadable_conversations, 1);
    assert_eq!(first.conversation_match_count, 1, "the readable one still matches");
    assert!(
        !lock(&search.inner.conv_cache).contains_key(&locked),
        "an unreadable transcript is retried next time, not cached as noise"
    );

    // Full read: `other`'s row was cached by the first search (its cwd was not under the
    // root then); now its messages are needed but the file has become unreadable.
    set_mode(&other, 0o000);
    let second = run_with(
        &search.begin(),
        &conversation_request("zebra", &["/a/repo", "/b/other"]),
        &sources,
    )
    .unwrap();
    set_mode(&locked, 0o644);
    set_mode(&other, 0o644);
    std::fs::remove_dir_all(&base).ok();
    assert_eq!(second.unreadable_conversations, 2, "locked (head scan) + other (full read)");
    assert_eq!(second.conversation_match_count, 1);
    assert!(!second.cancelled);
}

#[test]
fn root_matching_is_on_a_path_boundary_and_most_specific() {
    assert!(path_is_under("/a/repo", "/a/repo"));
    assert!(path_is_under("/a/repo/.claude/worktrees/x", "/a/repo"));
    assert!(!path_is_under("/a/repo2", "/a/repo"));
    assert!(path_is_under("/anything", "/"));
    let roots = conversation_roots(&["/a".to_string(), "/a/repo/".to_string()]);
    assert_eq!(root_for_cwd("/a/repo/src", &roots).unwrap().given, "/a/repo/");
    assert_eq!(root_for_cwd("/a/other", &roots).unwrap().given, "/a");
    assert!(root_for_cwd("/b", &roots).is_none());
}

#[test]
fn flattening_keeps_spans_on_the_words_they_cover() {
    let text = "  a  \n b\tzebra  c  ";
    let zebra = text.find("zebra").unwrap();
    let ws = text.find("  c").unwrap();
    let (flat, spans) = flatten_with_spans(text, &[(zebra, zebra + 5), (ws, ws + 2)]);
    assert_eq!(flat, text.split_whitespace().collect::<Vec<_>>().join(" "));
    // The whitespace-only span collapses to nothing and is dropped.
    assert_eq!(spans, vec![(4, 9)]);
    assert_eq!(&flat[4..9], "zebra");

    // A span starting ON whitespace keeps the one collapsed space; one ending on it does not.
    let text = "foo   bar";
    let (flat, spans) = flatten_with_spans(text, &[(3, 9)]);
    assert_eq!(flat, "foo bar");
    assert_eq!(spans, vec![(3, 7)]);
    assert_eq!(&flat[3..7], " bar");
    let (_, spans) = flatten_with_spans(text, &[(0, 5)]);
    assert_eq!(spans, vec![(0, 3)]);
}

/// PROBE (not hermetic): search THIS repo's files and the real `~/.claude` / `~/.codex`
/// conversations under it, twice (cold, then warm cache), and report counts + timings. Run:
/// `cargo test --lib -- --ignored --nocapture live_global_search_probe`.
#[test]
#[ignore = "reads the real repo and real transcripts off disk"]
fn live_global_search_probe() {
    // The repo this crate lives in — rolled up out of an app worktree, so its conversations
    // (whose cwd is the main checkout or any of its worktrees) are all under it.
    let crate_repo = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().to_string_lossy().into_owned();
    let repo = PathBuf::from(history::repo_root_from_cwd(&crate_repo));
    let request = GlobalSearchRequest {
        query: query("search"),
        roots: vec![repo.to_string_lossy().into_owned()],
        files: true,
        conversations: true,
        include: String::new(),
        exclude: String::new(),
    };
    let search = GlobalSearch::new();
    for pass in ["cold", "warm"] {
        let result = run_with(&search.begin(), &request, &ConversationSources::from_env()).unwrap();
        eprintln!(
            "PROBE {pass}: {} ms · files {} hit / {} scanned ({} matches, truncated={}, unreadable={}, large={}) · conversations {} hit / {} scanned ({} matches, truncated={}) · skipped {:?}",
            result.elapsed_ms,
            result.files.len(),
            result.files_scanned,
            result.file_match_count,
            result.files_truncated,
            result.unreadable_files,
            result.large_files_skipped,
            result.conversations.len(),
            result.conversations_scanned,
            result.conversation_match_count,
            result.conversations_truncated,
            result.skipped_roots,
        );
        for f in result.files.iter().take(5) {
            eprintln!("  {} ({} matches) first: {:?}", f.rel_path, f.match_count, f.lines.first().map(|l| (&l.line, &l.preview)));
        }
        for c in result.conversations.iter().take(3) {
            eprintln!("  [{}] {} ({} matches) {:?}", c.backend, c.session_id, c.match_count, c.hits.first().map(|h| &h.preview));
        }
        assert!(!result.cancelled);
    }
}

#[test]
fn long_messages_are_windowed_in_the_preview() {
    let re = compiled(query("zebra")).re;
    let text = format!("{} zebra {}", "word ".repeat(100), "tail ".repeat(100));
    let messages = vec![SearchableMessage {
        role: history::MessageRole::Assistant,
        text,
    }];
    let (hits, total) = match_messages(&messages, &re);
    assert_eq!(total, 1);
    let hit = &hits[0];
    assert!(hit.preview.starts_with('…') && hit.preview.ends_with('…'));
    assert_eq!(hit.preview.chars().count(), MESSAGE_PREVIEW_CHARS + 2);
    let r = &hit.ranges[0];
    let preview_utf16: Vec<u16> = hit.preview.encode_utf16().collect();
    assert_eq!(
        String::from_utf16(&preview_utf16[r.start as usize..r.end as usize]).unwrap(),
        "zebra"
    );
    assert_eq!(r.start, 61, "60 chars of lead + the leading marker");
}
