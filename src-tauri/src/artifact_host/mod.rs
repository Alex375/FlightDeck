//! The single service that owns the in-app ARTIFACT HOST: one native child webview, laid over
//! the side region, that shows an artifact's claude.ai-hosted page.
//!
//! WHY A NATIVE WEBVIEW (not an iframe): claude.ai serves an artifact page with
//! `X-Frame-Options: SAMEORIGIN`, behind a Cloudflare challenge, and a private artifact needs the
//! user's claude.ai session — an iframe inside our `tauri://` document can do none of that. A
//! child webview is a real top-level browsing context: it passes the challenge, keeps its own
//! cookies (the user signs in once, inside the panel; WebKit persists the session across
//! launches) and renders the page with full fidelity. That includes TYPED artifacts (Claude
//! Design canvases…), whose page belongs to their type and exists nowhere but on claude.ai — the
//! local files Claude publishes for them are data, not a page.
//!
//! MECHANISM, not policy (same split as `power/`): the FRONT decides when the host is visible and
//! where — it tracks the viewer's placeholder element, and hides the host whenever an overlay
//! covers it, since a native view always paints above the HTML. This service only creates, moves,
//! shows, hides, navigates and closes the one webview, and reports its page loads.
//!
//! SECURITY: the page is remote content. Tauri refuses every IPC call from a remote origin unless
//! a capability grants that origin explicitly (`remote.urls`) — ours grant none — so the page can
//! reach neither our commands nor any plugin. Nor can it read our EVENTS (session messages,
//! terminal output…): Tauri only evaluates an event into a webview that registered a JS listener
//! for it, and registering one is itself an IPC call (`plugin:event|listen`) the ACL refuses.
//! VERIFIED against tauri 2.11 (`webview/mod.rs` invoke ACL check, `event/listener.rs`
//! `emit_js_filter`) — re-check on a Tauri upgrade. The host is only ever pointed at a claude.ai
//! artifact URL ([`parse_hosted_artifact_url`]). Pop-ups go to the system browser, except a
//! sign-in pop-up, which has to share this webview's session to complete.
//!
//! ⚠️ Adding a child webview turns the main window into a MULTI-webview window, after which
//! `get_webview_window("main")` returns `None` (it only matches a window whose sole webview
//! carries its label). Anything that reaches the main window must go through
//! `get_window("main")` / `get_webview("main")` — see `request_user_attention` and `set_ui_zoom`.

use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::webview::{Color, NewWindowResponse, PageLoadEvent, WebviewBuilder};
use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, Rect, Url, WebviewUrl};
use tauri_plugin_opener::OpenerExt;
use tauri_specta::Event;

/// The host webview's label (unique app-wide).
pub const HOST_LABEL: &str = "artifact-host";
/// The window the host lives in — the app's single main window.
const MAIN_WINDOW: &str = "main";
/// Same backstop range as `set_ui_zoom`: the front mirrors the app's UI zoom onto the host.
const MIN_ZOOM: f64 = 0.25;
const MAX_ZOOM: f64 = 4.0;

/// A rectangle in the main window's LOGICAL coordinates — CSS pixels of the app's document
/// multiplied by the UI zoom (the front does that product; see `artifactHost.ts`).
#[derive(Debug, Clone, Copy, Deserialize, Serialize, Type)]
pub struct HostBounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl HostBounds {
    /// The bounds as a Tauri rect, or `Err` for a nonsense rectangle (NaN, infinite, negative
    /// size). Refused rather than applied: a NaN frame can leave the native view stranded
    /// somewhere the user can neither see nor dismiss.
    fn to_rect(self) -> Result<Rect, String> {
        let finite = [self.x, self.y, self.width, self.height].iter().all(|v| v.is_finite());
        if !finite || self.width < 0.0 || self.height < 0.0 {
            return Err(format!("invalid artifact host bounds: {self:?}"));
        }
        Ok(Rect {
            position: LogicalPosition::new(self.x, self.y).into(),
            size: LogicalSize::new(self.width, self.height).into(),
        })
    }
}

