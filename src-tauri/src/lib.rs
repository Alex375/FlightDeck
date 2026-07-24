pub mod accounts;
pub mod extensions;
pub mod fs;
pub mod git;
mod ipc;
pub mod plugins;
pub mod power;
pub mod store;
pub mod supervisor;
pub mod terminal;
pub mod usage;

use ipc::commands::{
    answer_permission, copy_entry, create_dir, create_file, create_worktree, delete_conversation,
    delete_repo, delete_to_trash, fetch_slash_commands,
    generate_conversation_title, generate_message_summary, get_plan_usage, git_branches, git_commit,
    git_commit_file_diff,
    git_commit_files, git_diff, git_fetch, git_log, git_pull, git_push, git_status,
    interrupt_session, list_disk_conversations, list_extensions, list_marketplaces,
    list_plugin_contents,
    list_worktrees, load_persisted_state, load_session_context, load_session_goal,
    load_session_history,
    load_subagent_transcript, load_workflow_journal, load_workflow_phases, load_workflow_run,
    mcp_authenticate, mcp_clear_auth, mcp_reconnect, mcp_status, mcp_toggle, open_in_terminal,
    account_claude_login_cancel, account_claude_login_code, account_claude_login_start,
    account_claude_logout, account_claude_status, account_codex_login_cancel,
    account_codex_login_start, account_codex_logout, account_codex_status,
    claude_available,
    codex_available, codex_archive, codex_compact, codex_fork, codex_list_extensions,
    codex_list_hooks, codex_list_models, codex_list_plugins, codex_list_skills,
    codex_load_history, codex_marketplace_add, codex_marketplace_remove,
    codex_marketplace_upgrade, codex_plugin_contents,
    codex_set_mcp_enabled, codex_set_plugin_enabled, codex_set_skill_enabled,
    path_exists, ping, prime_history_index,
    read_dir, read_file, read_image,
    read_task_output_file,
    refresh_plugin_marketplaces, reload_plugins,
    fork_conversation, remove_worktree, rename_entry, reveal_in_finder, request_user_attention,
    check_rewind_target, rewind_conversation, search_conversations,
    send_message, set_active_conversation, set_all_marketplaces_auto_update, set_effort_level,
    set_marketplace_auto_update, set_model,
    set_awake, set_permission_mode, set_plugin_enabled, set_remote_control, set_ultracode,
    spawn_session, stat_files, stop_session, stop_task, update_plugin,
    terminal_close, terminal_open, terminal_resize, terminal_write, unwatch_dir, upsert_conversation,
    upsert_repo, watch_dir, wipe_all_data, worktree_status, write_file, HistoryIndex, Sessions,
};
use ipc::events::{
    AccountLoginEvent, FsChangeEvent, FsWatchErrorEvent, SessionCodexPlanUsageEvent,
    SessionCommandsEvent, SessionExtensionsChangedEvent, SessionMessageEvent,
    SessionPermissionEvent, SessionRemoteControlEvent, SessionStateEvent, SessionSummaryEvent,
    SessionTaskEvent, SessionTitleEvent, TerminalExitEvent, TerminalOutputEvent, TickEvent,
};
use tauri_specta::{collect_commands, collect_events, Builder, Event};

