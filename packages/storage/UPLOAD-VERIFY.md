# Upload verify-on-complete contract

This contract is owned by Media and Realtime. It covers Native Apps, Extension, Web and the Backend route owner.

## Flow

1. **Init.** The client calls the Backend upload-init route with `{ mimeType, sizeBytes, checksumSha256 }`. `checksumSha256` is the base64 SHA-256 of the whole file and is required. The server derives the key under `organizations/{organizationId}/meetings/{meetingId}/...` and calls `getPresignedUploadUrl` (or `createMultipartUpload` for large files). The response holds a presigned URL (TTL 10 min or less), the headers to send, and a one-time `uploadToken`.
2. **Upload.** The client sends the PUT with exactly those headers. S3 enforces the size, content type and `x-amz-checksum-sha256`, and `If-None-Match: *` stops overwrites.
3. **Complete.** The client calls the Backend complete route with `uploadToken` (and `uploadId` and `parts` for multipart). The server calls `verifyUpload` or `verifyMultipartUpload`.

## Response

On success the complete route returns:

```json
{
  "verified": true,
  "sha256": "<hex>",
  "checksumSha256": "<hex>",
  "checksumSha256Base64": "<base64>",
  "sizeBytes": 123
}
```

Encodings: `sha256` and `checksumSha256` are both lowercase 64-char hex (`checksumSha256` matches the DB `FileObject.checksumSha256`); `checksumSha256Base64` is the same digest in S3 `x-amz-checksum-sha256` (padded base64) form. Inputs are unchanged: the init request's `checksumSha256` stays base64 (contracts `Sha256Base64`), recording-session chunk `sha256` stays hex.

The server never trusts a hash sent by the client. It checks it as follows:

- **Single-part:** the HEAD request must show the token metadata, the declared size, and a full-object `ChecksumSHA256` that S3 enforced on the PUT.
- **Multipart:** the per-part checksums are checked with `ListParts`. Then the stored object is streamed and hashed, and the result must equal the whole-object sha256 declared at init.
- **On mismatch:** the object is deleted and a 4xx is returned.

## Device rule (Native Apps, Extension)

- Delete the local copy **only** after receiving `verified: true` for that upload.
- On a timeout, network error or 5xx, keep the local copy and **retry complete with the same `uploadToken`**. Complete is idempotent. A retry after a lost response returns the same `verified: true` result, because the stored object still carries the token and the S3-enforced checksum.
- On a 4xx (mismatch, expired, not found), keep the local copy and start a fresh init/upload.

## Expiry cleanup

- `abortStaleMultipartUploads()` aborts multipart uploads older than the upload TTL plus the 1 h confirm grace. Run it from a periodic job (Backend/DevOps).
- Single-part objects that were never verified are deleted by the upload-record sweeper: status is not `verified` and `expiresAt` plus the grace period has passed. That sweeper needs the Database upload model. Use a bucket lifecycle rule as a backstop.
