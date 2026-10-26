//! `api_request`: the only way the webview reaches the MeetOps API (ADR-012 Decision 3.3).
//!
//! - Only the configured API origin (`MEETOPS_API_BASE_URL` at build time, default `http://localhost:3000`).
//! - Only GET, POST, PATCH and DELETE, and only relative `/...` paths.
//! - The bearer token lives in Rust state and is never sent back over IPC.
//! - Connect and total timeouts on every request.
//! Errors cross IPC as `{ code, message }` using the contracts' `ApiErrorCode` values.

use std::sync::Mutex;
use std::time::Duration;

use reqwest::{Method, Url};
use serde::Serialize;
use serde_json::Value;

pub const DEFAULT_API_BASE_URL: &str = "http://localhost:3000";
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_PATH_LEN: usize = 2048;

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
        Self { code: code.to_owned(), message: message.into() }
    }
}

/// Shared HTTP client, API origin and the in-memory access token (set by the Rust auth module only).
pub struct ApiState {
    base: Url,
    client: reqwest::Client,
    token: Mutex<Option<String>>,
}

impl ApiState {
    pub fn new(base_url: &str) -> Result<Self, String> {
        let base = parse_base_url(base_url)?;
        let client = reqwest::Client::builder()
            .connect_timeout(CONNECT_TIMEOUT)
            .timeout(REQUEST_TIMEOUT)
            .redirect(reqwest::redirect::Policy::none())
            .https_only(base.scheme() == "https")
            .build()
            .map_err(|e| e.to_string())?;
        Ok(Self { base, client, token: Mutex::new(None) })
    }

    pub fn from_build_env() -> Self {
        let configured = option_env!("MEETOPS_API_BASE_URL").unwrap_or(DEFAULT_API_BASE_URL);
        Self::new(configured)
            .or_else(|_| Self::new(DEFAULT_API_BASE_URL))
            .expect("default API base URL is valid")
    }

    /// Rust-only: the auth module stores/clears the access token here. Not exposed as a command.
    pub fn set_access_token(&self, token: Option<String>) {
        if let Ok(mut slot) = self.token.lock() {
            *slot = token;
        }
    }

    fn access_token(&self) -> Option<String> {
        self.token.lock().ok().and_then(|t| t.clone())
    }
}

pub fn parse_base_url(raw: &str) -> Result<Url, String> {
    let url = Url::parse(raw).map_err(|e| format!("invalid API base URL: {e}"))?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err("API base URL must be http(s) with a host".into());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("API base URL must not contain credentials".into());
    }
    Ok(url)
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

#[tauri::command]
pub async fn api_request(
    state: tauri::State<'_, ApiState>,
    method: String,
    path: String,
    body: Option<Value>,
) -> Result<Value, CommandError> {
    let method = parse_method(&method)?;
    let url = resolve_path(&state.base, &path)?;
    let mut req = state.client.request(method.clone(), url).header("Accept", "application/json");
    if let Some(token) = state.access_token() {
        req = req.bearer_auth(token);
    }
    if let Some(b) = body {
        if method == Method::GET {
            return Err(CommandError::new("BAD_REQUEST", "GET requests cannot have a body."));
        }
        req = req.json(&b);
    }
    let res = req.send().await.map_err(|e| {
        if e.is_timeout() {
            CommandError::new("PROVIDER_UNAVAILABLE", "The server took too long to respond.")
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
    if status.is_success() {
        Ok(json)
    } else {
        Err(error_from_response(status.as_u16(), &json))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn base() -> Url {
        parse_base_url("https://api.meetops.test").unwrap()
    }

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
    fn resolves_relative_paths_on_the_base_origin() {
        let u = resolve_path(&base(), "/v1/meetings/a%2Fb/transcript?cursor=x").unwrap();
        assert_eq!(u.as_str(), "https://api.meetops.test/v1/meetings/a%2Fb/transcript?cursor=x");
        let prefixed = parse_base_url("http://localhost:3000/api/").unwrap();
        assert_eq!(
            resolve_path(&prefixed, "/v1/x").unwrap().as_str(),
            "http://localhost:3000/api/v1/x"
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
            assert_eq!(resolve_path(&base(), p).unwrap_err().code, "BAD_REQUEST", "{p:?}");
        }
    }

    #[test]
    fn rejects_bad_base_urls() {
        assert!(parse_base_url("ftp://x.test").is_err());
        assert!(parse_base_url("https://user:pw@x.test").is_err());
        assert!(parse_base_url("not a url").is_err());
    }

    #[test]
    fn maps_error_responses() {
        assert_eq!(error_from_response(404, &Value::Null).code, "NOT_FOUND");
        assert_eq!(error_from_response(503, &Value::Null).code, "PROVIDER_UNAVAILABLE");
        let e = error_from_response(409, &json!({"error":{"code":"CONFLICT","message":"Taken"}}));
        assert_eq!(e, CommandError::new("CONFLICT", "Taken"));
        let e = error_from_response(400, &json!({"code":"NOPE","message":"x"}));
        assert_eq!(e.code, "BAD_REQUEST");
    }

    #[test]
    fn token_stays_in_state_and_errors_never_carry_it() {
        let s = ApiState::new("http://localhost:3000").unwrap();
        s.set_access_token(Some("secret-token".into()));
        assert_eq!(s.access_token().as_deref(), Some("secret-token"));
        let err = serde_json::to_string(&error_from_response(401, &Value::Null)).unwrap();
        assert!(!err.contains("secret-token"));
        s.set_access_token(None);
        assert!(s.access_token().is_none());
    }

    #[test]
    fn client_has_timeouts() {
        assert!(CONNECT_TIMEOUT <= REQUEST_TIMEOUT);
        assert!(ApiState::new("https://api.meetops.test").is_ok());
    }
}
