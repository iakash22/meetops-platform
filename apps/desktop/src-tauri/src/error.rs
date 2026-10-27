//! Errors returned to the webview as `{ code, message }` (matches `toError` in `native-upload-api.ts`).
//! Messages never include tokens, codes, verifiers or `state` (ADR-012 2.5).

use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CmdError {
    pub code: String,
    pub message: String,
}

impl CmdError {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self { code: code.to_owned(), message: message.into() }
    }
    pub fn unauthenticated() -> Self {
        Self::new("UNAUTHENTICATED", "Sign in to continue.")
    }
    pub fn not_configured() -> Self {
        Self::new("SERVICE_UNAVAILABLE", "Sign-in isn't configured for this build.")
    }
    pub fn network() -> Self {
        Self::new("SERVICE_UNAVAILABLE", "Couldn't reach MeetOps. Check your connection.")
    }
    pub fn validation(message: impl Into<String>) -> Self {
        Self::new("VALIDATION_FAILED", message)
    }
    pub fn internal() -> Self {
        Self::new("INTERNAL", "Something went wrong.")
    }
}

pub type CmdResult<T> = Result<T, CmdError>;