/// What happened in the host webview, for the viewer's status line.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum ArtifactHostEventKind {
    /// A top-level page started loading (`url` = the page).
    Started,
    /// A top-level page finished loading (`url` = the page — e.g. claude.ai's sign-in page when
    /// the session is missing, which is how the front knows to say "sign in").
    Finished,
    /// A link the page opened in a new window could not be handed to the system browser.
    ExternalOpenFailed,
    /// A pop-up (or a navigation) was refused because it targeted something other than the web —
    /// a custom URL scheme that would have launched another app. Surfaced so the click isn't
    /// silently dropped.
    PopupRefused,
    /// A pop-up with no page of its own (`about:blank`, `blob:`, `data:`) was refused because the
    /// host is not signing in — an artifact opening a chrome-less window it would fill itself.
    /// Its own kind so the front never explains it as "it would launch another app".
    PopupBlankRefused,
    /// This page asked to open more links than [`OPEN_BUDGET`] allows; the rest were dropped.
    OpensThrottled,
    /// A download was requested. The view can't show one, so it is refused — and said, rather
    /// than leaving the click to do nothing.
    DownloadRefused,
}

/// Emitted for every top-level page load of the host, and when a pop-up hand-off fails.
#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
pub struct ArtifactHostEvent {
    pub kind: ArtifactHostEventKind,
    pub url: String,
}

/// Parse `raw` as a hosted claude.ai ARTIFACT URL — the only thing the host is ever pointed at.
/// Both shapes the CLI has emitted: `https://claude.ai/artifact/<id>` (2.1.272+) and
/// `https://claude.ai/code/artifact/<uuid>` (older transcripts). Anything else is refused, so a
/// compromised or buggy caller cannot turn the host into a general-purpose browser.
pub fn parse_hosted_artifact_url(raw: &str) -> Result<Url, String> {
    let url = Url::parse(raw.trim()).map_err(|e| format!("not a URL ({e}): {raw}"))?;
    let segments: Vec<&str> = url.path_segments().map(|s| s.collect()).unwrap_or_default();
    let id = match segments.as_slice() {
        ["artifact", id] | ["code", "artifact", id] => *id,
        _ => "",
    };
    let id_ok = !id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-');
    if url.scheme() != "https" || url.host_str() != Some("claude.ai") || url.port().is_some() || !id_ok {
        return Err(format!("not a claude.ai artifact URL: {raw}"));
    }
    Ok(url)
}

/// True when `url` is a sign-in window's: claude.ai's own sign-in, or an identity provider it
/// hands off to. Such a pop-up completes by talking back to the page that opened it, which only
/// works in a webview sharing the host's session — so it stays INSIDE the app. Every other pop-up
/// is content (a link out of an artifact) and belongs in the system browser.
fn is_sign_in_url(url: &Url) -> bool {
    let Some(host) = url.host_str() else { return false };
    let under = |domain: &str| host == domain || host.ends_with(&format!(".{domain}"));
    url.scheme() == "https"
        && (under("claude.ai")
            || under("anthropic.com")
            || host == "accounts.google.com"
            || host == "appleid.apple.com")
}

/// Pop-up URLs that are a hand-off to the OS. ⚠️ ALLOWLIST, not a denylist: `open_url` on the Rust
/// side does NOT apply the app's opener scope (that check only guards the IPC command), so
/// forwarding whatever scheme the page asks for would let an artifact — remote, model-written,
/// promptable content — make Flight Deck launch ANY registered handler (`smb://` mounting a share,
/// `vscode://`, `x-apple.systempreferences:`…) on one click. Web schemes and mail only.
fn is_openable_externally(url: &Url) -> bool {
    matches!(url.scheme(), "https" | "http" | "mailto")
}

/// Paths on claude.ai that mean "signing in" — the mirror of the front's `SIGN_IN_PATH_RE`.
const SIGN_IN_PATHS: [&str; 6] = ["login", "signin", "sign-in", "logout", "magic-link", "sso"];

/// True when `url` is a page where SIGNING IN is what's happening: claude.ai's own sign-in paths,
/// or an identity provider's site. Deliberately narrower than [`is_sign_in_url`] — "a claude.ai
/// URL" is not a sign-in page (the artifact itself is one), and treating it as one re-opened the
/// hole this gate exists to close.
fn is_sign_in_page(url: &Url) -> bool {
    let Some(host) = url.host_str() else { return false };
    if !matches!(url.scheme(), "https" | "http") {
        return false;
    }
    if host == "claude.ai" {
        let first = url.path_segments().and_then(|mut s| s.next()).unwrap_or("");
        return SIGN_IN_PATHS.contains(&first);
    }
    is_sign_in_url(url)
}

