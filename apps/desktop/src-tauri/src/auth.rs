//! ADR-012 Option A: system-browser sign-in with PKCE and a loopback redirect. Tokens stay in Rust: the refresh token
//! in the keychain, the access token in memory. The webview only ever sees the token-free session.
//! DECISION: ADR-012 is still Proposed (Architecture + Security sign-off), and the `/auth/desktop/*` routes and the
//! token response shape below are not in contracts yet.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::Mutex;
use url::Url;

use crate::config::{self, Origins, DEVICE_ID_ACCOUNT, REFRESH_ACCOUNT};
use crate::error::{CmdError, CmdResult};
use crate::keychain::SecretStore;
use crate::loopback::{Loopback, TIMEOUT};
use crate::pkce::{ct_eq, new_pkce, random_b64};

/// Refresh this long before the access token expires (ADR-012 4.1).
const REFRESH_SKEW: Duration = Duration::from_secs(60);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenResponse {
    pub access_token: String,
    pub refresh_token: String,
    pub expires_in: u64,
    /// Token-free `GetAuthSessionResponse`.
    pub session: Value,
}

struct Access {
    token: String,
    expires_at: Instant,
}

pub struct AuthState {
    pub store: Arc<dyn SecretStore>,
    pub http: reqwest::Client,
    /// One refresh at a time (ADR-012 4.1): the lock covers both the access token and the refresh call.
    access: Mutex<Option<Access>>,
    session: std::sync::Mutex<Option<Value>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TokenRequest<'a> {
    code: &'a str,
    code_verifier: &'a str,
    redirect_uri: &'a str,
    device_id: &'a str,
}