/// Declare the IPC contract (commands + events) once. Shared by `run()` and the
/// TS-bindings export so they can never drift.
fn ipc_builder() -> Builder<tauri::Wry> {
    Builder::<tauri::Wry>::new()
        .commands(collect_commands![
            ping,
            spawn_session,
            claude_available,
            codex_available,
            codex_list_models,
            codex_list_skills,
            codex_compact,
            codex_list_extensions,
            codex_fork,
            codex_archive,
            codex_load_history,
            codex_set_skill_enabled,
            codex_set_mcp_enabled,
            codex_set_plugin_enabled,
            codex_list_plugins,
            codex_plugin_contents,
            codex_list_hooks,
            codex_marketplace_add,
            codex_marketplace_remove,
            codex_marketplace_upgrade,
            account_claude_status,
            account_claude_login_start,
            account_claude_login_code,
            account_claude_login_cancel,
            account_claude_logout,
            account_codex_status,
            account_codex_login_start,
            account_codex_login_cancel,
            account_codex_logout,
            fetch_slash_commands,
            load_session_history,
            load_session_context,
            load_session_goal,
            check_rewind_target,
            rewind_conversation,
            fork_conversation,
            load_subagent_transcript,
            load_workflow_run,
            load_workflow_journal,
            load_workflow_phases,
            list_disk_conversations,
            prime_history_index,
            search_conversations,
            read_task_output_file,
            get_plan_usage,
            send_message,
            answer_permission,
            set_permission_mode,
            set_model,
            set_effort_level,
            set_ultracode,
            set_remote_control,
            generate_conversation_title,
            generate_message_summary,
            interrupt_session,
            mcp_status,
            mcp_toggle,
            mcp_reconnect,
            mcp_clear_auth,
            mcp_authenticate,
            stop_session,
            stop_task,
            open_in_terminal,
            request_user_attention,
            list_worktrees,
            worktree_status,
            create_worktree,
            remove_worktree,
            list_extensions,
            set_plugin_enabled,
            list_plugin_contents,
            list_marketplaces,
            set_marketplace_auto_update,
            set_all_marketplaces_auto_update,
            refresh_plugin_marketplaces,
            update_plugin,
            reload_plugins,
            path_exists,
            git_status,
            git_diff,
            git_log,
            git_branches,
            git_commit_files,
            git_commit_file_diff,
            git_commit,
            git_push,
            git_pull,
            git_fetch,
            read_dir,
            read_file,
            read_image,
            stat_files,
            write_file,
            watch_dir,
            unwatch_dir,
            create_file,
            create_dir,
            rename_entry,
            copy_entry,
            delete_to_trash,
            reveal_in_finder,
            terminal_open,
            terminal_write,
            terminal_resize,
            terminal_close,
            load_persisted_state,
            upsert_repo,
            delete_repo,
            upsert_conversation,
            delete_conversation,
            set_active_conversation,
            wipe_all_data,
            set_awake,
        ])
        .events(collect_events![
            TickEvent,
            SessionStateEvent,
            SessionMessageEvent,
            SessionPermissionEvent,
            SessionCommandsEvent,
            SessionTaskEvent,
            SessionTitleEvent,
            SessionSummaryEvent,
            SessionRemoteControlEvent,
            SessionCodexPlanUsageEvent,
            SessionExtensionsChangedEvent,
            AccountLoginEvent,
            FsChangeEvent,
            FsWatchErrorEvent,
            TerminalOutputEvent,
            TerminalExitEvent,
        ])
}

/// Export the typed TS client into `src/ipc/bindings.ts`. Used by `run()` in
/// debug builds and by the `export_bindings_is_in_sync` test.
#[cfg(debug_assertions)]
fn export_bindings(builder: &Builder<tauri::Wry>) -> Result<(), Box<dyn std::error::Error>> {
    builder.export(
        // u64/i64 (e.g. timestamps, PIDs, sizes) -> TS `number`. JS-safe below
        // 2^53, which covers ms timestamps. Default behavior forbids BigInt
        // outright; switch to BigInt/String later if a value can exceed 2^53.
        // @ts-nocheck header: the generated file imports helpers it may not use
        // (e.g. TAURI_CHANNEL), which trips our strict noUnusedLocals.
        specta_typescript::Typescript::default()
            .bigint(specta_typescript::BigIntExportBehavior::Number)
            .header("// @ts-nocheck\n"),
        "../src/ipc/bindings.ts",
    )?;
    Ok(())
}