/// How long after a sign-in page loads a pop-up may still be treated as part of that sign-in.
///
/// ⚠️ The gate reads the page the host last REPORTED loading, and claude.ai is a single-page app:
/// a navigation it performs without a document load (history API) leaves that record stale, so
/// "we are signing in" could outlive the sign-in. A sign-in takes seconds; bounding it costs the
/// user nothing and bounds the window in which a pop-up can be opened in-app.
const SIGN_IN_WINDOW: Duration = Duration::from_secs(180);

/// Whether a pop-up the page asked for stays INSIDE the app, given where the host currently is.
///
/// ⚠️ The gate is the HOST'S CURRENT PAGE, not the pop-up's URL. An in-app pop-up is a native
/// window with no address bar, and wry gives us no way to police where it goes afterwards — so
/// the only safe rule is to open one exclusively while a sign-in is already under way (the host
/// having been redirected to claude.ai's sign-in, or an identity provider). On the artifact page
/// itself, a pop-up is the artifact's own doing: it goes to the browser, where its origin is
/// visible. A blank pop-up (`about:blank`, what OAuth libraries open before navigating it) is
/// allowed under exactly the same rule. `None` — nothing loaded yet — is never a sign-in page.
fn popup_stays_in_app(page: Option<&HostPage>, url: &Url) -> bool {
    let signing_in = page.is_some_and(|p| {
        p.at.elapsed() <= SIGN_IN_WINDOW && Url::parse(&p.url).is_ok_and(|u| is_sign_in_page(&u))
    });
    signing_in && (url.scheme() == "about" || is_sign_in_url(url))
}

/// The top-level page the host last reported loading, and when.
#[derive(Debug, Clone)]
pub struct HostPage {
    url: String,
    at: Instant,
}

/// How many links one page load may hand to the OS (or have refused) before the rest are dropped
/// with a single "and N more".
///
/// ⚠️ A page can call `window.open` in a loop. Uncapped, one artifact could fire hundreds of
/// browser tabs, or hundreds of error banners — a nuisance the user cannot stop from inside the
/// panel. The first few are the real clicks; the rest are a script.
const OPEN_BUDGET: u32 = 3;

/// The one host webview's bookkeeping. Held as Tauri managed state.
#[derive(Default)]
pub struct ArtifactHost {
    /// The artifact URL the host was last pointed at. Showing the same artifact again must NOT
    /// re-navigate (that would reload the page and throw away where the user was — a canvas
    /// panned, a prototype mid-flow, the sign-in form half typed).
    requested: Mutex<Option<String>>,
    /// The top-level page the host is actually ON (after redirects), as the last page-load event
    /// reported it, and WHEN. Read by the pop-up handler — see [`popup_stays_in_app`]. Shared
    /// with the webview's callbacks, which outlive any one call, hence the `Arc`.
    page: Arc<Mutex<Option<HostPage>>>,
    /// Links this page load may still hand to the OS or report — see [`OPEN_BUDGET`].
    opens: Arc<AtomicU32>,
}

impl ArtifactHost {
    pub fn new() -> Self {
        Self::default()
    }