pub fn authorize_url(web: &Url, state: &str, challenge: &str, redirect_uri: &str, device_id: &str) -> Url {
    let mut url = web.join("/desktop/authorize").expect("static path");
    url.query_pairs_mut()
        .append_pair("state", state)
        .append_pair("code_challenge", challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("redirect_uri", redirect_uri)
        .append_pair("device_id", device_id)
        .append_pair("device_label", &device_label());
    url
}

fn device_label() -> String {
    format!("MeetOps desktop ({})", std::env::consts::OS)
}

/// Maps an API error body `{ error: { code, message } }` to a `CmdError`, without echoing anything else.
pub async fn api_error(res: reqwest::Response) -> CmdError {
    let status = res.status();
    let body: Value = res.json().await.unwrap_or(Value::Null);
    let code = body["error"]["code"].as_str().unwrap_or(match status.as_u16() {
        401 => "UNAUTHENTICATED",
        403 => "FORBIDDEN",
        404 => "NOT_FOUND",
        429 => "RATE_LIMITED",
        _ => "INTERNAL",
    });
    let message = body["error"]["message"].as_str().unwrap_or("Request failed.");
    CmdError::new(code, message)
}

impl AuthState {
    pub fn new(store: Arc<dyn SecretStore>) -> Self {
        let http = reqwest::Client::builder()
            .https_only(!cfg!(debug_assertions))
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(30))
            .build()
            .expect("http client");
        Self { store, http, access: Mutex::new(None), session: std::sync::Mutex::new(None) }
    }

    pub fn device_id(&self) -> String {
        if let Some(id) = self.store.get(DEVICE_ID_ACCOUNT) {
            return id;
        }
        let id = uuid::Uuid::new_v4().to_string();
        self.store.set(DEVICE_ID_ACCOUNT, &id);
        id
    }

    fn keep(&self, access: &mut Option<Access>, t: TokenResponse) -> Value {
        self.store.set(REFRESH_ACCOUNT, &t.refresh_token);
        *access = Some(Access { token: t.access_token, expires_at: Instant::now() + Duration::from_secs(t.expires_in) });
        *self.session.lock().unwrap() = Some(t.session.clone());
        t.session
    }

    fn forget(&self, access: &mut Option<Access>) {
        self.store.delete(REFRESH_ACCOUNT);
        *access = None;
        *self.session.lock().unwrap() = None;
    }

    pub async fn finish_sign_in(&self, o: &Origins, code: &str, verifier: &str, redirect_uri: &str) -> CmdResult<Value> {
        let device_id = self.device_id();
        let res = self
            .http
            .post(o.api.join("/auth/desktop/token").unwrap())
            .json(&TokenRequest { code, code_verifier: verifier, redirect_uri, device_id: &device_id })
            .send()
            .await
            .map_err(|_| CmdError::network())?;
        if !res.status().is_success() {
            return Err(api_error(res).await);
        }
        let t: TokenResponse = res.json().await.map_err(|_| CmdError::internal())?;
        let mut access = self.access.lock().await;
        Ok(self.keep(&mut access, t))
    }

    /// Rotates the refresh token. A 401 means the family is gone: wipe it and require sign-in.
    async fn refresh_locked(&self, o: &Origins, access: &mut Option<Access>) -> CmdResult<Value> {
        let Some(refresh) = self.store.get(REFRESH_ACCOUNT) else {
            return Err(CmdError::unauthenticated());
        };
        let res = self
            .http
            .post(o.api.join("/auth/desktop/refresh").unwrap())
            .json(&json!({ "refreshToken": refresh, "deviceId": self.device_id() }))
            .send()
            .await
            .map_err(|_| CmdError::network())?;
        if res.status() == reqwest::StatusCode::UNAUTHORIZED {
            self.forget(access);
            return Err(CmdError::unauthenticated());
        }
        if !res.status().is_success() {
            return Err(api_error(res).await);
        }
        let t: TokenResponse = res.json().await.map_err(|_| CmdError::internal())?;
        Ok(self.keep(access, t))
    }

    /// A valid access token, refreshing first if it expires within `REFRESH_SKEW` or `force` is set (after a 401).
    pub async fn bearer(&self, o: &Origins, force: bool) -> CmdResult<String> {
        let mut access = self.access.lock().await;
        let fresh = access.as_ref().filter(|a| !force && a.expires_at > Instant::now() + REFRESH_SKEW);
        if let Some(a) = fresh {
            return Ok(a.token.clone());
        }
        self.refresh_locked(o, &mut access).await?;
        access.as_ref().map(|a| a.token.clone()).ok_or_else(CmdError::unauthenticated)
    }

    /// After the API answered 401 to `stale`: single-flight refresh (H-1). If another request already rotated the
    /// token while we waited for the lock, reuse that token instead of rotating again (a second rotation of the same
    /// refresh token would look like reuse and revoke the family).
    pub async fn bearer_after_unauthorized(&self, o: &Origins, stale: &str) -> CmdResult<String> {
        let mut access = self.access.lock().await;
        if let Some(a) = access.as_ref() {
            if a.token != stale && a.expires_at > Instant::now() + REFRESH_SKEW {
                return Ok(a.token.clone());
            }
        }
        self.refresh_locked(o, &mut access).await?;
        access.as_ref().map(|a| a.token.clone()).ok_or_else(CmdError::unauthenticated)
    }

    #[cfg(test)]
    pub async fn seed_access_for_test(&self, token: &str, ttl: Duration) {
        *self.access.lock().await = Some(Access { token: token.into(), expires_at: Instant::now() + ttl });
    }

    pub async fn session(&self, o: &Origins) -> CmdResult<Option<Value>> {
        if let Some(s) = self.session.lock().unwrap().clone() {
            return Ok(Some(s));
        }
        if self.store.get(REFRESH_ACCOUNT).is_none() {
            return Ok(None);
        }
        let mut access = self.access.lock().await;
        match self.refresh_locked(o, &mut access).await {
            Ok(s) => Ok(Some(s)),
            Err(e) if e.code == "UNAUTHENTICATED" => Ok(None),
            Err(e) => Err(e),
        }
    }

    /// Best-effort revoke, then always delete local state (ADR-012 4.2).
    pub async fn sign_out(&self, o: Option<&Origins>) {
        let mut access = self.access.lock().await;
        if let (Some(o), Some(refresh)) = (o, self.store.get(REFRESH_ACCOUNT)) {
            let _ = self
                .http
                .post(o.api.join("/auth/desktop/revoke").unwrap())
                .json(&json!({ "refreshToken": refresh, "deviceId": self.device_id() }))
                .send()
                .await;
        }
        self.forget(&mut access);
    }
}

