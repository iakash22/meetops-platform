//! One-shot loopback redirect listener (ADR-012 1.2): 127.0.0.1 only, OS-assigned port, one `GET /callback`,
//! 5-minute overall timeout (checked on every connection), per-connection timeouts, at most 16 stray requests,
//! static script-free reply, then closed. `auth::sign_in` allows one sign-in (one listener) at a time.

use std::io::{BufRead, BufReader, Write};
use std::net::{Ipv4Addr, TcpListener, TcpStream};
use std::time::{Duration, Instant};

use url::Url;

use crate::error::{CmdError, CmdResult};

pub const TIMEOUT: Duration = Duration::from_secs(300);
/// Per-connection read/write timeout, so one slow client can't hold the single-threaded listener.
const PER_CONNECTION_TIMEOUT: Duration = Duration::from_secs(5);
/// Stray requests (favicon, probes) tolerated before the listener gives up and closes.
const MAX_CONNECTIONS: usize = 16;

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
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).map_err(|_| {
            CmdError::new(
                "SERVICE_UNAVAILABLE",
                "Couldn't start the sign-in listener.",
            )
        })?;
        let port = listener
            .local_addr()
            .map_err(|_| CmdError::internal())?
            .port();
        Ok(Self { listener, port })
    }

    pub fn redirect_uri(&self) -> String {
        format!("http://127.0.0.1:{}/callback", self.port)
    }

    /// Blocks until one `/callback` request arrives or `timeout` passes. Other paths get a 404 and are ignored.
    pub fn wait(self, timeout: Duration) -> CmdResult<Callback> {
        self.wait_for(timeout, |_| true)
    }

    /// Like `wait`, but a `/callback` that `accept` rejects (e.g. wrong `state`) is answered and ignored, so a local
    /// process can't cancel a pending sign-in with a forged callback (L-2). It still counts toward `MAX_CONNECTIONS`.
    pub fn wait_for(
        self,
        timeout: Duration,
        accept: impl Fn(&Callback) -> bool,
    ) -> CmdResult<Callback> {
        self.listener
            .set_nonblocking(true)
            .map_err(|_| CmdError::internal())?;
        let deadline = Instant::now() + timeout;
        let timed_out = || CmdError::new("UNAUTHENTICATED", "Sign-in timed out. Try again.");
        let mut connections = 0usize;
        loop {
            // Checked on every pass, so a stream of junk connections can't keep the listener alive past the deadline.
            let Some(remaining) = deadline
                .checked_duration_since(Instant::now())
                .filter(|d| !d.is_zero())
            else {
                return Err(timed_out());
            };
            match self.listener.accept() {
                Ok((stream, _)) => {
                    connections += 1;
                    if let Some(cb) = handle(stream, remaining.min(PER_CONNECTION_TIMEOUT))
                        .filter(|cb| accept(cb))
                    {
                        return Ok(cb); // single use: `self` (and the socket) is dropped here
                    }
                    if connections >= MAX_CONNECTIONS {
                        return Err(CmdError::new(
                            "UNAUTHENTICATED",
                            "Sign-in was interrupted. Try again.",
                        ));
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(50));
                }
                Err(_) => return Err(CmdError::internal()),
            }
        }
    }
}

fn handle(mut stream: TcpStream, timeout: Duration) -> Option<Callback> {
    let _ = stream.set_nonblocking(false);
    let _ = stream.set_read_timeout(Some(timeout));
    let _ = stream.set_write_timeout(Some(timeout));
    let mut line = String::new();
    // Bounded read: at most 8 KiB for the request line.
    std::io::Read::take(BufReader::new(&stream), 8192)
        .read_line(&mut line)
        .ok()?;
    let parsed = parse_request_line(&line);
    let (status, body) = if parsed.is_some() {
        ("200 OK", PAGE)
    } else {
        ("404 Not Found", "")
    };
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
    let get = |k: &str| {
        url.query_pairs()
            .find(|(n, _)| n == k)
            .map(|(_, v)| v.into_owned())
    };
    Some(Callback {
        code: get("code"),
        state: get("state"),
        error: get("error"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_only_get_callback() {
        assert_eq!(
            parse_request_line("GET /callback?code=c1&state=s1 HTTP/1.1\r\n"),
            Some(Callback {
                code: Some("c1".into()),
                state: Some("s1".into()),
                error: None
            })
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
            s.write_all(b"GET /callback?code=abc&state=xyz HTTP/1.1\r\nHost: x\r\n\r\n")
                .unwrap();
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
    fn junk_connections_cannot_outlive_the_deadline_or_the_cap() {
        let lb = Loopback::bind().unwrap();
        let port = lb.port;
        std::thread::spawn(move || {
            for _ in 0..(MAX_CONNECTIONS + 4) {
                if let Ok(mut s) = TcpStream::connect((Ipv4Addr::LOCALHOST, port)) {
                    let _ = s.write_all(b"GET /favicon.ico HTTP/1.1\r\n\r\n");
                }
            }
        });
        let started = Instant::now();
        assert!(lb.wait(Duration::from_secs(10)).is_err());
        assert!(started.elapsed() < Duration::from_secs(10));
    }

    #[test]
    fn wrong_state_callback_does_not_cancel_the_pending_flow() {
        let lb = Loopback::bind().unwrap();
        let port = lb.port;
        let t = std::thread::spawn(move || {
            for q in ["state=evil&error=access_denied", "state=good&code=real"] {
                let mut s = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
                s.write_all(format!("GET /callback?{q} HTTP/1.1\r\nHost: x\r\n\r\n").as_bytes())
                    .unwrap();
                let mut buf = String::new();
                let _ = std::io::Read::read_to_string(&mut s, &mut buf);
            }
        });
        let cb = lb
            .wait_for(Duration::from_secs(5), |cb| {
                cb.state.as_deref() == Some("good")
            })
            .unwrap();
        assert_eq!(cb.code.as_deref(), Some("real"));
        t.join().unwrap();
    }

    #[test]
    fn times_out() {
        let lb = Loopback::bind().unwrap();
        assert!(lb.wait(Duration::from_millis(100)).is_err());
    }
}
