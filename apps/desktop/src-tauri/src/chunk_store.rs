//! Encrypted offline chunk store (ADR-012 3.5). Each chunk is AES-256-GCM sealed with a per-device key held in the
//! keychain (never derived from a token) and written as `<dir>/<owner>/<session>/<index>.chunk` = 12-byte nonce ||
//! ciphertext. `<owner>` is a hash of the signed-in `userId:organizationId` (L-1), so one account's chunks are not
//! addressable under another's. Owner, session id and index are bound as associated data, so chunks can't be swapped
//! between slots or accounts.

use std::fs;
use std::path::{Path, PathBuf};

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use base64::{engine::general_purpose::STANDARD, Engine};
use rand::{rngs::OsRng, RngCore};
use sha2::{Digest, Sha256};

use crate::error::{CmdError, CmdResult};
use crate::keychain::SecretStore;

pub struct ChunkStore {
    dir: PathBuf,
    /// `None` when the device key couldn't be persisted: chunk commands fail closed.
    cipher: Option<Aes256Gcm>,
    /// HMAC key for account dir names, derived from the device key (unavailable with it).
    owner_key: Option<[u8; 32]>,
}

/// A session id on disk, and whether it was discarded (tombstoned) and must only ever be deleted.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredSession {
    pub id: String,
    pub discarded: bool,
}

fn hmac_sha256(key: &[u8; 32], msg: &[u8]) -> [u8; 32] {
    let mut ipad = [0x36u8; 64];
    let mut opad = [0x5cu8; 64];
    for (i, k) in key.iter().enumerate() {
        ipad[i] ^= k;
        opad[i] ^= k;
    }
    let inner = Sha256::new()
        .chain_update(ipad)
        .chain_update(msg)
        .finalize();
    Sha256::new()
        .chain_update(opad)
        .chain_update(inner)
        .finalize()
        .into()
}

/// Loads the device key, creating it on first use. Fails closed (Low): if a new key can't be saved to the OS
/// keychain, it is discarded and an error returned, so chunks are never sealed with a key that dies with the process
/// (unrecoverable audio) or that lives only in memory.
pub fn device_key(store: &dyn SecretStore, account: &str) -> CmdResult<[u8; 32]> {
    if let Some(k) = store.get(account).and_then(|b| STANDARD.decode(b).ok()) {
        if let Ok(k) = <[u8; 32]>::try_from(k.as_slice()) {
            return Ok(k);
        }
    }
    let mut k = [0u8; 32];
    OsRng.fill_bytes(&mut k);
    if !store.set(account, &STANDARD.encode(k)) {
        store.delete(account);
        return Err(key_unavailable());
    }
    Ok(k)
}

fn key_unavailable() -> CmdError {
    CmdError::new(
        "SERVICE_UNAVAILABLE",
        "Secure storage is unavailable, so offline recording is turned off.",
    )
}

fn safe_id(id: &str) -> CmdResult<&str> {
    let ok = !id.is_empty()
        && id.len() <= 128
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if ok {
        Ok(id)
    } else {
        Err(CmdError::validation("Invalid recording id."))
    }
}

