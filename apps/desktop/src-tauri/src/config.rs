//! Build-time origins. Unset in dev builds, so every networked command fails closed with `not_configured`.
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

/// Parses and checks an origin: https only (http allowed for 127.0.0.1 in debug builds), no path, query or userinfo.
pub fn parse_origin(raw: &str) -> Option<Url> {
    let url = Url::parse(raw).ok()?;
    let local_dev = cfg!(debug_assertions) && url.scheme() == "http" && url.host_str() == Some("127.0.0.1");
    if url.scheme() != "https" && !local_dev {
        return None;
    }
    if url.path() != "/" || url.query().is_some() || url.fragment().is_some() || !url.username().is_empty() {
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
}
