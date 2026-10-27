//! Build-time origins: the single config source for sign-in, `api_request` and `upload_put` (H-2).
//! Unset → every networked command fails closed with `not_configured`.
//! - `MEETOPS_API_ORIGIN`, `MEETOPS_WEB_ORIGIN`: https only. A debug build (never release) may use
//!   `http://127.0.0.1:<port>` or `http://localhost:<port>` for local dev.
//! - `MEETOPS_STORAGE_ORIGIN`: the presigned-upload storage origin; https only, in every build.
//!
//! DECISION: final API/web origins and the bundle identifier are still TODO-owner placeholders (ADR-012).

use url::Url;

use crate::error::{CmdError, CmdResult};

pub const KEYCHAIN_SERVICE: &str = "ai.meetops.desktop.todo-owner.auth";
pub const CHUNK_KEY_ACCOUNT: &str = "offline-chunk-key.v1";
pub const DEVICE_ID_ACCOUNT: &str = "device-id.v1";
pub const REFRESH_ACCOUNT: &str = "refresh-token.v1";

#[derive(Debug, Clone)]
pub struct Origins {
    pub api: Url,
    pub web: Url,
}

/// Same as `parse_origin_for`, with the dev exception only in debug builds.
pub fn parse_origin(raw: &str) -> Option<Url> {
    parse_origin_for(raw, cfg!(debug_assertions))
}

/// A bare origin: https (or, when `allow_dev_http`, plain http on localhost / 127.0.0.1 with an explicit port),
/// no path, query, fragment or userinfo.
pub fn parse_origin_for(raw: &str, allow_dev_http: bool) -> Option<Url> {
    let url = Url::parse(raw).ok()?;
    let local_dev = allow_dev_http
        && url.scheme() == "http"
        && matches!(url.host_str(), Some("127.0.0.1" | "localhost"))
        && url.port().is_some();
    if url.scheme() != "https" && !local_dev {
        return None;
    }
    if url.host_str().is_none()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return None;
    }
    Some(url)
}

pub fn origins() -> CmdResult<Origins> {
    let api = option_env!("MEETOPS_API_ORIGIN").and_then(parse_origin);
    let web = option_env!("MEETOPS_WEB_ORIGIN").and_then(parse_origin);
    match (api, web) {
        (Some(api), Some(web)) => Ok(Origins { api, web }),
        _ => Err(CmdError::not_configured()),
    }
}

/// Storage origin for presigned uploads (M-2). https only, even in debug builds.
pub fn storage_origin() -> CmdResult<Url> {
    option_env!("MEETOPS_STORAGE_ORIGIN")
        .and_then(|raw| parse_origin_for(raw, false))
        .ok_or_else(CmdError::not_configured)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_bare_https_origins_only() {
        assert!(parse_origin("https://api.example.test").is_some());
        assert!(parse_origin("http://api.example.test").is_none());
        assert!(parse_origin("https://api.example.test/v1").is_none());
        assert!(parse_origin("https://u:p@api.example.test").is_none());
        assert!(parse_origin("https://api.example.test/?x=1").is_none());
    }

    #[test]
    fn plain_http_only_for_explicit_dev_localhost() {
        assert!(parse_origin_for("http://127.0.0.1:3000", true).is_some());
        assert!(parse_origin_for("http://localhost:3000", true).is_some());
        assert!(parse_origin_for("http://localhost", true).is_none());
        assert!(parse_origin_for("http://10.0.0.5:3000", true).is_none());
        assert!(parse_origin_for("http://localhost.evil.test:3000", true).is_none());
        // Release builds: never plain http.
        assert!(parse_origin_for("http://127.0.0.1:3000", false).is_none());
        assert!(parse_origin_for("http://localhost:3000", false).is_none());
    }
}
