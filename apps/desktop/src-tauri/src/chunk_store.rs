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

const DISCARDED_SUFFIX: &str = ":discarded";

/// IPC header carrying the slot of a raw `chunk_put` body.
pub const CHUNK_HEADER: &str = "x-meetops-chunk";

#[derive(Debug, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChunkSlot {
    pub session_id: String,
    pub index: u32,
}

/// Parses the `x-meetops-chunk` header (`{"sessionId":"…","index":N}`); ids are validated again by the store.
pub fn chunk_header(v: Option<&str>) -> CmdResult<ChunkSlot> {
    let v = v.ok_or_else(|| CmdError::validation("Missing chunk descriptor."))?;
    if v.len() > 1024 {
        return Err(CmdError::validation("Chunk descriptor too large."));
    }
    let slot: ChunkSlot =
        serde_json::from_str(v).map_err(|_| CmdError::validation("Bad chunk descriptor."))?;
    safe_id(&slot.session_id)?;
    Ok(slot)
}

/// Pre-HMAC owner dir name (commit ab3f33fe layout): first 32 hex chars of SHA-256("meetops.chunk-owner.v1:<owner>").
/// Chunks in it already use the v2 AAD (owner, session, index), so migrating is a rename, never a re-encrypt.
fn legacy_owner_name(owner: &str) -> String {
    let digest = Sha256::digest(format!("meetops.chunk-owner.v1:{owner}").as_bytes());
    digest.iter().take(16).map(|b| format!("{b:02x}")).collect()
}