/// Sentinels wrapping the PATH the probe prints, so any rc-file noise on stdout
/// (an asdf/nvm banner, a stray `echo` in `.zshrc`) can never be mistaken for a
/// PATH entry — we read only what sits between them.
#[cfg(target_os = "macos")]
const PATH_START: &str = "__TOSSE_PATH_START__";
#[cfg(target_os = "macos")]
const PATH_END: &str = "__TOSSE_PATH_END__";

/// Pull the PATH printed between our sentinels out of the probe's stdout,
/// ignoring anything an rc file emitted around it. `None` when the markers are
/// absent (treat as a failed probe and keep our own PATH).
#[cfg(target_os = "macos")]
fn extract_sentinel_path(stdout: &str) -> Option<&str> {
    let start = stdout.find(PATH_START)? + PATH_START.len();
    let rest = &stdout[start..];
    let end = rest.find(PATH_END)?;
    Some(&rest[..end])
}

/// Merge `resolved` (the login shell's PATH) ahead of `current` (ours), dropping
/// empties and duplicates while preserving order. When `resolved == current` the
/// duplicates collapse back onto it and the result equals the input — so dev
/// (terminal-launched: the inherited PATH already IS the login-shell PATH) is left
/// byte-for-byte unchanged.
#[cfg(target_os = "macos")]
fn merge_paths(resolved: &str, current: &str) -> String {
    use std::collections::HashSet;
    let mut seen = HashSet::new();
    resolved
        .split(':')
        .chain(current.split(':'))
        .filter(|p| !p.is_empty() && seen.insert(*p))
        .collect::<Vec<_>>()
        .join(":")
}

/// Restore the user's real shell `PATH` into our own environment.
///
/// A macOS GUI app launched from Finder / Dock / Spotlight does NOT inherit the
/// user's shell PATH — it gets a minimal `/usr/bin:/bin:/usr/sbin:/sbin`. So the
/// `claude` binary (typically in `~/.local/bin`), and every tool it later spawns
/// (`git`, `node`, `rg`…), are unresolvable: the session silently fails to start
/// and messages appear to do nothing. (In dev the app is launched from a terminal,
/// inherits the full PATH, and this never bites — which is why it only breaks the
/// installed bundle.)
///
/// Fix: ask the user's login+interactive shell for its real PATH and merge it into
/// ours, so every child process resolves the same binaries a terminal would. The
/// merge is order-stable and de-duplicated, so it is a no-op when the PATH is
/// already rich. Best-effort and time-boxed off-thread: a missing or slow shell
/// must never block startup.
#[cfg(target_os = "macos")]
fn repair_env_path() {
    use std::process::Stdio;
    use std::sync::mpsc;
    use std::time::Duration;

    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    let (tx, rx) = mpsc::channel();
    // The login shell sources rc files that may be slow (nvm, asdf…) or even hang;
    // run it off-thread and abandon it past the deadline so boot can't wedge.
    std::thread::spawn(move || {
        let out = std::process::Command::new(&shell)
            // -l login (.zprofile/.bash_profile) + -i interactive (.zshrc, where
            // brew/asdf/nvm extend PATH) + -c. `command printf` + sentinels isolate
            // the value from any rc-file stdout noise.
            .arg("-lic")
            .arg(format!("command printf '{PATH_START}%s{PATH_END}' \"$PATH\""))
            // Null stdin so an rc that reads stdin can't block us; null stderr to
            // keep rc noise off ours. Only stdout (the sentinel value) is captured.
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .output();
        let _ = tx.send(out);
    });

    // Time-box: a slow/hung login shell must never wedge boot. The abandoned shell
    // is short-lived and OS-reaped.
    let stdout = match rx.recv_timeout(Duration::from_secs(3)) {
        Ok(Ok(out)) if out.status.success() => String::from_utf8_lossy(&out.stdout).into_owned(),
        _ => return, // timed out, shell missing, or non-zero exit — keep our PATH
    };
    let Some(resolved) = extract_sentinel_path(&stdout).map(str::trim) else {
        return; // markers absent (polluted/garbled output) — keep our PATH
    };
    if resolved.is_empty() {
        return;
    }

    let current = std::env::var("PATH").unwrap_or_default();
    let merged = merge_paths(resolved, &current);
    // Only touch the env when the merge actually adds something (dev no-op).
    if merged != current {
        std::env::set_var("PATH", merged);
    }
}

