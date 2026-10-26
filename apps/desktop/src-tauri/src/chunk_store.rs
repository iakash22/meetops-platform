//! Encrypted offline chunk store (ADR-012 3.5). Each chunk is AES-256-GCM sealed with a per-device key held in the
//! keychain (never derived from a token) and written as `<dir>/<session>/<index>.chunk` = 12-byte nonce || ciphertext.
//! The session id and index are bound as associated data, so chunks can't be swapped between slots.

use std::fs;
use std::path::{Path, PathBuf};

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use base64::{engine::general_purpose::STANDARD, Engine};
use rand::{rngs::OsRng, RngCore};

use crate::error::{CmdError, CmdResult};
use crate::keychain::SecretStore;

pub struct ChunkStore {
    dir: PathBuf,
    cipher: Aes256Gcm,
}

/// Loads the device key, creating it on first use.
pub fn device_key(store: &dyn SecretStore, account: &str) -> [u8; 32] {
    if let Some(k) = store.get(account).and_then(|b| STANDARD.decode(b).ok()) {
        if let Ok(k) = <[u8; 32]>::try_from(k.as_slice()) {
            return k;
        }
    }
    let mut k = [0u8; 32];
    OsRng.fill_bytes(&mut k);
    store.set(account, &STANDARD.encode(k));
    k
}

fn safe_id(id: &str) -> CmdResult<&str> {
    let ok = !id.is_empty() && id.len() <= 128 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if ok { Ok(id) } else { Err(CmdError::validation("Invalid recording id.")) }
}

impl ChunkStore {
    pub fn new(dir: impl AsRef<Path>, key: &[u8; 32]) -> Self {
        Self { dir: dir.as_ref().to_path_buf(), cipher: Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key)) }
    }

    fn path(&self, session: &str, index: u32) -> CmdResult<PathBuf> {
        Ok(self.dir.join(safe_id(session)?).join(format!("{index}.chunk")))
    }

    fn aad(session: &str, index: u32) -> Vec<u8> {
        format!("meetops.chunk.v1:{session}:{index}").into_bytes()
    }

    pub fn put(&self, session: &str, index: u32, data: &[u8]) -> CmdResult<()> {
        let path = self.path(session, index)?;
        let mut nonce = [0u8; 12];
        OsRng.fill_bytes(&mut nonce);
        let aad = Self::aad(session, index);
        let sealed = self
            .cipher
            .encrypt(Nonce::from_slice(&nonce), Payload { msg: data, aad: &aad })
            .map_err(|_| CmdError::internal())?;
        fs::create_dir_all(path.parent().unwrap()).map_err(|_| CmdError::internal())?;
        let tmp = path.with_extension("tmp");
        fs::write(&tmp, [nonce.as_slice(), sealed.as_slice()].concat()).map_err(|_| CmdError::internal())?;
        fs::rename(&tmp, &path).map_err(|_| CmdError::internal())
    }

    pub fn get(&self, session: &str, index: u32) -> CmdResult<Vec<u8>> {
        let raw = fs::read(self.path(session, index)?)
            .map_err(|_| CmdError::new("NOT_FOUND", "That recording chunk is missing."))?;
        if raw.len() < 12 {
            return Err(CmdError::internal());
        }
        let aad = Self::aad(session, index);
        self.cipher
            .decrypt(Nonce::from_slice(&raw[..12]), Payload { msg: &raw[12..], aad: &aad })
            .map_err(|_| CmdError::new("INTERNAL", "A recording chunk failed its integrity check."))
    }

    pub fn delete_session(&self, session: &str) -> CmdResult<()> {
        let dir = self.dir.join(safe_id(session)?);
        if dir.exists() {
            fs::remove_dir_all(dir).map_err(|_| CmdError::internal())?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::keychain::MemoryStore;

    fn store() -> (ChunkStore, PathBuf) {
        let dir = std::env::temp_dir().join(format!("mo-chunks-{}", crate::pkce::random_b64(6)));
        let key = device_key(&MemoryStore::default(), "k");
        (ChunkStore::new(&dir, &key), dir)
    }

    #[test]
    fn round_trips_and_is_not_plaintext_on_disk() {
        let (s, dir) = store();
        s.put("sess-1", 0, b"hello audio").unwrap();
        let raw = fs::read(dir.join("sess-1/0.chunk")).unwrap();
        assert!(!raw.windows(5).any(|w| w == b"hello"));
        assert_eq!(s.get("sess-1", 0).unwrap(), b"hello audio");
        s.delete_session("sess-1").unwrap();
        assert!(s.get("sess-1", 0).is_err());
    }

    #[test]
    fn rejects_swapped_or_tampered_chunks_and_bad_ids() {
        let (s, dir) = store();
        s.put("a", 0, b"zero").unwrap();
        fs::copy(dir.join("a/0.chunk"), dir.join("a/1.chunk")).unwrap();
        assert!(s.get("a", 1).is_err());
        assert!(s.put("../x", 0, b"x").is_err());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn device_key_is_stable() {
        let m = MemoryStore::default();
        assert_eq!(device_key(&m, "k"), device_key(&m, "k"));
    }
}
