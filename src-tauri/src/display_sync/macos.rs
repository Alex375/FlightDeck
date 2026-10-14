//! macOS side of `display_sync` (see `mod.rs`).

use objc2_app_kit::NSView;
use tauri::{AppHandle, Manager, WindowEvent};

/// The app's single main window, and the label of the webview that fills it.
const MAIN: &str = "main";

pub fn install(app: &tauri::App) {
    // ⚠️ `get_window`, NOT `get_webview_window`: once the artifact host adds its child webview,
    // the main window is multi-webview and `get_webview_window("main")` returns None.
    let Some(window) = app.get_window(MAIN) else { return };
    let handle = app.handle().clone();
    window.on_window_event(move |event| {
        if let WindowEvent::ScaleFactorChanged { .. } = event {
            resync_main_webview(&handle);
        }
    });
}

/// Give the main webview its window's content bounds back if a resize left it elsewhere.
fn resync_main_webview(app: &AppHandle) {
    let Some(webview) = app.get_webview(MAIN) else { return };
    // `with_webview` is posted to the event loop: it runs on the main thread, after the events
    // already queued — the stale `Resized` of the same burst included.
    let posted = webview.with_webview(|platform| {
        let view = platform.inner() as *const NSView;
        if view.is_null() {
            return;
        }
        // SAFETY: the pointer is the WKWebView (an NSView) wry keeps alive for the webview's
        // whole lifetime, and this closure runs on the main thread.
        let view = unsafe { &*view };
        let Some(parent) = (unsafe { view.superview() }) else { return };
        let target = parent.bounds();
        if view.frame() != target {
            view.setFrame(target);
        }
    });
    if let Err(e) = posted {
        eprintln!("[display_sync] could not re-sync the main webview after a scale change: {e}");
    }
}
