//! `api_request`: the only way the webview reaches the MeetOps API (ADR-012 Decision 3.3).
//!
//! - One config source (H-2): the API origin comes from `config::origins()`, the same https origin sign-in uses.
//!   Release builds are https-only (the client refuses plain http); a debug build may use dev localhost.
//! - The bearer is read fresh from `AuthState` on every request (refreshing near expiry). On a 401 the request does
//!   one single-flight refresh and exactly one retry (H-1). The token is never sent back over IPC.
//! - Method + path allowlist (M-1): only the routes the desktop UI uses (`ROUTES`), matched segment by segment.
//! - Connect and total timeouts on every request.
//! Errors cross IPC as `{ code, message }` using the contracts' `ApiErrorCode` values.

use std::time::Duration;

use reqwest::{Method, StatusCode, Url};
use serde::Serialize;
use serde_json::Value;

use crate::auth::AuthState;
use crate::config::{self, Origins};
use crate::error::CmdError;

pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_PATH_LEN: usize = 2048;

/// Allowed `(method, path template)` pairs; `:param` matches one id segment. Mirrors `@meetops/contracts`
/// TASK_PATHS, MEETING_INSIGHTS_PATHS and RECORDING_SESSION_PATHS as used by `src/features/*`.
pub const ROUTES: &[(&str, &str)] = &[
    (
        "GET",
        "/orgs/:organizationId/meetings/:meetingId/transcript",
    ),
    ("GET", "/orgs/:organizationId/meetings/:meetingId/report"),
    ("GET", "/orgs/:organizationId/extracted-tasks"),
    (
        "POST",
        "/orgs/:organizationId/extracted-tasks/:extractedTaskId/accept",
    ),
    (
        "POST",
        "/orgs/:organizationId/extracted-tasks/:extractedTaskId/dismiss",
    ),
    ("PATCH", "/orgs/:organizationId/tasks/:taskId"),
    ("POST", "/orgs/:organizationId/recording-sessions"),
    ("POST", "/recording-sessions/:sessionId/chunks"),
    ("POST", "/recording-sessions/:sessionId/complete"),
    ("POST", "/recording-sessions/:sessionId/abort"),
];

const API_ERROR_CODES: &[&str] = &[
    "BAD_REQUEST",
    "VALIDATION_FAILED",
    "UNAUTHENTICATED",
    "AUTH_FAILED",
    "CSRF_INVALID",
    "FORBIDDEN",
    "NOT_FOUND",
    "CONFLICT",
    "RATE_LIMITED",
    "PROVIDER_UNAVAILABLE",
    "INTERNAL",
];

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CommandError {
    pub code: String,
    pub message: String,
}

impl CommandError {
    fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_owned(),
            message: message.into(),
        }
    }
}

impl From<CmdError> for CommandError {
    fn from(e: CmdError) -> Self {
        Self {
            code: e.code,
            message: e.message,
        }
    }
}

/// Shared HTTP client for API calls. Holds no token and no base URL (both come from auth / config per request).
pub struct ApiState {
    client: reqwest::Client,
}

impl ApiState {
    pub fn new() -> Result<Self, String> {
        let client = reqwest::Client::builder()
            .connect_timeout(CONNECT_TIMEOUT)
            .timeout(REQUEST_TIMEOUT)
            .redirect(reqwest::redirect::Policy::none())
            // Release: never plain http, so the bearer can't leave over cleartext even if config were wrong.
            .https_only(!cfg!(debug_assertions))
            .build()
            .map_err(|e| e.to_string())?;
        Ok(Self { client })
    }
}

