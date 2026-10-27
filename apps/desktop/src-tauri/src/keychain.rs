//! OS credential store (ADR-012 3.1-3.2). If no backend works, secrets live in memory only for this launch and are
//! never written to a file.

use std::collections::HashMap;
use std::sync::Mutex;

pub trait SecretStore: Send + Sync {
    fn get(&self, account: &str) -> Option<String>;
    /// Returns `false` when the secret could only be kept in memory.
    fn set(&self, account: &str, secret: &str) -> bool;
    fn delete(&self, account: &str);
}

/// Keychain first, memory as the fail-closed fallback.
pub struct KeychainStore {
    service: String,
    memory: MemoryStore,
}

impl KeychainStore {
    pub fn new(service: &str) -> Self {
        Self {
            service: service.to_owned(),
            memory: MemoryStore::default(),
        }
    }
    fn entry(&self, account: &str) -> Option<keyring::Entry> {
        keyring::Entry::new(&self.service, account).ok()
    }
}

impl SecretStore for KeychainStore {
    fn get(&self, account: &str) -> Option<String> {
        self.memory
            .get(account)
            .or_else(|| self.entry(account).and_then(|e| e.get_password().ok()))
    }
    fn set(&self, account: &str, secret: &str) -> bool {
        let persisted = self
            .entry(account)
            .map(|e| e.set_password(secret).is_ok())
            .unwrap_or(false);
        if !persisted {
            self.memory.set(account, secret);
        }
        persisted
    }
    fn delete(&self, account: &str) {
        self.memory.delete(account);
        if let Some(e) = self.entry(account) {
            let _ = e.delete_credential();
        }
    }
}

#[derive(Default)]
pub struct MemoryStore(Mutex<HashMap<String, String>>);

impl SecretStore for MemoryStore {
    fn get(&self, account: &str) -> Option<String> {
        self.0.lock().ok()?.get(account).cloned()
    }
    fn set(&self, account: &str, secret: &str) -> bool {
        if let Ok(mut m) = self.0.lock() {
            m.insert(account.to_owned(), secret.to_owned());
        }
        false
    }
    fn delete(&self, account: &str) {
        if let Ok(mut m) = self.0.lock() {
            m.remove(account);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn memory_store_round_trips_and_reports_not_persisted() {
        let s = MemoryStore::default();
        assert!(!s.set("a", "1"));
        assert_eq!(s.get("a").as_deref(), Some("1"));
        s.delete("a");
        assert_eq!(s.get("a"), None);
    }
}