/// The bundle filename legacy installs still carry: they predate the "Flight Deck"
/// rebrand and the auto-updater replaces the bundle IN PLACE, keeping its old name.
#[cfg(target_os = "macos")]
const LEGACY_BUNDLE_NAME: &str = "Tosse Code.app";
/// The bundle filename matching the current display name ("Flight Deck").
#[cfg(target_os = "macos")]
const CURRENT_BUNDLE_NAME: &str = "Flight Deck.app";

/// Pure decision for the one-time bundle rename: the path the running `.app` should
/// be renamed to, or `None` when no migration is needed. Split from the filesystem
/// work so the guard is unit-tested.
///
/// Fires ONLY when the bundle is EXACTLY `Tosse Code.app`; after the rename the name
/// no longer matches, so it can never fire twice (no relaunch loop). Dev builds and
/// the `/build-*` test bundles carry other names and are left untouched.
#[cfg(target_os = "macos")]
fn legacy_bundle_rename_target(bundle_path: &std::path::Path) -> Option<std::path::PathBuf> {
    (bundle_path.file_name()?.to_str()? == LEGACY_BUNDLE_NAME)
        .then(|| bundle_path.with_file_name(CURRENT_BUNDLE_NAME))
}

/// The running `.app` bundle path, derived from the executable
/// (`…/Foo.app/Contents/MacOS/<bin>` → `…/Foo.app`). `None` when the layout doesn't
/// match — e.g. `cargo run` / `tauri dev` from `target/`, where there is no bundle.
#[cfg(target_os = "macos")]
fn running_bundle_path() -> Option<std::path::PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let bundle = exe.parent()?.parent()?.parent()?; // pop MacOS/, Contents/ → Foo.app
    (bundle.extension()?.to_str()? == "app").then(|| bundle.to_path_buf())
}

