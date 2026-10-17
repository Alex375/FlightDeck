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

/// Route our Undo / Redo items. Call once, from `setup`, after the menu is set.
pub fn install(app: &tauri::App) {
    #[cfg(target_os = "macos")]
    app.on_menu_event(|app, event| {
        let action = match event.id().as_ref() {
            UNDO_ID => EditAction::Undo,
            REDO_ID => EditAction::Redo,
            _ => return,
        };
        macos::route(app, action);
    });
    #[cfg(not(target_os = "macos"))]
    let _ = app;
}

#[cfg(target_os = "macos")]
mod macos {
    use super::{EditAction, EditMenuEvent};
    use objc2::{sel, MainThreadMarker};
    use objc2_app_kit::{NSApplication, NSView};
    use tauri::{AppHandle, Manager};
    use tauri_specta::Event;

    /// The label of the webview that fills the main window.
    const MAIN: &str = "main";

    pub fn route(app: &AppHandle, action: EditAction) {
        let Some(webview) = app.get_webview(MAIN) else { return emit(app, action) };
        let handle = app.clone();
        // Posted to the event loop: runs on the main thread, where AppKit may be asked who has
        // the keyboard.
        let posted = webview.with_webview(move |platform| {
            let main = platform.inner() as *const NSView;
            match MainThreadMarker::new() {
                // SAFETY: the pointer is the WKWebView (an NSView) wry keeps alive for the
                // webview's whole lifetime, and this closure runs on the main thread.
                Some(mtm) if !main.is_null() && another_view_has_keys(mtm, unsafe { &*main }) => {
                    send_native(mtm, action)
                }
                _ => emit(&handle, action),
            }
        });
        if let Err(e) = posted {
            eprintln!("[edit_menu] could not ask who has the keyboard, routing to the app: {e}");
            emit(app, action);
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
    fn send_native(mtm: MainThreadMarker, action: EditAction) {
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