    /// Point the host at `url`, place it at `bounds`, scale it by `zoom` and show it — creating
    /// the webview on first use. Idempotent for the same URL (no reload).
    ///
    /// Returns whether it NAVIGATED (created the view, or pointed it at a different page).
    /// ⚠️ Load-bearing, not informational: page-load events only follow a navigation, so a front
    /// that assumed one would wait forever for an event that is never coming — and then report a
    /// page that is up and fine as a failure.
    pub fn show(&self, app: &AppHandle, url: &str, bounds: HostBounds, zoom: f64) -> Result<bool, String> {
        let target = parse_hosted_artifact_url(url)?;
        let rect = bounds.to_rect()?;
        if !zoom.is_finite() || !(MIN_ZOOM..=MAX_ZOOM).contains(&zoom) {
            return Err(format!("zoom factor out of range: {zoom}"));
        }
        let mut requested = self.requested.lock().unwrap();
        let mut navigated = false;
        let webview = match app.get_webview(HOST_LABEL) {
            Some(webview) => {
                if requested.as_deref() != Some(target.as_str()) {
                    webview.navigate(target.clone()).map_err(|e| e.to_string())?;
                    navigated = true;
                }
                webview.set_bounds(rect).map_err(|e| e.to_string())?;
                webview.show().map_err(|e| e.to_string())?;
                webview
            }
            None => {
                navigated = true;
                let window = app
                    .get_window(MAIN_WINDOW)
                    .ok_or_else(|| "the main window is gone".to_string())?;
                let builder = Self::builder(app, target.clone(), self.page.clone(), self.opens.clone());
                window
                    .add_child(builder, rect.position, rect.size)
                    .map_err(|e| format!("couldn't create the artifact view: {e}"))?
            }
        };
        webview.set_zoom(zoom).map_err(|e| e.to_string())?;
        *requested = Some(target.to_string());
        Ok(navigated)
    }

    /// Move/resize the host (no-op when it doesn't exist).
    pub fn set_bounds(&self, app: &AppHandle, bounds: HostBounds) -> Result<(), String> {
        let rect = bounds.to_rect()?;
        match app.get_webview(HOST_LABEL) {
            Some(webview) => webview.set_bounds(rect).map_err(|e| e.to_string()),
            None => Ok(()),
        }
    }

    /// Hide the host, keeping its page alive (no-op when it doesn't exist).
    pub fn hide(&self, app: &AppHandle) -> Result<(), String> {
        match app.get_webview(HOST_LABEL) {
            Some(webview) => webview.hide().map_err(|e| e.to_string()),
            None => Ok(()),
        }
    }

    /// Re-open the requested artifact in the host — a refresh, and the way back when the user
    /// navigated away inside it or a sign-in didn't return to the artifact.
    ///
    /// ⚠️ Errors when there is nothing to reload instead of returning `Ok`. The front puts the
    /// viewer in its "loading" state BEFORE calling this and then waits for a page-load event: a
    /// silent no-op would leave it waiting on a navigation that never happens, i.e. "Loading…"
    /// forever with nothing to read.
    pub fn reload(&self, app: &AppHandle) -> Result<(), String> {
        let requested = self.requested.lock().unwrap();
        let Some(url) = requested.as_deref() else {
            return Err("no artifact is loaded in the view".to_string());
        };
        let Some(webview) = app.get_webview(HOST_LABEL) else {
            return Err("the artifact view is gone".to_string());
        };
        let url = parse_hosted_artifact_url(url)?;
        webview.navigate(url).map_err(|e| e.to_string())
    }

    /// Point the host at a claude.ai SIGN-IN url the user pasted (the link claude.ai emails).
    ///
    /// ⚠️ Why this exists: macOS only offers passkeys on this Mac, and password AutoFill, to apps
    /// holding Apple's browser entitlement — granted to browsers, issued through a provisioning
    /// profile, and out of reach for a self-signed app. So the sign-in paths that work in this
    /// panel are a typed password or an emailed link, and an emailed link clicked in Mail opens
    /// the DEFAULT BROWSER, which signs in a session this webview will never see. Pasting it here
    /// is the way to spend it in the right place.
    ///
    /// Restricted to `https://claude.ai/…`: the panel never becomes a general-purpose browser,
    /// whatever is on the clipboard.
    pub fn open_claude_url(&self, app: &AppHandle, url: &str) -> Result<(), String> {
        let target = Url::parse(url.trim()).map_err(|e| format!("not a URL ({e})"))?;
        if target.scheme() != "https" || target.host_str() != Some("claude.ai") || target.port().is_some() {
            return Err("that link doesn't point at claude.ai".to_string());
        }
        let Some(webview) = app.get_webview(HOST_LABEL) else {
            return Err("the artifact view is gone".to_string());
        };
        webview.navigate(target).map_err(|e| e.to_string())
    }

