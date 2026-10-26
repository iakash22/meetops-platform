//! `upload_put` (ADR-012 3.3): presigned uploads go straight to storage with the signed headers verbatim and no
//! bearer. TLS PUT only; headers may not carry credentials. Authenticated API calls use `api_request` (api.rs).

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
