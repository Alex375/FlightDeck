//! The macOS Edit menu's Undo / Redo, routed to whoever has the keyboard.
//!
//! WHY: the `unstable` (multi-webview) Tauri feature — needed by the artifact host — makes the
//! MAIN webview a CHILD webview, and for a child wry answers NO to `performKeyEquivalent:`
//! (`WryWebView`, workaround for tauri#9426). A ⌘+key that matches a menu item is then served by
//! the MENU and never reaches the page's JavaScript. With the predefined Edit › Undo item, ⌘Z
//! became AppKit's `undo:` and App's keydown handler never saw it: the conversation delete could
//! no longer be undone (nor could Monaco's own undo run, which also listens on keydown).
//! VERIFIED in wry 0.55.1 / tauri-runtime-wry 2.11.2 — re-check on a Tauri upgrade.
//!
//! FIX: Undo / Redo are our OWN items, with the same accelerators. When the main webview has
//! the keyboard, the front decides what they mean (`src/ui/editMenu.ts`: the conversation
//! delete's undo, Monaco's, or the focused field's native one). When another view has it (the
//! artifact host, a native panel), the standard action goes up the responder chain exactly as
//! the predefined item did.

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri_specta::Event;

/// Menu ids of our two items.
pub const UNDO_ID: &str = "edit-undo";
pub const REDO_ID: &str = "edit-redo";

/// Which Edit menu command fired.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum EditAction {
    Undo,
    Redo,
}

/// Edit › Undo / Redo (menu click or ⌘Z / ⌘⇧Z) while the main webview has the keyboard. The
/// front routes it — see `src/ui/editMenu.ts`.
#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
pub struct EditMenuEvent {
    pub action: EditAction,
}

/// The Edit submenu: Undo / Redo as our own items (see the module doc), the rest predefined.
#[cfg(target_os = "macos")]
pub fn submenu(app: &tauri::App) -> tauri::Result<tauri::menu::Submenu<tauri::Wry>> {
    use tauri::menu::{MenuItemBuilder, SubmenuBuilder};
    let undo = MenuItemBuilder::with_id(UNDO_ID, "Undo").accelerator("CmdOrCtrl+Z").build(app)?;
    let redo =
        MenuItemBuilder::with_id(REDO_ID, "Redo").accelerator("CmdOrCtrl+Shift+Z").build(app)?;
    SubmenuBuilder::new(app, "Edit")
        .item(&undo)
        .item(&redo)
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()
}

/// Route our Undo / Redo items. Call once, from `setup`, after the menu is set and the main
/// webview exists.
pub fn install(app: &tauri::App) {
    #[cfg(target_os = "macos")]
    {
        macos::capture_main_view(app);
        app.on_menu_event(|app, event| {
            let action = match event.id().as_ref() {
                UNDO_ID => EditAction::Undo,
                REDO_ID => EditAction::Redo,
                _ => return,
            };
            macos::route(app, action);
        });
    }
    #[cfg(not(target_os = "macos"))]
    let _ = app;
}

/// The standard `undo:` / `redo:`, for a front that cannot answer itself (see the
/// `edit_menu_native` command). Posted to the main thread — never run inside the IPC callback.
pub fn native(app: &tauri::AppHandle, action: EditAction) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        app.run_on_main_thread(move || match objc2::MainThreadMarker::new() {
            Some(mtm) => macos::send_native(mtm, action),
            None => eprintln!("[edit_menu] native {action:?} ran off the main thread: dropped"),
        })
        .map_err(|e| format!("could not reach the main thread for a native {action:?}: {e}"))
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Err(format!("no native {action:?} on this platform: the Edit menu is macOS-only"))
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use super::{EditAction, EditMenuEvent};
    use objc2::rc::Retained;
    use objc2::{sel, MainThreadMarker};
    use objc2_app_kit::{NSApplication, NSView};
    use std::cell::OnceCell;
    use tauri::{AppHandle, Manager};
    use tauri_specta::Event;

    /// The label of the webview that fills the main window.
    const MAIN: &str = "main";

    thread_local! {
        /// The main webview's WKWebView. Main thread only — set by `capture_main_view`, read by
        /// the menu handler (both run there).
        static MAIN_VIEW: OnceCell<Retained<NSView>> = const { OnceCell::new() };
    }

    /// Keep the main webview's view, so the menu handler can tell who has the keyboard without
    /// going through `with_webview` itself.
    ///
    /// ⚠️ Never call `with_webview` from the menu handler: on the main thread it runs its closure
    /// INLINE while holding the webview's `window_id` lock, and emitting an event from there takes
    /// that same lock again (`eval_script`) — the app froze on the first ⌘Z (tauri-runtime-wry
    /// 2.11.2). Here the closure only stores the view.
    pub fn capture_main_view(app: &tauri::App) {
        let Some(webview) = app.get_webview(MAIN) else {
            eprintln!("[edit_menu] no main webview at setup: Undo/Redo will always go to the app");
            return;
        };
        let posted = webview.with_webview(|platform| {
            // SAFETY: the pointer is the WKWebView (an NSView) wry keeps alive for the webview's
            // whole lifetime; retaining it keeps it valid for as long as we hold it.
            let Some(view) = (unsafe { Retained::retain(platform.inner() as *mut NSView) }) else {
                return;
            };
            MAIN_VIEW.with(|cell| {
                let _ = cell.set(view);
            });
        });
        // On the main thread (setup) the closure has already run by now.
        let captured = MAIN_VIEW.with(|cell| cell.get().is_some());
        if let Err(e) = posted {
            eprintln!("[edit_menu] could not reach the main webview: {e}");
        } else if !captured {
            eprintln!("[edit_menu] main webview view not captured: Undo/Redo will always go to the app");
        }
    }

    pub fn route(app: &AppHandle, action: EditAction) {
        let native = MainThreadMarker::new().filter(|&mtm| {
            MAIN_VIEW.with(|cell| cell.get().is_some_and(|main| another_view_has_keys(mtm, main)))
        });
        match native {
            Some(mtm) => send_native(mtm, action),
            None => emit(app, action),
        }
    }

    /// Whether the key window's first responder is a view OUTSIDE the main webview (the artifact
    /// host, a native panel's field). Anything else — the main webview, or no view at all — is
    /// the app's to answer.
    fn another_view_has_keys(mtm: MainThreadMarker, main: &NSView) -> bool {
        let app = NSApplication::sharedApplication(mtm);
        let Some(responder) = app.keyWindow().and_then(|w| w.firstResponder()) else {
            return false;
        };
        match responder.downcast::<NSView>() {
            Ok(view) => !view.isDescendantOf(main),
            Err(_) => false,
        }
    }

    /// What the predefined item did: the standard action, up the key window's responder chain.
    pub fn send_native(mtm: MainThreadMarker, action: EditAction) {
        let selector = match action {
            EditAction::Undo => sel!(undo:),
            EditAction::Redo => sel!(redo:),
        };
        // SAFETY: `undo:` / `redo:` take a sender, and a nil target means "the first responder
        // that implements it" — the exact message the predefined Edit item sends.
        unsafe { NSApplication::sharedApplication(mtm).sendAction_to_from(selector, None, None) };
    }

    fn emit(app: &AppHandle, action: EditAction) {
        if let Err(e) = (EditMenuEvent { action }).emit(app) {
            eprintln!("[edit_menu] failed to emit EditMenuEvent: {e}");
        }
    }
}