fn is_real_dir(e: &fs::DirEntry) -> bool {
    e.file_type().map(|t| t.is_dir()).unwrap_or(false)
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
    fn owner_name(&self, owner: &str) -> CmdResult<String> {
        if owner.is_empty() || owner.len() > 512 {
            return Err(CmdError::validation("Invalid recording owner."));
        }
        let key = self.owner_key.as_ref().ok_or_else(key_unavailable)?;
        let mac = hmac_sha256(key, format!("meetops.chunk-owner.v2:{owner}").as_bytes());
        Ok(mac.iter().take(16).map(|b| format!("{b:02x}")).collect())
    }

    fn owner_root(&self, owner: &str) -> CmdResult<PathBuf> {
        Ok(self.dir.join(self.owner_name(owner)?))
    }

    /// Device-wide pin `owners/<session>` = the owner dir name fixed at the recording's first write (L-4).
    fn pin_path(&self, session: &str) -> CmdResult<PathBuf> {
        Ok(self.dir.join("owners").join(safe_id(session)?))
    }

    /// Pin file is `<owner-name>` or `<owner-name>:discarded` (L-6: a second, per-recording discard marker).
    fn pin_raw(&self, session: &str) -> CmdResult<Option<String>> {
        match fs::read_to_string(self.pin_path(session)?) {
            Ok(v) => Ok(Some(v)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(_) => Err(CmdError::internal()),
        }
    }

    fn pinned(&self, session: &str) -> CmdResult<Option<String>> {
        Ok(self
            .pin_raw(session)?
            .map(|v| v.trim_end_matches(DISCARDED_SUFFIX).to_owned()))
    }

    /// Rejects any op on a recording pinned to a different owner (e.g. the session's org changed mid-recording), so a
    /// recording is never split across account folders. `create` pins an unpinned recording to `owner`.
    fn check_owner(&self, owner: &str, session: &str, create: bool) -> CmdResult<()> {
        let name = self.owner_name(owner)?;
        match self.pinned(session)? {
            Some(p) if p == name => Ok(()),
            Some(_) => Err(CmdError::new(
                "FORBIDDEN",
                "This recording belongs to another account.",
            )),
            None if create => {
                let pin = self.pin_path(session)?;
                fs::create_dir_all(pin.parent().unwrap()).map_err(|_| CmdError::internal())?;
                fs::write(pin, name).map_err(|_| CmdError::internal())
            }
            None => Ok(()),
        }
    }

    /// Device-wide tombstones (no account in the name), so a discard by any account is durable even when the
    /// recording's own account isn't signed in.
    fn tombstone_path(&self, session: &str) -> CmdResult<PathBuf> {
        Ok(self.dir.join("discarded").join(safe_id(session)?))
    }

    /// Marks a recording as discarded before any delete is attempted; it will never be re-queued.
    /// Errors are returned, never swallowed, so the caller can keep the recording blocked and retry.
    /// Records the discard in two independent places: the device-wide tombstone and the recording's own pin file
    /// (atomic tmp + rename). Succeeds if either is durable; either one alone makes the recording discarded (L-6).
    pub fn tombstone(&self, session: &str) -> CmdResult<()> {
        let path = self.tombstone_path(session)?;
        let tomb = fs::create_dir_all(path.parent().unwrap())
            .and_then(|_| fs::write(&path, b""))
            .is_ok();
        let pin = match self.pin_raw(session) {
            Ok(Some(v)) if v.ends_with(DISCARDED_SUFFIX) => true,
            Ok(Some(v)) => {
                let pin = self.pin_path(session)?;
                let tmp = pin.with_extension("tmp");
                fs::write(&tmp, format!("{v}{DISCARDED_SUFFIX}"))
                    .and_then(|_| fs::rename(&tmp, &pin))
                    .is_ok()
            }
            _ => false,
        };
        if tomb || pin {
            Ok(())
        } else {
            Err(CmdError::internal())
        }
    }

    fn is_tombstoned(&self, session: &str) -> CmdResult<bool> {
        if self.tombstone_path(session)?.exists() {
            return Ok(true);
        }
        Ok(self
            .pin_raw(session)?
            .is_some_and(|v| v.ends_with(DISCARDED_SUFFIX)))
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
        self.check_owner(owner, session, true)?;
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
        self.check_owner(owner, session, false)?;
        // Discarded recordings are never readable again, so nothing can upload them (L-6).
        if self.is_tombstoned(session)? {
            return Err(CmdError::validation("That recording was discarded."));
        }
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

    /// Deletes this owner's copy. The tombstone and pin are cleared only by the pinned owner and only after the
    /// chunks are gone (L-5); another owner gets FORBIDDEN and changes nothing.
    pub fn delete_session(&self, owner: &str, session: &str) -> CmdResult<()> {
        self.check_owner(owner, session, false)?;
        let dir = self.session_dir(owner, session)?;
        if dir.exists() {
            fs::remove_dir_all(&dir).map_err(|_| CmdError::internal())?;
        }
        if dir.exists() || self.pinned(session)?.is_none() {
            return Ok(());
        }
        let tomb = self.tombstone_path(session)?;
        if tomb.exists() {
            fs::remove_file(tomb).map_err(|_| CmdError::internal())?;
        }
        fs::remove_file(self.pin_path(session)?).map_err(|_| CmdError::internal())
    }

    /// True while any file of the session is still on disk (from this or an earlier launch).
    pub fn exists(&self, owner: &str, session: &str) -> CmdResult<bool> {
        self.check_owner(owner, session, false)?;
        Ok(self.session_dir(owner, session)?.exists())
    }

    /// Moves this owner's recordings from the old SHA-256-named folder into the current HMAC-named one.
    ///
    /// Safe and idempotent: only the signed-in owner's own legacy folder is touched (its name is derived from the
    /// owner, so another account's data is never adopted); a recording pinned to a different owner is left alone;
    /// each `.chunk` file moves with an atomic rename and an existing file in the new folder always wins (never
    /// overwritten); emptied legacy folders are removed. Re-running after a crash finishes the remaining moves.
    /// Files that aren't `<index>.chunk` (e.g. a stale `.tmp`) and symlinks are never moved.
    pub fn migrate_legacy(&self, owner: &str) -> CmdResult<usize> {
        let new_root = self.owner_root(owner)?;
        let legacy_root = self.dir.join(legacy_owner_name(owner));
        if legacy_root == new_root {
            return Ok(0);
        }
        let Ok(entries) = fs::read_dir(&legacy_root) else {
            return Ok(0);
        };
        let name = self.owner_name(owner)?;
        let mut moved = 0;
        for e in entries.filter_map(Result::ok).filter(is_real_dir) {
            let Some(session) = e.file_name().into_string().ok() else {
                continue;
            };
            if safe_id(&session).is_err() {
                continue;
            }
            match self.pinned(&session)? {
                Some(p) if p != name => continue,
                Some(_) => {}
                None => self.check_owner(owner, &session, true)?,
            }
            let target = self.session_dir(owner, &session)?;
            fs::create_dir_all(&target).map_err(|_| CmdError::internal())?;
            let Ok(files) = fs::read_dir(e.path()) else {
                continue;
            };
            for f in files.filter_map(Result::ok) {
                if !f.file_type().map(|t| t.is_file()).unwrap_or(false) {
                    continue;
                }
                let Some(fname) = f.file_name().into_string().ok() else {
                    continue;
                };
                let valid = fname
                    .strip_suffix(".chunk")
                    .is_some_and(|i| i.parse::<u32>().is_ok());
                let dest = target.join(&fname);
                if !valid || dest.exists() {
                    continue;
                }
                fs::rename(f.path(), &dest).map_err(|_| CmdError::internal())?;
                moved += 1;
            }
            // Only removes the folder once every chunk has moved (remove_dir fails while anything is left).
            let _ = fs::remove_dir(e.path());
        }
        let _ = fs::remove_dir(&legacy_root);
        Ok(moved)
    }

    /// Session ids with data on disk for this owner (sorted), so leftovers from earlier launches can be re-queued
    /// or expired. Entries that aren't valid ids are ignored. Legacy folders are migrated first (best effort: a
    /// failed migration is retried on the next list and never hides the current recordings).
    pub fn list(&self, owner: &str) -> CmdResult<Vec<StoredSession>> {
        let _ = self.migrate_legacy(owner);
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
    fn recordings_are_pinned_to_their_first_owner() {
        let (s, dir) = store();
        s.put(O, "a", 0, b"x").unwrap();
        // Session owner changed mid-recording: every op is refused, nothing lands in the other folder.
        assert_eq!(s.put("u1:o2", "a", 1, b"y").unwrap_err().code, "FORBIDDEN");
        assert_eq!(s.get("u1:o2", "a", 0).unwrap_err().code, "FORBIDDEN");
        assert_eq!(s.exists("u1:o2", "a").unwrap_err().code, "FORBIDDEN");
        assert!(s.list("u1:o2").unwrap().is_empty());
        assert_eq!(s.get(O, "a", 0).unwrap(), b"x");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn only_the_pinned_owner_clears_a_tombstone_after_its_chunks_are_gone() {
        let (s, dir) = store();
        s.put(O, "r", 0, b"x").unwrap();
        s.tombstone("r").unwrap();
        assert_eq!(
            s.delete_session("other:o", "r").unwrap_err().code,
            "FORBIDDEN"
        );
        assert!(s.is_tombstoned("r").unwrap());
        assert!(s.list(O).unwrap()[0].discarded);
        s.delete_session(O, "r").unwrap();
        assert!(!s.is_tombstoned("r").unwrap());
        assert!(s.pinned("r").unwrap().is_none());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn tombstone_write_failure_is_reported() {
        let (s, dir) = store();
        fs::create_dir_all(&dir).unwrap();
        // Stand-in for a read-only `discarded/` dir (works as root too): a file where the dir should be.
        fs::write(dir.join("discarded"), b"").unwrap();
        // No pin either (nothing written yet): both markers fail, so the error is reported.
        assert_eq!(s.tombstone("r").unwrap_err().code, "INTERNAL");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn pin_marker_alone_makes_a_recording_discarded() {
        let (s, dir) = store();
        s.put(O, "r", 0, b"x").unwrap();
        fs::write(dir.join("discarded"), b"").unwrap(); // device-wide tombstone dir unwritable
        s.tombstone("r").unwrap(); // durable via the pin file
        assert!(s.list(O).unwrap()[0].discarded);
        assert!(s.get(O, "r", 0).is_err(), "discarded chunks are unreadable");
        assert!(s.put(O, "r", 1, b"y").is_err());
        s.delete_session(O, "r").unwrap();
        assert!(s.pinned("r").unwrap().is_none());
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
        assert_eq!(s.exists("u2:o1", "a").unwrap_err().code, "FORBIDDEN");
        assert!(s.list("u2:o1").unwrap().is_empty());
        assert_eq!(s.get("u2:o1", "a", 0).unwrap_err().code, "FORBIDDEN");
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

    #[test]
    fn chunk_header_parses_the_slot() {
        assert!(chunk_header(None).is_err());
        assert!(chunk_header(Some("[1,2]")).is_err());
        assert!(chunk_header(Some(r#"{"sessionId":"../x","index":0}"#)).is_err());
        assert!(chunk_header(Some(r#"{"sessionId":"a","index":-1}"#)).is_err());
        assert!(chunk_header(Some(r#"{"sessionId":"a","index":0,"data":[1]}"#)).is_err());
        assert!(chunk_header(Some(&"x".repeat(2000))).is_err());
        assert_eq!(
            chunk_header(Some(r#"{"sessionId":"s-1","index":4294967295}"#)).unwrap(),
            ChunkSlot {
                session_id: "s-1".into(),
                index: u32::MAX
            }
        );
    }

    /// Writes a chunk the way the pre-HMAC build did: SHA-256 owner dir, same v2 AAD and sealing.
    fn put_legacy(
        s: &ChunkStore,
        dir: &Path,
        owner: &str,
        session: &str,
        index: u32,
        data: &[u8],
    ) {
        let p = dir
            .join(legacy_owner_name(owner))
            .join(session)
            .join(format!("{index}.chunk"));
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        let nonce = [9u8; 12];
        let aad = ChunkStore::aad(owner, session, index);
        let sealed = s
            .cipher()
            .unwrap()
            .encrypt(
                Nonce::from_slice(&nonce),
                Payload {
                    msg: data,
                    aad: &aad,
                },
            )
            .unwrap();
        fs::write(p, [nonce.as_slice(), sealed.as_slice()].concat()).unwrap();
    }

    #[test]
    fn migrates_legacy_owner_folders_idempotently() {
        let (s, dir) = store();
        put_legacy(&s, &dir, O, "old-1", 0, b"zero");
        put_legacy(&s, &dir, O, "old-1", 1, b"one");
        fs::write(dir.join(legacy_owner_name(O)).join("old-1").join("2.tmp"), b"junk").unwrap();
        // Listing migrates; the recording is readable in the new layout and pinned to its owner.
        let ids: Vec<_> = s.list(O).unwrap().into_iter().map(|r| r.id).collect();
        assert_eq!(ids, vec!["old-1".to_owned()]);
        assert_eq!(s.get(O, "old-1", 0).unwrap(), b"zero");
        assert_eq!(s.get(O, "old-1", 1).unwrap(), b"one");
        assert_eq!(s.pinned("old-1").unwrap(), Some(s.owner_name(O).unwrap()));
        // The stale .tmp stays behind, so the legacy folder is kept (nothing is deleted that wasn't moved).
        assert!(dir.join(legacy_owner_name(O)).join("old-1").join("2.tmp").exists());
        // Second run: nothing to move, nothing changes.
        assert_eq!(s.migrate_legacy(O).unwrap(), 0);
        assert_eq!(s.get(O, "old-1", 1).unwrap(), b"one");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn migration_never_overwrites_and_finishes_after_a_partial_run() {
        let (s, dir) = store();
        s.put(O, "r", 0, b"new").unwrap();
        put_legacy(&s, &dir, O, "r", 0, b"old");
        put_legacy(&s, &dir, O, "r", 1, b"rest");
        assert_eq!(s.migrate_legacy(O).unwrap(), 1);
        assert_eq!(s.get(O, "r", 0).unwrap(), b"new", "existing chunk wins");
        assert_eq!(s.get(O, "r", 1).unwrap(), b"rest");
        // Conflicting legacy copy is left in place, not deleted.
        assert!(dir.join(legacy_owner_name(O)).join("r").join("0.chunk").exists());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn migration_only_touches_the_signed_in_owner_and_respects_pins() {
        let (s, dir) = store();
        put_legacy(&s, &dir, "u2:o9", "theirs", 0, b"x");
        assert_eq!(s.migrate_legacy(O).unwrap(), 0);
        assert!(s.list(O).unwrap().is_empty());
        // A recording pinned to another owner is never adopted from a legacy folder.
        s.put("u2:o9", "pinned", 0, b"p").unwrap();
        put_legacy(&s, &dir, O, "pinned", 1, b"q");
        assert_eq!(s.migrate_legacy(O).unwrap(), 0);
        assert!(dir.join(legacy_owner_name(O)).join("pinned").join("1.chunk").exists());
        // The other owner migrates its own folder.
        assert_eq!(s.migrate_legacy("u2:o9").unwrap(), 1);
        assert_eq!(s.get("u2:o9", "theirs", 0).unwrap(), b"x");
        let _ = fs::remove_dir_all(dir);
    }
}