impl ChunkStore {
    pub fn new(dir: impl AsRef<Path>, key: &[u8; 32]) -> Self {
        Self {
            dir: dir.as_ref().to_path_buf(),
            cipher: Some(Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key))),
            owner_key: Some(hmac_sha256(key, b"meetops.chunk-owner-key.v1")),
        }
    }

    pub fn unavailable(dir: impl AsRef<Path>) -> Self {
        Self {
            dir: dir.as_ref().to_path_buf(),
            cipher: None,
            owner_key: None,
        }
    }

    fn cipher(&self) -> CmdResult<&Aes256Gcm> {
        self.cipher.as_ref().ok_or_else(key_unavailable)
    }

    /// Account dir: first 32 hex chars of HMAC-SHA256(device-derived key, owner), so dir names can't be linked to
    /// known account ids without the device key.
    fn owner_root(&self, owner: &str) -> CmdResult<PathBuf> {
        if owner.is_empty() || owner.len() > 512 {
            return Err(CmdError::validation("Invalid recording owner."));
        }
        let key = self.owner_key.as_ref().ok_or_else(key_unavailable)?;
        let mac = hmac_sha256(key, format!("meetops.chunk-owner.v2:{owner}").as_bytes());
        let name: String = mac.iter().take(16).map(|b| format!("{b:02x}")).collect();
        Ok(self.dir.join(name))
    }

    /// Device-wide tombstones (no account in the name), so a discard by any account is durable even when the
    /// recording's own account isn't signed in.
    fn tombstone_path(&self, session: &str) -> CmdResult<PathBuf> {
        Ok(self.dir.join("discarded").join(safe_id(session)?))
    }

    /// Marks a recording as discarded before any delete is attempted; it will never be re-queued.
    pub fn tombstone(&self, session: &str) -> CmdResult<()> {
        let path = self.tombstone_path(session)?;
        fs::create_dir_all(path.parent().unwrap()).map_err(|_| CmdError::internal())?;
        fs::write(path, b"").map_err(|_| CmdError::internal())
    }

    fn is_tombstoned(&self, session: &str) -> CmdResult<bool> {
        Ok(self.tombstone_path(session)?.exists())
    }

    fn session_dir(&self, owner: &str, session: &str) -> CmdResult<PathBuf> {
        Ok(self.owner_root(owner)?.join(safe_id(session)?))
    }

    fn path(&self, owner: &str, session: &str, index: u32) -> CmdResult<PathBuf> {
        Ok(self
            .session_dir(owner, session)?
            .join(format!("{index}.chunk")))
    }

    fn aad(owner: &str, session: &str, index: u32) -> Vec<u8> {
        format!("meetops.chunk.v2:{owner}:{session}:{index}").into_bytes()
    }

    pub fn put(&self, owner: &str, session: &str, index: u32, data: &[u8]) -> CmdResult<()> {
        crate::upload::check_body_size(data.len())?;
        if self.is_tombstoned(session)? {
            return Err(CmdError::validation("That recording was discarded."));
        }
        let path = self.path(owner, session, index)?;
        let mut nonce = [0u8; 12];
        OsRng.fill_bytes(&mut nonce);
        let aad = Self::aad(owner, session, index);
        let sealed = self
            .cipher()?
            .encrypt(
                Nonce::from_slice(&nonce),
                Payload {
                    msg: data,
                    aad: &aad,
                },
            )
            .map_err(|_| CmdError::internal())?;
        fs::create_dir_all(path.parent().unwrap()).map_err(|_| CmdError::internal())?;
        let tmp = path.with_extension("tmp");
        fs::write(&tmp, [nonce.as_slice(), sealed.as_slice()].concat())
            .map_err(|_| CmdError::internal())?;
        fs::rename(&tmp, &path).map_err(|_| CmdError::internal())
    }

    pub fn get(&self, owner: &str, session: &str, index: u32) -> CmdResult<Vec<u8>> {
        let raw = fs::read(self.path(owner, session, index)?)
            .map_err(|_| CmdError::new("NOT_FOUND", "That recording chunk is missing."))?;
        if raw.len() < 12 {
            return Err(CmdError::internal());
        }
        let aad = Self::aad(owner, session, index);
        self.cipher()?
            .decrypt(
                Nonce::from_slice(&raw[..12]),
                Payload {
                    msg: &raw[12..],
                    aad: &aad,
                },
            )
            .map_err(|_| CmdError::new("INTERNAL", "A recording chunk failed its integrity check."))
    }

    pub fn delete_session(&self, owner: &str, session: &str) -> CmdResult<()> {
        let dir = self.session_dir(owner, session)?;
        if dir.exists() {
            fs::remove_dir_all(dir).map_err(|_| CmdError::internal())?;
        }
        let tomb = self.tombstone_path(session)?;
        if tomb.exists() {
            fs::remove_file(tomb).map_err(|_| CmdError::internal())?;
        }
        Ok(())
    }

    /// True while any file of the session is still on disk (from this or an earlier launch).
    pub fn exists(&self, owner: &str, session: &str) -> CmdResult<bool> {
        Ok(self.session_dir(owner, session)?.exists())
    }

    /// Session ids with data on disk for this owner (sorted), so leftovers from earlier launches can be re-queued
    /// or expired. Entries that aren't valid ids are ignored.
    pub fn list(&self, owner: &str) -> CmdResult<Vec<StoredSession>> {
        let root = self.owner_root(owner)?;
        let Ok(entries) = fs::read_dir(&root) else {
            return Ok(Vec::new());
        };
        // file_type() doesn't follow symlinks: linked dirs are skipped.
        let mut ids: Vec<String> = entries
            .filter_map(Result::ok)
            .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
            .filter_map(|e| e.file_name().into_string().ok())
            .filter(|n| safe_id(n).is_ok())
            .collect();
        ids.sort();
        ids.into_iter()
            .map(|id| {
                let discarded = self.is_tombstoned(&id)?;
                Ok(StoredSession { id, discarded })
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::keychain::MemoryStore;
    use std::collections::HashMap;
    use std::sync::Mutex;

    /// Behaves like a working OS keychain (set reports persisted).
    #[derive(Default)]
    struct Persisting(Mutex<HashMap<String, String>>);
    impl SecretStore for Persisting {
        fn get(&self, a: &str) -> Option<String> {
            self.0.lock().unwrap().get(a).cloned()
        }
        fn set(&self, a: &str, s: &str) -> bool {
            self.0.lock().unwrap().insert(a.into(), s.into());
            true
        }
        fn delete(&self, a: &str) {
            self.0.lock().unwrap().remove(a);
        }
    }

    const O: &str = "u1:o1";

    fn store() -> (ChunkStore, PathBuf) {
        let dir = std::env::temp_dir().join(format!("mo-chunks-{}", crate::pkce::random_b64(6)));
        let key = [1u8; 32];
        (ChunkStore::new(&dir, &key), dir)
    }

    #[test]
    fn put_rejects_empty_and_oversized_chunks() {
        let (s, dir) = store();
        let max = crate::upload::MAX_UPLOAD_BYTES;
        assert_eq!(s.put(O, "a", 0, b"").unwrap_err().code, "VALIDATION_FAILED");
        assert!(s.put(O, "a", 1, &vec![0u8; max + 1]).is_err());
        assert!(!s.exists(O, "a").unwrap());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn round_trips_and_is_not_plaintext_on_disk() {
        let (s, dir) = store();
        s.put(O, "sess-1", 0, b"hello audio").unwrap();
        let raw = fs::read(s.path(O, "sess-1", 0).unwrap()).unwrap();
        assert!(!raw.windows(5).any(|w| w == b"hello"));
        assert_eq!(s.get(O, "sess-1", 0).unwrap(), b"hello audio");
        s.delete_session(O, "sess-1").unwrap();
        assert!(s.get(O, "sess-1", 0).is_err());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn lists_and_reports_sessions_across_store_instances() {
        let (s, dir) = store();
        s.put(O, "b", 0, b"x").unwrap();
        s.put(O, "a", 3, b"y").unwrap();
        // A fresh instance (new launch) still sees what is on disk.
        let key = [1u8; 32];
        let again = ChunkStore::new(&dir, &key);
        let ids = |v: Vec<StoredSession>| v.into_iter().map(|s| s.id).collect::<Vec<_>>();
        assert_eq!(
            ids(again.list(O).unwrap()),
            vec!["a".to_owned(), "b".to_owned()]
        );
        assert!(again.exists(O, "a").unwrap());
        again.delete_session(O, "a").unwrap();
        assert!(!again.exists(O, "a").unwrap());
        assert_eq!(ids(again.list(O).unwrap()), vec!["b".to_owned()]);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn tombstones_are_durable_block_writes_and_clear_on_delete() {
        let (s, dir) = store();
        s.put(O, "a", 0, b"x").unwrap();
        // Discarded from another account: no access to O's namespace, but the tombstone is device-wide.
        s.tombstone("a").unwrap();
        let key = [1u8; 32];
        let again = ChunkStore::new(&dir, &key);
        assert_eq!(
            again.list(O).unwrap(),
            vec![StoredSession {
                id: "a".into(),
                discarded: true
            }]
        );
        assert!(
            again.put(O, "a", 1, b"y").is_err(),
            "no writes after discard"
        );
        again.delete_session(O, "a").unwrap();
        assert!(again.list(O).unwrap().is_empty());
        assert!(!again.is_tombstoned("a").unwrap());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn owner_dirs_are_keyed_by_the_device_key() {
        let (s, dir) = store();
        let other = ChunkStore::new(&dir, &[7u8; 32]);
        assert_ne!(s.owner_root(O).unwrap(), other.owner_root(O).unwrap());
        assert!(ChunkStore::unavailable(&dir).owner_root(O).is_err());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn chunks_are_bound_to_their_owner() {
        let (s, dir) = store();
        s.put(O, "a", 0, b"secret").unwrap();
        assert!(!s.exists("u2:o1", "a").unwrap());
        assert!(s.list("u2:o1").unwrap().is_empty());
        assert_eq!(s.get("u2:o1", "a", 0).unwrap_err().code, "NOT_FOUND");
        // Copying the ciphertext into another owner's dir still fails (owner is in the AAD).
        let other = s.path("u2:o1", "a", 0).unwrap();
        fs::create_dir_all(other.parent().unwrap()).unwrap();
        fs::copy(s.path(O, "a", 0).unwrap(), &other).unwrap();
        assert!(s.get("u2:o1", "a", 0).is_err());
        assert!(s.put("", "a", 0, b"x").is_err());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn rejects_swapped_or_tampered_chunks_and_bad_ids() {
        let (s, dir) = store();
        s.put(O, "a", 0, b"zero").unwrap();
        fs::copy(s.path(O, "a", 0).unwrap(), s.path(O, "a", 1).unwrap()).unwrap();
        assert!(s.get(O, "a", 1).is_err());
        assert!(s.put(O, "../x", 0, b"x").is_err());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn device_key_is_stable() {
        let m = Persisting::default();
        assert_eq!(device_key(&m, "k").unwrap(), device_key(&m, "k").unwrap());
    }

    #[test]
    fn device_key_fails_closed_when_the_keychain_save_fails() {
        let m = MemoryStore::default(); // set() reports "memory only"
        assert_eq!(device_key(&m, "k").unwrap_err().code, "SERVICE_UNAVAILABLE");
        assert_eq!(m.get("k"), None, "no in-memory key left behind");
        let dir = std::env::temp_dir().join(format!("mo-chunks-{}", crate::pkce::random_b64(6)));
        let s = ChunkStore::unavailable(&dir);
        assert_eq!(
            s.put(O, "a", 0, b"x").unwrap_err().code,
            "SERVICE_UNAVAILABLE"
        );
        assert!(!dir.exists(), "nothing written");
    }
}