    /// Destroy the host, releasing its web content process (a claude.ai page is heavy — it must
    /// not linger once nothing shows it). No-op when it doesn't exist.
    pub fn close(&self, app: &AppHandle) -> Result<(), String> {
        let mut requested = self.requested.lock().unwrap();
        *requested = None;
        *self.page.lock().unwrap() = None;
        match app.get_webview(HOST_LABEL) {
            Some(webview) => webview.close().map_err(|e| e.to_string()),
            None => Ok(()),
        }
    }

    fn builder(
        app: &AppHandle,
        url: Url,
        page: Arc<Mutex<Option<HostPage>>>,
        opens: Arc<AtomicU32>,
    ) -> WebviewBuilder<tauri::Wry> {
        let popup_app = app.clone();
        let nav_app = app.clone();
        let dl_app = app.clone();
        let popup_page = page.clone();
        let nav_opens = opens.clone();
        let popup_opens = opens.clone();
        WebviewBuilder::new(HOST_LABEL, WebviewUrl::External(url))
            // Content-level navigation stays web-only IN the view. This handler also sees
            // SUB-frame navigations (wry applies it to every frame), so it must not narrow hosts
            // — the artifact itself runs in a frame served from another origin.
            //
            // A link the view can't follow is not simply dropped: a `mailto:` goes to the mail
            // app exactly as it would from a `target=_blank` click (same allowlist), and a scheme
            // that would launch some OTHER app is refused and REPORTED — otherwise the click does
            // nothing at all and there is no telling a block from a broken link.
            .on_navigation(move |url| {
                if matches!(url.scheme(), "https" | "http" | "about" | "blob" | "data") {
                    return true;
                }
                if is_openable_externally(&url) {
                    hand_off(&nav_app, &nav_opens, &url);
                } else {
                    refuse(&nav_app, &nav_opens, &url);
                }
                false
            })
            // A download can't be shown in this view. Saying so beats the click doing nothing.
            .on_download(move |_webview, event| {
                if let tauri::webview::DownloadEvent::Requested { url, .. } = event {
                    eprintln!("artifact host: refused a download: {url}");
                    let _ = ArtifactHostEvent {
                        kind: ArtifactHostEventKind::DownloadRefused,
                        url: url.to_string(),
                    }
                    .emit(&dl_app);
                }
                false
            })
            .on_new_window(move |url, _features| {
                // ⚠️ `Allow`, NEVER `Create`. `Create` needs a Tauri window built right here —
                // inside WebKit's createWebView callback — and tauri-runtime-wry then looks it
                // up in its window registry with `.unwrap()`; built from this callback it isn't
                // registered yet → panic in a native callback → the WHOLE APP ABORTS (VERIFIED:
                // it crashed on claude.ai's "Continue with Google", tauri 2.11 / wry 0.55).
                // `Allow` lets wry open a plain native pop-up window on the OPENER's WebKit
                // configuration — same session, `window.opener` intact — which is all a sign-in
                // needs. (wry doesn't implement `webViewDidClose`, so a pop-up that calls
                // `window.close()` at the end stays open — the user closes it.)
                if popup_stays_in_app(popup_page.lock().unwrap().as_ref(), &url) {
                    return NewWindowResponse::Allow;
                }
                if is_openable_externally(&url) {
                    hand_off(&popup_app, &popup_opens, &url);
                } else {
                    refuse(&popup_app, &popup_opens, &url);
                }
                NewWindowResponse::Deny
            })
            .on_page_load(move |webview, payload| {
                let kind = match payload.event() {
                    PageLoadEvent::Started => ArtifactHostEventKind::Started,
                    PageLoadEvent::Finished => ArtifactHostEventKind::Finished,
                };
                let url = payload.url().to_string();
                // Where the host actually IS, for the pop-up gate (and it is the same value the
                // front shows). Updated on Started too: the gate must follow a navigation as soon
                // as it commits, not only once the page has finished loading. A new page also
                // refills the link budget — the cap is per page, not per lifetime.
                *page.lock().unwrap() = Some(HostPage { url: url.clone(), at: Instant::now() });
                opens.store(0, Ordering::Relaxed);
                let event = ArtifactHostEvent { kind, url };
                if let Err(e) = event.emit(webview.app_handle()) {
                    eprintln!("artifact host: emit page-load event failed: {e}");
                }
            })
            // The app background (`--wf-bg`), so the box the page paints into reads as the
            // panel while claude.ai loads — WebKit's default white flashes on the dark UI.
            .background_color(Color(12, 12, 15, 255))
            .devtools(cfg!(debug_assertions))
    }
}