fn is_id_segment(seg: &str) -> bool {
    !seg.is_empty()
        && seg.len() <= 128
        && seg
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// M-1: the method + path (without query) must match one `ROUTES` entry.
pub fn route_allowed(method: &Method, path: &str) -> bool {
    let route = path.split('?').next().unwrap_or_default();
    let segs: Vec<&str> = route.split('/').collect();
    ROUTES.iter().any(|(m, tpl)| {
        let t: Vec<&str> = tpl.split('/').collect();
        *m == method.as_str()
            && t.len() == segs.len()
            && t.iter().zip(&segs).all(|(t, s)| {
                if t.starts_with(':') {
                    is_id_segment(s)
                } else {
                    t == s
                }
            })
    })
}

pub fn parse_method(raw: &str) -> Result<Method, CommandError> {
    match raw.to_ascii_uppercase().as_str() {
        "GET" => Ok(Method::GET),
        "POST" => Ok(Method::POST),
        "PATCH" => Ok(Method::PATCH),
        "DELETE" => Ok(Method::DELETE),
        _ => Err(CommandError::new("BAD_REQUEST", "Method not allowed.")),
    }
}

/// Resolves a relative API path against the base URL and refuses anything that leaves its origin.
pub fn resolve_path(base: &Url, path: &str) -> Result<Url, CommandError> {
    let bad = || CommandError::new("BAD_REQUEST", "Path not allowed.");
    if path.len() > MAX_PATH_LEN
        || !path.starts_with('/')
        || path.starts_with("//")
        || path.contains('\\')
        || path.contains('#')
        || path.chars().any(|c| c.is_control() || c.is_whitespace())
        || path.split(['/', '?']).any(|seg| seg == ".." || seg == ".")
    {
        return Err(bad());
    }
    let prefix = base.path().trim_end_matches('/');
    let url = base.join(&format!("{prefix}{path}")).map_err(|_| bad())?;
    if url.origin() != base.origin() || !url.path().starts_with(prefix) {
        return Err(bad());
    }
    Ok(url)
}

pub fn status_code(status: u16) -> &'static str {
    match status {
        400 => "BAD_REQUEST",
        401 => "UNAUTHENTICATED",
        403 => "FORBIDDEN",
        404 => "NOT_FOUND",
        409 => "CONFLICT",
        422 => "VALIDATION_FAILED",
        429 => "RATE_LIMITED",
        502..=504 => "PROVIDER_UNAVAILABLE",
        _ => "INTERNAL",
    }
}

/// Maps an error response, keeping the API's own `{ code, message }` (or `{ error: {...} }`) when valid.
pub fn error_from_response(status: u16, body: &Value) -> CommandError {
    let obj = body.get("error").filter(|e| e.is_object()).unwrap_or(body);
    let code = obj
        .get("code")
        .and_then(Value::as_str)
        .filter(|c| API_ERROR_CODES.contains(c))
        .unwrap_or_else(|| status_code(status));
    let message = obj
        .get("message")
        .and_then(Value::as_str)
        .map(|m| m.chars().take(500).collect::<String>())
        .unwrap_or_else(|| format!("Request failed ({status})."));
    CommandError::new(code, message)
}

async fn send_once(
    api: &ApiState,
    method: &Method,
    url: &Url,
    token: &str,
    body: Option<&Value>,
) -> Result<(StatusCode, Value), CommandError> {
    let mut req = api
        .client
        .request(method.clone(), url.clone())
        .header("Accept", "application/json")
        .bearer_auth(token);
    if let Some(b) = body {
        req = req.json(b);
    }
    let res = req.send().await.map_err(|e| {
        if e.is_timeout() {
            CommandError::new(
                "PROVIDER_UNAVAILABLE",
                "The server took too long to respond.",
            )
        } else {
            CommandError::new("PROVIDER_UNAVAILABLE", "Could not reach the server.")
        }
    })?;
    let status = res.status();
    let bytes = res
        .bytes()
        .await
        .map_err(|_| CommandError::new("PROVIDER_UNAVAILABLE", "The response was interrupted."))?;
    let json: Value = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes).unwrap_or(Value::Null)
    };
    Ok((status, json))
}

/// Core of `api_request`, testable without a running app.
pub async fn request(
    api: &ApiState,
    auth: &AuthState,
    o: &Origins,
    method: &str,
    path: &str,
    body: Option<Value>,
) -> Result<Value, CommandError> {
    let method = parse_method(method)?;
    if body.is_some() && method == Method::GET {
        return Err(CommandError::new(
            "BAD_REQUEST",
            "GET requests cannot have a body.",
        ));
    }
    let url = resolve_path(&o.api, path)?;
    if !route_allowed(&method, path) {
        return Err(CommandError::new(
            "FORBIDDEN",
            "That API route isn't allowed from the desktop app.",
        ));
    }
    let token = auth.bearer(o, false).await?;
    let (mut status, mut json) = send_once(api, &method, &url, &token, body.as_ref()).await?;
    if status == StatusCode::UNAUTHORIZED {
        let fresh = auth.bearer_after_unauthorized(o, &token).await?;
        (status, json) = send_once(api, &method, &url, &fresh, body.as_ref()).await?;
    }
    if status.is_success() {
        Ok(json)
    } else {
        Err(error_from_response(status.as_u16(), &json))
    }
}

