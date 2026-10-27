//! `upload_put` (ADR-012 3.3): presigned uploads go straight to storage with the signed headers and no bearer.
//! M-2: TLS PUT only, only to the configured storage origin (`config::storage_origin`), and only allowlisted headers.
//! Authenticated API calls use `api_request` (api.rs).

use std::collections::HashMap;

use serde::Deserialize;

use crate::error::{CmdError, CmdResult};

#[derive(Debug, Deserialize)]
pub struct PresignedPut {
    pub url: String,
    pub method: String,
    #[serde(default)]
    pub headers: HashMap<String, String>,
}

/// Headers a presigned PUT may carry (lowercase). Anything else, including `authorization`, `cookie`, `host` and
/// hop-by-hop headers, is refused.
pub const ALLOWED_HEADERS: &[&str] = &[
    "content-type",
    "content-md5",
    "x-amz-checksum-crc32",
    "x-amz-checksum-crc32c",
    "x-amz-checksum-sha256",
    "x-amz-content-sha256",
    "x-amz-server-side-encryption",
    "x-goog-content-sha256",
];

pub fn check_upload(upload: &PresignedPut, storage: &url::Url) -> CmdResult<url::Url> {
    if upload.method != "PUT" {
        return Err(CmdError::validation("Only presigned PUT uploads are supported."));
    }
    let url = url::Url::parse(&upload.url).map_err(|_| CmdError::validation("Bad upload URL."))?;
    if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some() {
        return Err(CmdError::validation("Refusing a non-TLS upload URL."));
    }
    if url.origin() != storage.origin() {
        return Err(CmdError::validation("Uploads may only go to the configured storage host."));
    }
    for (k, v) in &upload.headers {
        let name = k.to_ascii_lowercase();
        if !ALLOWED_HEADERS.contains(&name.as_str()) {
            return Err(CmdError::validation("Upload header not allowed."));
        }
        if v.len() > 1024 || v.chars().any(|c| c.is_control()) {
            return Err(CmdError::validation("Bad upload header value."));
        }
    }
    Ok(url)
}

pub async fn upload_put(
    http: &reqwest::Client,
    storage: &url::Url,
    upload: PresignedPut,
    body: Vec<u8>,
) -> CmdResult<()> {
    let url = check_upload(&upload, storage)?;
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

    fn mk(url: &str, method: &str, h: &[(&str, &str)]) -> PresignedPut {
        PresignedPut {
            url: url.into(),
            method: method.into(),
            headers: h.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(),
        }
    }

    fn storage() -> url::Url {
        url::Url::parse("https://s3.test").unwrap()
    }

    #[test]
    fn uploads_must_be_tls_put_without_credentials() {
        let s = storage();
        assert!(check_upload(&mk("https://s3.test/k?sig=1", "PUT", &[("Content-Type", "audio/webm")]), &s).is_ok());
        assert!(check_upload(&mk("http://s3.test/k", "PUT", &[]), &s).is_err());
        assert!(check_upload(&mk("https://s3.test/k", "POST", &[]), &s).is_err());
        assert!(check_upload(&mk("https://s3.test/k", "PUT", &[("Authorization", "x")]), &s).is_err());
        assert!(check_upload(&mk("https://u:p@s3.test/k", "PUT", &[]), &s).is_err());
    }

    #[test]
    fn only_the_configured_storage_origin() {
        let s = storage();
        for u in ["https://evil.test/k", "https://s3.test.evil.test/k", "https://s3.test:8443/k", "https://api.meetops.test/k"] {
            assert!(check_upload(&mk(u, "PUT", &[]), &s).is_err(), "{u}");
        }
    }

    #[test]
    fn header_allowlist() {
        let s = storage();
        assert!(check_upload(&mk("https://s3.test/k", "PUT", &[("x-amz-checksum-sha256", "abc")]), &s).is_ok());
        for h in ["cookie", "host", "x-forwarded-for", "proxy-authorization", "x-amz-security-token", "transfer-encoding"] {
            assert!(check_upload(&mk("https://s3.test/k", "PUT", &[(h, "v")]), &s).is_err(), "{h}");
        }
        assert!(check_upload(&mk("https://s3.test/k", "PUT", &[("content-type", "a\r\nb")]), &s).is_err());
    }
}
