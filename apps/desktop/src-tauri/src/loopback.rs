//! One-shot loopback redirect listener (ADR-012 1.2): 127.0.0.1 only, OS-assigned port, one `GET /callback`,
//! 5-minute timeout, static script-free reply, then closed.

use std::io::{BufRead, BufReader, Write};
use std::net::{Ipv4Addr, TcpListener, TcpStream};
use std::time::{Duration, Instant};

use url::Url;

use crate::error::{CmdError, CmdResult};

pub const TIMEOUT: Duration = Duration::from_secs(300);

const PAGE: &str = "<!doctype html><meta charset=utf-8><title>MeetOps</title>\
<body style=\"background:#0A0A0A;color:#F5F5F7;font:16px system-ui;display:grid;place-items:center;height:100vh\">\
<p>You can close this tab and return to MeetOps.</p>";

#[derive(Debug, PartialEq, Eq)]
pub struct Callback {
    pub code: Option<String>,
    pub state: Option<String>,
    pub error: Option<String>,
}

pub struct Loopback {
    listener: TcpListener,
    pub port: u16,
}

impl Loopback {
    pub fn bind() -> CmdResult<Self> {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
            .map_err(|_| CmdError::new("SERVICE_UNAVAILABLE", "Couldn't start the sign-in listener."))?;
        let port = listener.local_addr().map_err(|_| CmdError::internal())?.port();
        Ok(Self { listener, port })
    }

    pub fn redirect_uri(&self) -> String {
        format!("http://127.0.0.1:{}/callback", self.port)
    }

    /// Blocks until one `/callback` request arrives or `timeout` passes. Other paths get a 404 and are ignored.
    pub fn wait(self, timeout: Duration) -> CmdResult<Callback> {
        self.listener.set_nonblocking(true).map_err(|_| CmdError::internal())?;
        let deadline = Instant::now() + timeout;
        loop {
            match self.listener.accept() {
                Ok((stream, _)) => {
                    if let Some(cb) = handle(stream) {
                        return Ok(cb);
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    if Instant::now() >= deadline {
                        return Err(CmdError::new("UNAUTHENTICATED", "Sign-in timed out. Try again."));
                    }
                    std::thread::sleep(Duration::from_millis(50));
                }
                Err(_) => return Err(CmdError::internal()),
            }
        }
    }
}

fn handle(mut stream: TcpStream) -> Option<Callback> {
    let _ = stream.set_nonblocking(false);
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let mut line = String::new();
    BufReader::new(&stream).read_line(&mut line).ok()?;
    let parsed = parse_request_line(&line);
    let (status, body) = if parsed.is_some() { ("200 OK", PAGE) } else { ("404 Not Found", "") };
    let _ = write!(
        stream,
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Security-Policy: default-src 'none'; style-src 'unsafe-inline'\r\nCache-Control: no-store\r\nReferrer-Policy: no-referrer\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    parsed
}

/// Parses `GET /callback?… HTTP/1.1`. Anything else is `None`.
pub fn parse_request_line(line: &str) -> Option<Callback> {
    let mut parts = line.split_whitespace();
    if parts.next()? != "GET" {
        return None;
    }
    let target = parts.next()?;
    let url = Url::parse(&format!("http://127.0.0.1{target}")).ok()?;
    if url.path() != "/callback" {
        return None;
    }
    let get = |k: &str| url.query_pairs().find(|(n, _)| n == k).map(|(_, v)| v.into_owned());
    Some(Callback { code: get("code"), state: get("state"), error: get("error") })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_only_get_callback() {
        assert_eq!(
            parse_request_line("GET /callback?code=c1&state=s1 HTTP/1.1\r\n"),
            Some(Callback { code: Some("c1".into()), state: Some("s1".into()), error: None })
        );
        assert_eq!(parse_request_line("POST /callback?code=c HTTP/1.1"), None);
        assert_eq!(parse_request_line("GET /favicon.ico HTTP/1.1"), None);
    }

    #[test]
    fn binds_loopback_and_receives_one_callback() {
        let lb = Loopback::bind().unwrap();
        assert!(lb.redirect_uri().starts_with("http://127.0.0.1:"));
        let port = lb.port;
        let client = std::thread::spawn(move || {
            let mut s = TcpStream::connect((Ipv4Addr::LOCALHOST, port)).unwrap();
            s.write_all(b"GET /callback?code=abc&state=xyz HTTP/1.1\r\nHost: x\r\n\r\n").unwrap();
            let mut out = String::new();
            let _ = std::io::Read::read_to_string(&mut s, &mut out);
            out
        });
        let cb = lb.wait(Duration::from_secs(5)).unwrap();
        assert_eq!(cb.code.as_deref(), Some("abc"));
        assert_eq!(cb.state.as_deref(), Some("xyz"));
        let reply = client.join().unwrap();
        assert!(reply.starts_with("HTTP/1.1 200"));
        assert!(!reply.contains("<script"));
    }

    #[test]
    fn times_out() {
        let lb = Loopback::bind().unwrap();
        assert!(lb.wait(Duration::from_millis(100)).is_err());
    }
}