/// Hands the authorize URL to the OS default browser. Uses the platform launcher directly (no shell, the URL is a
/// single argv entry) rather than tauri-plugin-opener, whose build deps would bump the locked tauri-utils tree.
fn open_browser(url: &Url) -> std::io::Result<()> {
    use std::process::{Command, Stdio};
    debug_assert!(url.scheme() == "https" || url.scheme() == "http");
    #[cfg(target_os = "macos")]
    let mut cmd = Command::new("open");
    #[cfg(target_os = "windows")]
    let mut cmd = {
        let mut c = Command::new("rundll32");
        c.arg("url.dll,FileProtocolHandler");
        c
    };
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut cmd = Command::new("xdg-open");
    cmd.arg(url.as_str()).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().map(|_| ())
}

/// Only one browser sign-in at a time (single use loopback, Low): a second call fails instead of opening another
/// listener and browser tab.
static SIGN_IN_ACTIVE: AtomicBool = AtomicBool::new(false);

struct SignInGuard;

impl SignInGuard {
    fn acquire() -> CmdResult<Self> {
        SIGN_IN_ACTIVE
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map(|_| SignInGuard)
            .map_err(|_| CmdError::new("CONFLICT", "Sign-in is already in progress."))
    }
}

impl Drop for SignInGuard {
    fn drop(&mut self) {
        SIGN_IN_ACTIVE.store(false, Ordering::Release);
    }
}

/// Runs the full browser flow.
pub async fn sign_in(state: &AuthState) -> CmdResult<Value> {
    let _guard = SignInGuard::acquire()?;
    let o = config::origins()?;
    let lb = Loopback::bind()?;
    let redirect_uri = lb.redirect_uri();
    let pkce = new_pkce();
    let expected_state = random_b64(32);
    let url = authorize_url(&o.web, &expected_state, &pkce.challenge, &redirect_uri, &state.device_id());
    open_browser(&url).map_err(|_| CmdError::new("SERVICE_UNAVAILABLE", "Couldn't open your browser."))?;
    let cb = tauri::async_runtime::spawn_blocking(move || lb.wait(TIMEOUT))
        .await
        .map_err(|_| CmdError::internal())??;
    let state_ok = cb.state.as_deref().is_some_and(|s| ct_eq(s, &expected_state));
    if !state_ok {
        return Err(CmdError::new("UNAUTHENTICATED", "Sign-in didn't match this request. Try again."));
    }
    if cb.error.is_some() {
        return Err(CmdError::new("UNAUTHENTICATED", "Sign-in was cancelled."));
    }
    let code = cb.code.ok_or_else(CmdError::unauthenticated)?;
    state.finish_sign_in(&o, &code, &pkce.verifier, &redirect_uri).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn authorize_url_carries_pkce_and_loopback_redirect() {
        let web = Url::parse("https://app.example.test").unwrap();
        let url = authorize_url(&web, "st", "ch", "http://127.0.0.1:5000/callback", "dev-1");
        assert_eq!(url.path(), "/desktop/authorize");
        let q: std::collections::HashMap<_, _> = url.query_pairs().into_owned().collect();
        assert_eq!(q["state"], "st");
        assert_eq!(q["code_challenge"], "ch");
        assert_eq!(q["code_challenge_method"], "S256");
        assert_eq!(q["redirect_uri"], "http://127.0.0.1:5000/callback");
        assert_eq!(q["device_id"], "dev-1");
    }

    #[test]
    fn device_id_is_stable_per_store() {
        let s = AuthState::new(Arc::new(crate::keychain::MemoryStore::default()));
        assert_eq!(s.device_id(), s.device_id());
    }
}
