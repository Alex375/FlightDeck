//! The single service that keeps the main webview's frame in step with its window when the
//! window changes display scale.
//!
//! WHY: the `unstable` (multi-webview) Tauri feature — needed by the artifact host — makes the
//! MAIN webview a CHILD webview that Tauri resizes itself, from tao's `Resized` events. tao
//! measures that size in PHYSICAL pixels with the backing scale of the moment; Tauri converts it
//! back to points with the scale it reads when it HANDLES the event. When a fullscreen window
//! jumps between displays of different scale (the Mac replugged into a 1x external display, the
//! built-in one being 2x), the resize is measured at 2x and handled at 1x: the webview ends up
//! exactly twice the window (5120×2880 points in a 2560×1440 window), so the interface looks
//! zoomed into its top-left quarter — and nothing sizes it back until the window's next real
//! resize (leaving fullscreen). VERIFIED with an instrumented build against tauri-runtime-wry
//! 2.11.2 (its `TaoWindowEvent::Resized` handler) — re-check on a Tauri upgrade.
//!
//! FIX: on every scale change of the main window, give the main webview its window's content
//! bounds back, read from AppKit. NOT from `Window::inner_size`: on macOS, while the window has a
//! single webview, that reports the webview's own — wrong — frame. The main webview always fills
//! the window (Tauri's auto-resize rates are 0/0/1/1 and nothing in the app positions it), so the
//! content view's bounds ARE its frame.

#[cfg(target_os = "macos")]
mod macos;

/// Wire the scale-change re-sync on the main window. Call once, from `setup`.
pub fn install(app: &tauri::App) {
    #[cfg(target_os = "macos")]
    macos::install(app);
    #[cfg(not(target_os = "macos"))]
    let _ = app;
}