#[tauri::command]
pub async fn api_request(
    api: tauri::State<'_, ApiState>,
    auth: tauri::State<'_, AuthState>,
    method: String,
    path: String,
    body: Option<Value>,
) -> Result<Value, CommandError> {
    let o = config::origins()?;
    request(&api, &auth, &o, &method, &path, body).await
}

#[cfg(test)]
pub(crate) mod test_server {
    //! Minimal HTTP/1.1 server on 127.0.0.1 for request-flow tests (no extra crates under --locked).
    use std::io::{BufRead, BufReader, Read, Write};
    use std::net::TcpListener;
    use std::sync::{Arc, Mutex};

    #[derive(Debug, Clone)]
    pub struct Seen {
        pub method: String,
        pub path: String,
        pub authorization: Option<String>,
        pub body: String,
    }

    /// Serves `n` requests; `reply(seen) -> (status, json)`.
    pub fn serve(
        n: usize,
        reply: impl Fn(&Seen) -> (u16, String) + Send + 'static,
    ) -> (String, Arc<Mutex<Vec<Seen>>>) {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let origin = format!("http://127.0.0.1:{}", l.local_addr().unwrap().port());
        let log = Arc::new(Mutex::new(Vec::new()));
        let log2 = log.clone();
        std::thread::spawn(move || {
            for stream in l.incoming().take(n) {
                let mut stream = stream.unwrap();
                let mut r = BufReader::new(stream.try_clone().unwrap());
                let mut line = String::new();
                r.read_line(&mut line).unwrap();
                let mut parts = line.split_whitespace();
                let (method, path) = (
                    parts.next().unwrap().to_owned(),
                    parts.next().unwrap().to_owned(),
                );
                let (mut auth, mut len) = (None, 0usize);
                loop {
                    let mut h = String::new();
                    r.read_line(&mut h).unwrap();
                    let h = h.trim_end();
                    if h.is_empty() {
                        break;
                    }
                    let (k, v) = h.split_once(':').unwrap();
                    match k.to_ascii_lowercase().as_str() {
                        "authorization" => auth = Some(v.trim().to_owned()),
                        "content-length" => len = v.trim().parse().unwrap(),
                        _ => {}
                    }
                }
                let mut body = vec![0u8; len];
                r.read_exact(&mut body).unwrap();
                let seen = Seen {
                    method,
                    path,
                    authorization: auth,
                    body: String::from_utf8(body).unwrap(),
                };
                let (status, json) = reply(&seen);
                log2.lock().unwrap().push(seen);
                let _ = write!(
                    stream,
                    "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{json}",
                    json.len()
                );
            }
        });
        (origin, log)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::keychain::{MemoryStore, SecretStore};
    use serde_json::json;
    use std::sync::Arc;

    fn parse_base_url(raw: &str) -> Result<Url, String> {
        config::parse_origin(raw).ok_or_else(|| "API origin must be a bare https origin".into())
    }

    fn base() -> Url {
        parse_base_url("https://api.meetops.test").unwrap()
    }

    const ORG: &str = "00000000-0000-4000-8000-000000000001";

    #[test]
    fn allows_only_four_methods() {
        for m in ["GET", "post", "PATCH", "DELETE"] {
            assert!(parse_method(m).is_ok(), "{m}");
        }
        for m in ["PUT", "HEAD", "OPTIONS", "TRACE", "CONNECT", ""] {
            assert_eq!(parse_method(m).unwrap_err().code, "BAD_REQUEST", "{m}");
        }
    }

    #[test]
    fn route_allowlist_matches_method_and_shape() {
        let ok = [
            (Method::GET, format!("/orgs/{ORG}/meetings/m-1/transcript")),
            (Method::GET, format!("/orgs/{ORG}/extracted-tasks?limit=50")),
            (
                Method::POST,
                format!("/orgs/{ORG}/extracted-tasks/t1/accept"),
            ),
            (Method::PATCH, format!("/orgs/{ORG}/tasks/t1")),
            (Method::POST, "/recording-sessions/s1/chunks".to_owned()),
        ];
        for (m, p) in &ok {
            assert!(route_allowed(m, p), "{m} {p}");
        }
        let bad = [
            (Method::DELETE, format!("/orgs/{ORG}/tasks/t1")),
            (Method::GET, format!("/orgs/{ORG}/tasks/t1")),
            (Method::POST, "/auth/desktop/refresh".to_owned()),
            (Method::GET, "/admin".to_owned()),
            (
                Method::GET,
                format!("/orgs/{ORG}/meetings/a%2Fb/transcript"),
            ),
            (Method::GET, format!("/orgs/{ORG}/meetings//transcript")),
            (
                Method::GET,
                format!("/orgs/{ORG}/meetings/m/transcript/extra"),
            ),
        ];
        for (m, p) in &bad {
            assert!(!route_allowed(m, p), "{m} {p}");
        }
    }

    #[test]
    fn resolves_relative_paths_on_the_base_origin() {
        let u = resolve_path(&base(), "/orgs/o/meetings/m/transcript?cursor=x").unwrap();
        assert_eq!(
            u.as_str(),
            "https://api.meetops.test/orgs/o/meetings/m/transcript?cursor=x"
        );
    }

    #[test]
    fn refuses_paths_that_could_leave_the_origin() {
        for p in [
            "https://evil.test/x",
            "//evil.test/x",
            "v1/x",
            "/\\evil.test",
            "/v1/../admin",
            "/v1/./x",
            "/v1/x#frag",
            "/v1/x y",
            "/v1/\nx",
            "",
        ] {
            assert_eq!(
                resolve_path(&base(), p).unwrap_err().code,
                "BAD_REQUEST",
                "{p:?}"
            );
        }
    }

    #[test]
    fn rejects_bad_or_cleartext_base_urls() {
        assert!(parse_base_url("ftp://x.test").is_err());
        assert!(parse_base_url("https://user:pw@x.test").is_err());
        assert!(parse_base_url("not a url").is_err());
        assert!(parse_base_url("http://api.meetops.test").is_err());
        assert!(parse_base_url("https://api.meetops.test/api").is_err());
    }

    #[test]
    fn maps_error_responses() {
        assert_eq!(error_from_response(404, &Value::Null).code, "NOT_FOUND");
        assert_eq!(
            error_from_response(503, &Value::Null).code,
            "PROVIDER_UNAVAILABLE"
        );
        let e = error_from_response(409, &json!({"error":{"code":"CONFLICT","message":"Taken"}}));
        assert_eq!(e, CommandError::new("CONFLICT", "Taken"));
        let e = error_from_response(400, &json!({"code":"NOPE","message":"x"}));
        assert_eq!(e.code, "BAD_REQUEST");
    }

    #[test]
    fn client_has_timeouts() {
        assert!(CONNECT_TIMEOUT <= REQUEST_TIMEOUT);
        assert!(ApiState::new().is_ok());
    }

    fn origins(api: &str) -> Origins {
        Origins {
            api: Url::parse(api).unwrap(),
            web: Url::parse("https://app.meetops.test").unwrap(),
        }
    }

    fn tokens(n: u32) -> String {
        json!({"accessToken": format!("access-{n}"), "refreshToken": format!("refresh-{n}"), "expiresIn": 900, "session": {}})
            .to_string()
    }

    #[test]
    fn h1_on_401_refreshes_once_and_retries_once_with_the_fresh_token() {
        let (origin, log) = test_server::serve(3, |s| match s.path.as_str() {
            "/auth/desktop/refresh" => (200, tokens(2)),
            _ if s.authorization.as_deref() == Some("Bearer access-2") => {
                (200, "{\"ok\":true}".into())
            }
            _ => (401, "{}".into()),
        });
        let o = origins(&origin);
        let store = Arc::new(MemoryStore::default());
        store.set(crate::config::REFRESH_ACCOUNT, "refresh-1");
        let auth = AuthState::new(store.clone());
        let api = ApiState::new().unwrap();
        let path = format!("/orgs/{ORG}/extracted-tasks?limit=50");
        let out = tauri::async_runtime::block_on(async {
            auth.seed_access_for_test("access-1", Duration::from_secs(900))
                .await;
            request(&api, &auth, &o, "GET", &path, None).await
        });
        assert_eq!(out.unwrap(), json!({"ok": true}));
        let log = log.lock().unwrap();
        let seq: Vec<_> = log
            .iter()
            .map(|s| (s.path.as_str(), s.authorization.clone()))
            .collect();
        assert_eq!(seq.len(), 3);
        assert_eq!(seq[0].1.as_deref(), Some("Bearer access-1"));
        assert_eq!(log[0].method, "GET");
        assert_eq!(seq[1].0, "/auth/desktop/refresh");
        assert!(log[1].body.contains("refresh-1"));
        assert_eq!(seq[2].1.as_deref(), Some("Bearer access-2"));
        assert_eq!(
            store.get(crate::config::REFRESH_ACCOUNT).as_deref(),
            Some("refresh-2")
        );
    }

    #[test]
    fn h1_a_second_401_is_returned_without_another_refresh() {
        let (origin, log) = test_server::serve(3, |s| match s.path.as_str() {
            "/auth/desktop/refresh" => (200, tokens(2)),
            _ => (
                401,
                "{\"error\":{\"code\":\"UNAUTHENTICATED\",\"message\":\"no\"}}".into(),
            ),
        });
        let o = origins(&origin);
        let store = Arc::new(MemoryStore::default());
        store.set(crate::config::REFRESH_ACCOUNT, "refresh-1");
        let auth = AuthState::new(store);
        let api = ApiState::new().unwrap();
        let path = format!("/orgs/{ORG}/tasks/t1");
        let err = tauri::async_runtime::block_on(async {
            auth.seed_access_for_test("access-1", Duration::from_secs(900))
                .await;
            request(&api, &auth, &o, "PATCH", &path, Some(json!({"title": "x"}))).await
        })
        .unwrap_err();
        assert_eq!(err.code, "UNAUTHENTICATED");
        assert_eq!(log.lock().unwrap().len(), 3);
    }

    #[test]
    fn h1_reads_a_fresh_token_per_request_and_refreshes_near_expiry() {
        let (origin, log) = test_server::serve(2, |s| match s.path.as_str() {
            "/auth/desktop/refresh" => (200, tokens(7)),
            _ => (200, "null".into()),
        });
        let o = origins(&origin);
        let store = Arc::new(MemoryStore::default());
        store.set(crate::config::REFRESH_ACCOUNT, "refresh-6");
        let auth = AuthState::new(store);
        let api = ApiState::new().unwrap();
        tauri::async_runtime::block_on(async {
            auth.seed_access_for_test("access-6", Duration::from_secs(5))
                .await;
            request(
                &api,
                &auth,
                &o,
                "POST",
                "/recording-sessions/s1/complete",
                Some(json!({})),
            )
            .await
        })
        .unwrap();
        let log = log.lock().unwrap();
        assert_eq!(log[0].path, "/auth/desktop/refresh");
        assert_eq!(log[1].authorization.as_deref(), Some("Bearer access-7"));
    }

    #[test]
    fn m1_disallowed_routes_never_reach_the_network_or_auth() {
        let auth = AuthState::new(Arc::new(MemoryStore::default()));
        let api = ApiState::new().unwrap();
        let o = origins("https://api.meetops.test");
        let err = tauri::async_runtime::block_on(request(
            &api,
            &auth,
            &o,
            "DELETE",
            "/orgs/o/tasks/t",
            None,
        ))
        .unwrap_err();
        assert_eq!(err.code, "FORBIDDEN");
        let err =
            tauri::async_runtime::block_on(request(&api, &auth, &o, "GET", "/auth/session", None))
                .unwrap_err();
        assert_eq!(err.code, "FORBIDDEN");
    }

    #[test]
    fn errors_never_carry_the_token() {
        let err = serde_json::to_string(&error_from_response(401, &Value::Null)).unwrap();
        assert!(!err.contains("access-"));
    }
}