/// Spend one unit of this page's link budget; false when it is exhausted (see [`OPEN_BUDGET`]).
/// The unit that exhausts it reports "and the rest were dropped", so a page firing links in a
/// loop costs one banner, not hundreds — and the drop is still said out loud.
fn spend_open(app: &AppHandle, opens: &AtomicU32, url: &Url) -> bool {
    let n = opens.fetch_add(1, Ordering::Relaxed);
    if n < OPEN_BUDGET {
        return true;
    }
    if n == OPEN_BUDGET {
        eprintln!("artifact host: link budget spent, dropping the rest of this page's links");
        let _ = ArtifactHostEvent {
            kind: ArtifactHostEventKind::OpensThrottled,
            url: url.to_string(),
        }
        .emit(app);
    }
    false
}

/// Hand a web link to the system browser, within this page's budget.
fn hand_off(app: &AppHandle, opens: &AtomicU32, url: &Url) {
    if spend_open(app, opens, url) {
        open_externally(app, url);
    }
}

/// Refuse a link the view can't follow and the OS must not be asked to (a scheme that would
/// launch another app, or a blank pop-up outside a sign-in), and say so — within budget.
fn refuse(app: &AppHandle, opens: &AtomicU32, url: &Url) {
    eprintln!("artifact host: refused {url}");
    if !spend_open(app, opens, url) {
        return;
    }
    let kind = if matches!(url.scheme(), "about" | "blob" | "data") {
        ArtifactHostEventKind::PopupBlankRefused
    } else {
        ArtifactHostEventKind::PopupRefused
    };
    let _ = ArtifactHostEvent { kind, url: url.to_string() }.emit(app);
}

