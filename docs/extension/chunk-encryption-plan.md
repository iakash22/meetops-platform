# Extension chunk encryption at rest: plan

Status: proposal (not implemented). Follow-up to #327. Owner: Techy. Needs Tester/Security review before work starts.

## Problem

`apps/extension/src/lib/chunk-store.ts` keeps recorded audio chunks (`StoredChunk.data`) in IndexedDB as plaintext
`ArrayBuffer`s until they are uploaded or evicted (up to `DEFAULT_STORE_CONFIG.maxBytes`, 500 MB). Anyone who can
read the browser profile on disk (another OS user with access, a backup, malware that runs as the user, or a forensic
copy of a lost laptop) can read meeting audio that hasn't uploaded yet. Desktop (AES-256-GCM + keychain) and mobile
(Keystore/CryptoKit) already encrypt at rest; the extension is the gap.

## Design

**Cipher.** WebCrypto `AES-GCM`, 256-bit key, a fresh random 96-bit IV per chunk (`crypto.getRandomValues`), 128-bit
tag. Stored record: `{ v: 1, iv, ct }` instead of `data`. Associated data binds the slot so chunks can't be swapped or
replayed between sessions: `meetops.ext-chunk.v1:<sessionId>:<seq>:<mimeType>`. `size` and `sha256` stay computed over
the plaintext (they are what `complete` sends), so upload contracts don't change.

**Keys.**

- A per-install data key (DEK) is generated with `crypto.subtle.generateKey({name:'AES-GCM',length:256}, false,
['encrypt','decrypt'])`: **non-extractable**. The `CryptoKey` object itself is stored in IndexedDB (structured
  clone keeps it non-extractable), in its own `keys` store in the same database as the chunks.
- Both the offscreen document (writer) and the background service worker (drain) open the same DB and get the same
  key; nothing is ever exported to JS as raw bytes, `chrome.storage`, or messages.
- Wrapping: there's no OS keychain API for MV3 extensions, so the DEK can't be wrapped by a hardware or OS key. We
  wrap with a per-install key-encryption key (KEK, `AES-KW`, also non-extractable, also in IndexedDB) only so the DEK
  can be rotated without re-encrypting by rewrapping, and so a future server- or account-held KEK (e.g. derived after
  pairing, ADR-005) can be swapped in without changing the chunk format. Wrapped DEK records carry `kekId`.
- Never derive keys from the bearer/pairing token (a token rotation would make audio unreadable, and a leaked token
  would expose audio).
- Key loss (profile reset, DB cleared) makes stored chunks undecryptable. That is acceptable: the chunks are deleted
  with the DB anyway, and the server session is aborted by the existing "evicted/refused" path.

**Fail closed.** If `crypto.subtle` or the key store is unavailable, recording does not start (consistent with the
"Start must fail closed" follow-up); chunks are never written in plaintext as a fallback.

## Migrating existing chunks

DB version bump (IndexedDB `onupgradeneeded`) adds the `keys` store only; data migration runs afterwards, not inside
the upgrade transaction (WebCrypto is async and would auto-commit it).

1. On first open after upgrade, the background worker creates the key, then walks chunks whose record has `data` and
   no `v`, in small batches: encrypt, write `{v:1, iv, ct}` in one transaction per chunk, removing `data` in the same
   put. Idempotent and resumable after a crash.
2. Reader accepts both formats during the transition (plaintext only if `v` is absent), so uploads keep draining.
3. Uploaded chunks (`uploaded: true`) are deleted rather than migrated.
4. After one release, readers reject records without `v` and delete them (session aborted via the existing path).
   Note: IndexedDB/LevelDB may keep old plaintext pages on disk until compaction; we can't securely erase them.

## Threat model and limits

Protects against: offline reads of the profile directory or backups/copies of it that don't include a running
browser; casual inspection by tools that dump IndexedDB values.

Does **not** protect against:

- Same-profile code execution while the browser runs (malware as the user, a compromised extension context): the
  non-extractable key is still _usable_ by anyone who can run code in our origin. Non-extractable stops exfiltration
  of raw key bytes, not decryption on the device.
- A full profile copy: the `CryptoKey` is persisted in the same profile (Chrome stores it serialized; on most platforms
  it is not protected by the OS keychain). So against a full copy this is defense in depth / obfuscation, not strong
  encryption. A real fix needs a key held outside the profile (server-wrapped KEK fetched after pairing, or user
  passphrase), which has availability trade-offs for offline recording and is out of scope here.
- Memory scraping, a compromised browser, or audio already uploaded (server-side protections apply there).
- Metadata: session ids, seq numbers, sizes, timestamps, and mime types stay in plaintext.

## Testing

Unit tests (fake-indexeddb + Node WebCrypto): round trip, AAD mismatch (swapped seq/session) fails, tampered IV/ct
fails, key unavailable blocks recording, migration converts plaintext records idempotently and survives a mid-batch
abort, eviction byte accounting uses plaintext size. No real recordings in fixtures.