/// One-time self-heal for installs that predate the "Flight Deck" rebrand.
///
/// The display name is "Flight Deck" (productName), but the auto-updater replaces the
/// bundle IN PLACE, so an install first set up as `Tosse Code.app` keeps that
/// FILENAME forever. macOS derives the Spotlight/Finder name from the filename
/// (verified: `kMDItemDisplayName` tracks `kMDItemFSName`, NOT `CFBundleDisplayName`)
/// → such installs still surface as "Tosse Code" in Spotlight though the Dock/menus
/// read "Flight Deck". We can't rename users' bundles from the release side, so the
/// app renames ITSELF on launch, re-registers with LaunchServices, and relaunches.
///
/// The IDENTIFIER (`com.tosse.desktop`) is untouched → data dir, TCC grants and the
/// signing DR are all preserved (they key on identifier + certificate, never the
/// filename). Fail-safe: any failure (not a bundle, unwritable `/Applications`,
/// target already present, rename error) leaves the app running normally under its
/// old name — we relaunch ONLY after a successful rename, so a failure never loops.
#[cfg(target_os = "macos")]
fn migrate_legacy_bundle_name() {
    let Some(bundle) = running_bundle_path() else {
        return;
    };
    let Some(target) = legacy_bundle_rename_target(&bundle) else {
        return;
    };
    if target.exists() {
        return; // never clobber a `Flight Deck.app` already sitting alongside.
    }
    if std::fs::rename(&bundle, &target).is_err() {
        return; // unwritable (admin-owned /Applications, read-only DMG) → keep old name.
    }

    // Refresh LaunchServices so Spotlight/Finder pick up the new filename immediately.
    let _ = std::process::Command::new(
        "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister",
    )
    .arg("-f")
    .arg(&target)
    .status();

    // Hand off to the renamed bundle (the Dock tile / aliases still point at the old
    // path until the process restarts) and exit this instance. `-n` is REQUIRED: the
    // in-place rename keeps this live process registered under the same identifier
    // (`com.tosse.desktop`), so a bare `open` would just re-activate this dying
    // instance instead of launching a fresh copy — and the `exit(0)` right below
    // would then leave the app quit with nothing relaunched. `-n` forces a new
    // instance deterministically, independent of that race.
    let _ = std::process::Command::new("/usr/bin/open")
        .arg("-n")
        .arg(&target)
        .spawn();
    std::process::exit(0);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Legacy installs first set up as `Tosse Code.app` rename themselves to
    // `Flight Deck.app` and relaunch — before any other startup work, so the hand-off
    // is immediate. No-op on fresh installs and in dev (not a `.app` bundle).
    #[cfg(target_os = "macos")]
    migrate_legacy_bundle_name();

    // Restore the user's PATH before we spawn any child process (the lazy `claude`
    // session, any tool it runs). See fn doc.
    #[cfg(target_os = "macos")]
    repair_env_path();

    let specta_builder = ipc_builder();

    // Generate the TS client into src/ipc/bindings.ts (debug builds only).
    #[cfg(debug_assertions)]
    export_bindings(&specta_builder).expect("failed to export typescript bindings");

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        // Secure auto-update (signature-verified) + relaunch after install.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        // OS notifications (agent done / needs attention).
        .plugin(tauri_plugin_notification::init())
        // Wire commands through tauri-specta (replaces generate_handler!).
        .invoke_handler(specta_builder.invoke_handler())
        // The live session registry, reachable from every command.
        .manage(Sessions::new())
        // The cached full-text search index over on-disk conversations (history panel).
        .manage(HistoryIndex::new())
        // The editor's single active filesystem watch (live file/tree refresh).
        .manage(fs::FsWatcher::new())
        // The live integrated terminals (one PTY-backed shell per conversation).
        .manage(terminal::Terminals::new())
        // The single app-wide macOS keep-awake assertion (managed `caffeinate` child).
        .manage(power::Caffeinate::new())
        // The shared Codex app-server: lazy (spawned on the first Codex conversation),
        // one process multiplexing every Codex thread. An Arc so a conversation actor
        // can hold it beyond the spawning command's lifetime.
        .manage(std::sync::Arc::new(supervisor::codex::CodexServer::new()))
        .setup(move |app| {
            use tauri::Manager;

            // Mount the Specta events on this app instance (REQUIRED for events).
            specta_builder.mount_events(app);

            // macOS menu: rebuild the standard menu but WITHOUT "Close Window"
            // (Cmd+W). The default menu binds Cmd+W to closing the window, which on
            // this single-window app quits it — and a native menu accelerator fires
            // before the webview, so the editor's "close the active tab" Cmd+W could
            // never win. Dropping the item frees Cmd+W for the editor (and prevents
            // an accidental quit); Quit (Cmd+Q), Edit (copy/paste/undo…) and Minimize
            // stay intact.
            #[cfg(target_os = "macos")]
            {
                use tauri::menu::{MenuBuilder, SubmenuBuilder};
                let app_menu = SubmenuBuilder::new(app, "Flight Deck")
                    .hide()
                    .hide_others()
                    .show_all()
                    .separator()
                    .quit()
                    .build()?;
                let edit_menu = SubmenuBuilder::new(app, "Edit")
                    .undo()
                    .redo()
                    .separator()
                    .cut()
                    .copy()
                    .paste()
                    .select_all()
                    .build()?;
                let window_menu = SubmenuBuilder::new(app, "Window")
                    .minimize()
                    .build()?;
                let menu = MenuBuilder::new(app)
                    .items(&[&app_menu, &edit_menu, &window_menu])
                    .build()?;
                app.set_menu(menu)?;
            }

            // Open the persistence store in the app data dir (created if absent).
            // The store is the single owner of SQLite; the rest of the core and
            // the UI see domain records via IPC, never rows. dev and the bundled
            // app share the same identifier -> the same db -> a unified list.
            let data_dir = app
                .path()
                .app_data_dir()
                .expect("no app data dir available");
            std::fs::create_dir_all(&data_dir).expect("failed to create app data dir");
            let store = store::Store::open(&data_dir.join("tosse.db"))
                .expect("failed to open the persistence store");
            // Backfill activity timestamps for conversations created before the
            // `last_activity_at` column existed, so the sidebar's recency order is
            // correct for historical conversations on first launch. The transcript
            // mtime is the proxy for "last message"; created_at is the fallback.
            // No-op once every row is filled (best-effort: a failure here must not
            // block startup — the sidebar simply keeps the unbackfilled order).
            if let Err(e) =
                store.backfill_last_activity(supervisor::history::transcript_mtime_ms)
            {
                eprintln!("last_activity_at backfill failed: {e}");
            }
            app.manage(store);

            // Rust timer: emit a TickEvent every second (Rust -> React) — kept as
            // a heartbeat / proof of the outbound event leg.
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                let mut seq = 0u32;
                loop {
                    std::thread::sleep(std::time::Duration::from_secs(1));
                    seq += 1;
                    let ev = TickEvent {
                        seq,
                        message: format!("tick #{seq}"),
                    };
                    if TickEvent::emit(&ev, &handle).is_err() {
                        break; // window closed
                    }
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tosse-code")
        .run(|app_handle, event| {
            // On app exit, tear every live session down so we never orphan a
            // `claude` child (nor any of its tool/MCP grandchildren — each session
            // runs in its own process group and the actor's ladder signals the
            // whole group; see `supervisor::transport`). Request shutdown on every
            // session, then wait until the registry drains — each actor evicts
            // itself once its process is reaped — capped so quit never hangs.
            if let tauri::RunEvent::Exit = event {
                use std::time::{Duration, Instant};
                use tauri::Manager;
                // Kill every integrated-terminal shell so we never orphan one.
                app_handle.state::<terminal::Terminals>().kill_all();
                // Release the macOS keep-awake assertion so we never orphan the
                // `caffeinate` child holding the Mac awake forever. (Release never fails;
                // the child also self-terminates via `-w <pid>` if we somehow don't reach
                // here — see `power::Caffeinate::hold`.)
                let _ = app_handle.state::<power::Caffeinate>().set_awake(false);
                let sessions = app_handle.state::<Sessions>();
                let handles = sessions.handles();
                if !handles.is_empty() {
                    tauri::async_runtime::block_on(async {
                        for handle in &handles {
                            let _ = handle.shutdown().await;
                        }
                        let deadline = Duration::from_secs(6);
                        let start = Instant::now();
                        while !sessions.is_empty() && start.elapsed() < deadline {
                            tokio::time::sleep(Duration::from_millis(50)).await;
                        }
                    });
                }
                // Belt: tear the shared Codex app-server down so its MCP children are
                // never orphaned. The per-session shutdowns above already trigger this
                // when the last Codex thread closes (its actor's `close_thread`), but a
                // leaked server is reaped here too. Bounded so quit never hangs. NB the
                // group-SIGKILL sweep can't reach `setsid` MCP children — only this
                // graceful path (stdin EOF) does (see `supervisor::codex::transport`).
                let codex_server =
                    app_handle.state::<std::sync::Arc<supervisor::codex::CodexServer>>();
                tauri::async_runtime::block_on(async {
                    let _ = tokio::time::timeout(
                        Duration::from_secs(6),
                        codex_server.shutdown_all(),
                    )
                    .await;
                });
            }
        });
}

#[cfg(all(test, debug_assertions))]
mod tests {
    use super::*;

    /// Regenerate `src/ipc/bindings.ts` from the live IPC contract. Running the
    /// test suite keeps the committed TS bindings in sync with the Rust types.
    #[test]
    fn export_bindings_regenerates_ts_client() {
        export_bindings(&ipc_builder()).expect("bindings export should succeed");
    }
}

#[cfg(all(test, target_os = "macos"))]
mod path_repair_tests {
    use super::*;

    #[test]
    fn merge_puts_resolved_first_and_dedupes_in_order() {
        // Resolved entries lead; duplicates already present in `current` are not
        // repeated; current-only entries are appended.
        let merged = merge_paths(
            "/opt/homebrew/bin:/usr/bin",
            "/usr/bin:/bin:/sbin",
        );
        assert_eq!(merged, "/opt/homebrew/bin:/usr/bin:/bin:/sbin");
    }

    #[test]
    fn merge_drops_empty_segments() {
        assert_eq!(merge_paths(":/a::/b:", "/a:"), "/a:/b");
    }

    #[test]
    fn merge_is_noop_when_resolved_equals_current() {
        // Dev: the inherited PATH already IS the login-shell PATH -> identical
        // output, so repair_env_path's `merged != current` guard skips set_var.
        let current = "/opt/homebrew/bin:/usr/bin:/bin";
        assert_eq!(merge_paths(current, current), current);
    }

    #[test]
    fn extract_reads_value_between_sentinels() {
        let stdout = format!("{PATH_START}/a:/b{PATH_END}");
        assert_eq!(extract_sentinel_path(&stdout), Some("/a:/b"));
    }

    #[test]
    fn extract_ignores_rc_file_noise_around_the_value() {
        // An rc file printed a banner before AND after the real value.
        let stdout = format!(
            "Restored session: 42\n{PATH_START}/opt/homebrew/bin:/usr/bin{PATH_END}\nwelcome!\n"
        );
        assert_eq!(
            extract_sentinel_path(&stdout),
            Some("/opt/homebrew/bin:/usr/bin"),
        );
    }

    #[test]
    fn extract_returns_none_when_markers_absent() {
        assert_eq!(extract_sentinel_path("/usr/bin:/bin no markers here"), None);
    }
}

#[cfg(all(test, target_os = "macos"))]
mod bundle_migration_tests {
    use super::*;
    use std::path::{Path, PathBuf};

    #[test]
    fn renames_the_exact_legacy_bundle() {
        assert_eq!(
            legacy_bundle_rename_target(Path::new("/Applications/Tosse Code.app")),
            Some(PathBuf::from("/Applications/Flight Deck.app")),
        );
    }

    #[test]
    fn renames_in_place_wherever_the_bundle_lives() {
        // Self-heal works from any location the user put it (as long as it's writable
        // at runtime) — only the filename is swapped, the parent dir is preserved.
        assert_eq!(
            legacy_bundle_rename_target(Path::new("/Users/me/Desktop/Tosse Code.app")),
            Some(PathBuf::from("/Users/me/Desktop/Flight Deck.app")),
        );
    }

    #[test]
    fn already_renamed_is_a_noop() {
        // After the rename the name no longer matches → the migration never fires
        // twice, so a successful rename can't produce a relaunch loop.
        assert_eq!(
            legacy_bundle_rename_target(Path::new("/Applications/Flight Deck.app")),
            None,
        );
    }

    #[test]
    fn leaves_dev_and_test_bundles_alone() {
        // Only the EXACT legacy name migrates; everything else is left untouched.
        for name in [
            "Flight Deck dev build.app", // /build-dev
            "FlightDeck feat-x.app",     // /build-app
            "Tosse Code Test State.app", // test-state overlay
            "Tosse Code.app.bak",        // not exactly the legacy name
            "Tosse Code",                // no .app at all
        ] {
            let p = PathBuf::from("/Applications").join(name);
            assert_eq!(
                legacy_bundle_rename_target(&p),
                None,
                "should not migrate {name}",
            );
        }
    }
}