/// Hand a link the page opened in a new window to the system browser. A failure is reported to
/// the front (an app error) — never dropped: the click would otherwise have done nothing at all.
fn open_externally(app: &AppHandle, url: &Url) {
    if let Err(e) = app.opener().open_url(url.as_str(), None::<&str>) {
        eprintln!("artifact host: open {url} in the browser failed: {e}");
        let event = ArtifactHostEvent {
            kind: ArtifactHostEventKind::ExternalOpenFailed,
            url: url.to_string(),
        };
        let _ = event.emit(app);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_both_artifact_url_shapes() {
        assert!(parse_hosted_artifact_url("https://claude.ai/artifact/EB7RRtdoZg1CDk4L3R1Nqg").is_ok());
        assert!(parse_hosted_artifact_url(
            "https://claude.ai/code/artifact/acecfb35-f63b-49c3-b835-d0c856695a94"
        )
        .is_ok());
    }

    #[test]
    fn refuses_anything_but_a_claude_ai_artifact() {
        for bad in [
            "http://claude.ai/artifact/abc",          // not https
            "https://evil.example/artifact/abc",      // another host
            "https://claude.ai.evil.example/artifact/abc",
            "https://claude.ai:8443/artifact/abc",    // explicit port
            "https://claude.ai/artifacts",            // the gallery
            "https://claude.ai/code/artifacts",
            "https://claude.ai/artifact/",            // no id
            "https://claude.ai/artifact/abc/extra",   // deeper path
            "https://claude.ai/new",
            "file:///etc/passwd",
            "tauri://localhost/index.html",
            "not a url",
        ] {
            assert!(parse_hosted_artifact_url(bad).is_err(), "accepted {bad}");
        }
    }

    #[test]
    fn sign_in_popups_stay_in_app_content_links_do_not() {
        let url = |s: &str| Url::parse(s).unwrap();
        assert!(is_sign_in_url(&url("https://claude.ai/login")));
        assert!(is_sign_in_url(&url("https://accounts.google.com/o/oauth2/v2/auth")));
        assert!(is_sign_in_url(&url("https://appleid.apple.com/auth/authorize")));
        assert!(is_sign_in_url(&url("https://console.anthropic.com/")));
        assert!(!is_sign_in_url(&url("https://github.com/anthropics")));
        assert!(!is_sign_in_url(&url("https://notclaude.ai/login")));
        assert!(!is_sign_in_url(&url("http://claude.ai/login")));
        assert!(!is_sign_in_url(&url("about:blank")));
    }

    /// A page the host is on right now.
    fn on(url: &str) -> Option<HostPage> {
        Some(HostPage { url: url.to_string(), at: Instant::now() })
    }

    #[test]
    fn a_popup_stays_in_app_only_while_signing_in() {
        let url = |s: &str| Url::parse(s).unwrap();
        let blank = url("about:blank");
        let google = url("https://accounts.google.com/o/oauth2/v2/auth");
        let login_page = on("https://claude.ai/login?returnTo=%2Fartifact");
        let login = login_page.as_ref();
        // The flow it exists for: the host was redirected to sign in, and the page opens its
        // pop-up (blank first, then the provider).
        assert!(popup_stays_in_app(login, &blank));
        assert!(popup_stays_in_app(login, &google));
        assert!(popup_stays_in_app(on("https://accounts.google.com/signin/v2").as_ref(), &blank));

        // ⚠️ On the ARTIFACT page, a pop-up is the artifact's own doing — it never gets an
        // unfiltered, chrome-less native window, whatever it points at.
        let artifact_page = on("https://claude.ai/artifact/EB7RRtdoZg1CDk4L3R1Nqg");
        let artifact = artifact_page.as_ref();
        assert!(!popup_stays_in_app(artifact, &blank));
        assert!(!popup_stays_in_app(artifact, &google));
        assert!(!popup_stays_in_app(artifact, &url("https://claude.ai/login")));
        // Nor on any other claude.ai page, off-site, an unreadable page, or before anything loads.
        assert!(!popup_stays_in_app(on("https://claude.ai/new").as_ref(), &google));
        assert!(!popup_stays_in_app(on("https://evil.example/anything").as_ref(), &google));
        assert!(!popup_stays_in_app(on("not a url").as_ref(), &blank));
        assert!(!popup_stays_in_app(None, &blank));
        // Even mid-sign-in, a pop-up to something unrelated is not a sign-in window.
        assert!(!popup_stays_in_app(login, &url("https://github.com/anthropics")));
    }

    #[test]
    fn only_real_sign_in_paths_count_as_a_sign_in_page() {
        let page = |s: &str| is_sign_in_page(&Url::parse(s).unwrap());
        assert!(page("https://claude.ai/login"));
        assert!(page("https://claude.ai/magic-link#x"));
        assert!(page("https://accounts.google.com/o/oauth2/v2/auth"));
        assert!(!page("https://claude.ai/artifact/EB7RRtdoZg1CDk4L3R1Nqg"));
        assert!(!page("https://claude.ai/new"));
        assert!(!page("https://claude.ai/loginhelp"));
        assert!(!page("https://evil.example/login"));
    }

    #[test]
    fn only_web_schemes_are_handed_to_the_os() {
        let url = |s: &str| Url::parse(s).unwrap();
        assert!(is_openable_externally(&url("https://example.com/doc")));
        assert!(is_openable_externally(&url("http://example.com/doc")));
        assert!(is_openable_externally(&url("mailto:someone@example.com")));
        // ⚠️ These would make the app launch another handler on a click inside remote content.
        for bad in [
            "smb://attacker.example/share",
            "vscode://ms-vscode.remote/x",
            "ssh://attacker.example",
            "x-apple.systempreferences:com.apple.preference.security",
            "file:///etc/passwd",
            "ftp://example.com",
            "javascript:alert(1)",
        ] {
            assert!(!is_openable_externally(&url(bad)), "would have opened {bad}");
        }
    }

    #[test]
    fn nonsense_bounds_are_refused() {
        let ok = HostBounds { x: 10.0, y: 20.0, width: 300.0, height: 200.0 };
        assert!(ok.to_rect().is_ok());
        assert!(HostBounds { width: f64::NAN, ..ok }.to_rect().is_err());
        assert!(HostBounds { x: f64::INFINITY, ..ok }.to_rect().is_err());
        assert!(HostBounds { height: -1.0, ..ok }.to_rect().is_err());
    }
}
