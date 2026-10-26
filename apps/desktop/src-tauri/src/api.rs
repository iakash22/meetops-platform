//! `api_request` and `upload_put` (ADR-012 3.3): the webview names a scoped route; Rust adds the bearer and talks
//! only to the configured API origin. Presigned uploads go straight to storage with the signed headers verbatim and
//! no bearer.

use std::collections::HashMap;

use serde::Deserialize;
use serde_json::Value;

use crate::auth::{api_error, AuthState};
use crate::config::Origins;
use crate::error::{CmdError, CmdResult};

/// Route prefixes the desktop scopes cover (`meetings:read`, `meetings:resolve`, `recordings:write`).
const ALLOWED_PREFIXES: &[&str] = &["/orgs/", "/recording-sessions/", "/meetings/resolve"];

pub fn check_route(method: &str, path: &str) -> CmdResult<reqwest::Method> {
    let method = match method {
        "GET" => reqwest::Method::GET,
        "POST" => reqwest::Method::POST,
        "PATCH" => reqwest::Method::PATCH,
        "DELETE" => reqwest::Method::DELETE,
        _ => return Err(CmdError::validation("Unsupported method.")),
    };
    let clean = path.starts_with('/')
        && !path.contains("//")
        && !path.contains("..")
        && !path.contains('\\')
        && !path.contains('?')
        && !path.contains('#')
        && !path.contains('@')
        && ALLOWED_PREFIXES.iter().any(|p| path.starts_with(p));
    if !clean || path.starts_with("/auth/") {
        return Err(CmdError::validation("That route isn't available to the desktop app."));
    }
    Ok(method)
}

pub async fn request(state: &AuthState, o: &Origins, method: &str, path: &str, body: Option<Value>) -> CmdResult<Value> {
    let method = check_route(method, path)?;
    let url = o.api.join(path).map_err(|_| CmdError::validation("Bad route."))?;
    if url.origin() != o.api.origin() {
        return Err(CmdError::validation("Bad route."));
    }
    for attempt in 0..2 {
        let token = state.bearer(o, attempt > 0).await?;
        let mut req = state.http.request(method.clone(), url.clone()).bearer_auth(token);
        if let Some(b) = &body {
            req = req.json(b);
        }
        let res = req.send().await.map_err(|_| CmdError::network())?;
        if res.status() == reqwest::StatusCode::UNAUTHORIZED && attempt == 0 {
            continue;
        }
        if !res.status().is_success() {
            return Err(api_error(res).await);
        }
        if res.status() == reqwest::StatusCode::NO_CONTENT {
            return Ok(Value::Null);
        }
        return res.json().await.or(Ok(Value::Null));
    }
    Err(CmdError::unauthenticated())
}

#[derive(Debug, Deserialize)]
pub struct PresignedPut {
    pub url: String,
    pub method: String,
    #[serde(default)]
    pub headers: HashMap<String, String>,
}

pub fn check_upload(upload: &PresignedPut) -> CmdResult<url::Url> {
    if upload.method != "PUT" {
        return Err(CmdError::validation("Only presigned PUT uploads are supported."));
    }
    let url = url::Url::parse(&upload.url).map_err(|_| CmdError::validation("Bad upload URL."))?;
    if url.scheme() != "https" || !url.username().is_empty() {
        return Err(CmdError::validation("Refusing a non-TLS upload URL."));
    }
    if upload.headers.keys().any(|k| k.eq_ignore_ascii_case("authorization")) {
        return Err(CmdError::validation("Upload headers can't carry credentials."));
    }
    Ok(url)
}

pub async fn upload_put(http: &reqwest::Client, upload: PresignedPut, body: Vec<u8>) -> CmdResult<()> {
    let url = check_upload(&upload)?;
    let mut req = http.put(url).body(body);
    for (k, v) in &upload.headers {
        req = req.header(k, v);
    }
    let res = req.send().await.map_err(|_| CmdError::network())?;
    if res.status().is_success() {
        Ok(())
    } else {
        Err(CmdError::new("SERVICE_UNAVAILABLE", "The upload was rejected. It will retry."))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_scoped_routes_pass() {
        assert!(check_route("POST", "/orgs/o1/recording-sessions").is_ok());
        assert!(check_route("POST", "/recording-sessions/s1/chunks").is_ok());
        assert!(check_route("GET", "/orgs/o1/meetings").is_ok());
        assert!(check_route("POST", "/auth/desktop/token").is_err());
        assert!(check_route("GET", "//evil.test/x").is_err());
        assert!(check_route("GET", "/orgs/../auth/me").is_err());
        assert!(check_route("GET", "/orgs/o1?token=x").is_err());
        assert!(check_route("PUT", "/orgs/o1").is_err());
        assert!(check_route("GET", "https://evil.test/orgs/").is_err());
    }

    #[test]
    fn uploads_must_be_tls_put_without_credentials() {
        let mk = |url: &str, method: &str, h: &[(&str, &str)]| PresignedPut {
            url: url.into(),
            method: method.into(),
            headers: h.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(),
        };
        assert!(check_upload(&mk("https://s3.test/k?sig=1", "PUT", &[("content-type", "audio/webm")])).is_ok());
        assert!(check_upload(&mk("http://s3.test/k", "PUT", &[])).is_err());
        assert!(check_upload(&mk("https://s3.test/k", "POST", &[])).is_err());
        assert!(check_upload(&mk("https://s3.test/k", "PUT", &[("Authorization", "x")])).is_err());
    }
}
