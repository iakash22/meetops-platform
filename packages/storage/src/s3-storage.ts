import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetBucketAclCommand,
  GetBucketPolicyStatusCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListMultipartUploadsCommand,
  ListObjectsV2Command,
  ListPartsCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { downloadResponseOverrides } from './download-headers.js';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import type { FileObject } from '@meetops/contracts';
import type { PresignedUrl } from '@meetops/contracts/legacy';
import { MAX_CHUNK_BYTES, MAX_CHUNKS } from '@meetops/contracts';
import {
  assertTtl,
  loadStorageConfig,
  S3_MIN_PART_BYTES,
  SESSION_CHUNK_TTL_SECONDS,
  UPLOAD_CONFIRM_GRACE_SECONDS,
  type StorageConfig,
} from './config.js';
import { mapS3Error, StorageAccessError, StorageValidationError } from './errors.js';
import {
  assertKeyOwnedBy,
  buildObjectKey,
  normalizeMeetingObjectRef,
  organizationPrefix,
  parseMeetingKey,
  LEGACY_ORG_KEY_PREFIX,
  ORGANIZATIONS_KEY_PREFIX,
  refOrganizationId,
  SESSION_CHUNK_PREFIX,
  uploadSourceKey,
  type MeetingObjectRef,
} from './keys.js';
import type {
  CompletedPart,
  GetObjectResult,
  MultipartSpec,
  MultipartUpload,
  PresignOptions,
  PresignedUpload,
  PresignUploadSpec,
  PutObjectBody,
  StorageService,
  StoredKeyRef,
  StoredObjectInfo,
  UploadSpec,
  UploadVerification,
} from './types.js';
import {
  assertSha256Base64,
  normalizeMimeType,
  sha256Base64ToHex,
  sha256HexToBase64,
  validateUploadSpec,
} from './validation.js';
import {
  InMemoryUploadTokenStore,
  isUploadToken,
  newUploadToken,
  UPLOAD_TOKEN_HEADER,
  UPLOAD_TOKEN_METADATA_KEY,
  type UploadTokenRecord,
  type UploadTokenStore,
} from './upload-tokens.js';

/** Metadata key holding the declared whole-object sha256 (base64) of a multipart upload. */
export const DECLARED_SHA256_METADATA_KEY = 'sha256';

/** Cap for server-written derived JSON artifacts (waveform peaks). */
export const MAX_DERIVED_JSON_BYTES = 1024 * 1024;

/** Recording session scope (contracts InitRecordingSession). meetingId must exist before chunks are uploaded. */
export type SessionRef = { meetingId: string; sessionId: string } & (
  | { organizationId: string; /** @deprecated Use organizationId (ADR-010). */ orgId?: string }
  | { organizationId?: string; /** @deprecated Use organizationId (ADR-010). */ orgId: string }
);

/** A key read from storage of record (file_objects.key or a cached key). Never rebuilt from ids. Alias of StoredKeyRef. */
export type StoredObjectKey = StoredKeyRef;

/** What the authorize hook sees: a derived ref (writes and ref reads) or a stored key (stored-key reads). */
export type AuthorizeTarget = MeetingObjectRef | StoredObjectKey;

/**
 * REQUIRED meeting-level authorization, run on every op after the org-prefix check
 * (e.g. "does this meeting belong to organizationId and may the caller access it?").
 * A derived ref always carries both organizationId and the deprecated orgId (same value) during ADR-010 compat. Throw to deny.
 */
export type AuthorizeHook = (target: AuthorizeTarget) => void | Promise<void>;

export type S3StorageServiceOptions = {
  config: StorageConfig;
  client?: S3Client;
  authorize: AuthorizeHook;
  presign?: typeof getSignedUrl;
  presignPost?: typeof createPresignedPost;
  /**
   * One-time upload token store. Defaults to a per-process InMemoryUploadTokenStore; inject a shared store
   * (e.g. RedisUploadTokenStore) when several API instances issue/confirm uploads.
   */
  uploadTokens?: UploadTokenStore;
};

export function createS3Client(config: StorageConfig): S3Client {
  return new S3Client({
    region: config.region,
    forcePathStyle: config.forcePathStyle,
    ...(config.endpoint ? { endpoint: config.endpoint } : {}),
    ...(config.accessKeyId && config.secretAccessKey
      ? {
          credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
        }
      : {}),
  });
}

export type BucketPrivacyResult = {
  status: 'private' | 'public' | 'unknown';
  checks: {
    policy: 'private' | 'public' | 'unsupported' | 'error';
    acl: 'private' | 'public' | 'unsupported' | 'error';
  };
};

const PUBLIC_GRANTEES = [
  'http://acs.amazonaws.com/groups/global/AllUsers',
  'http://acs.amazonaws.com/groups/global/AuthenticatedUsers',
];

async function settle<T>(p: Promise<T>): Promise<T> {
  try {
    return await p;
  } catch (err) {
    throw mapS3Error(err);
  }
}

export class S3StorageService implements StorageService {
  readonly #providerId;
  readonly #bucket: string;
  readonly #client: S3Client;
  readonly #cfg: StorageConfig;
  readonly #authorize: AuthorizeHook;
  readonly #presign: typeof getSignedUrl;
  readonly #presignPost: typeof createPresignedPost;
  readonly #tokens: UploadTokenStore;

  constructor(opts: S3StorageServiceOptions) {
    this.#cfg = opts.config;
    this.#providerId = opts.config.provider;
    this.#bucket = opts.config.bucket;
    this.#client = opts.client ?? createS3Client(opts.config);
    if (typeof opts.authorize !== 'function')
      throw new Error('S3StorageService requires an authorize hook');
    this.#authorize = opts.authorize;
    this.#presign = opts.presign ?? getSignedUrl;
    this.#presignPost = opts.presignPost ?? createPresignedPost;
    this.#tokens = opts.uploadTokens ?? new InMemoryUploadTokenStore();
  }

  /** Issue and record a fresh one-time token valid for the URL TTL plus the confirm grace window. */
  async #issueToken(rec: UploadTokenRecord, ttl: number): Promise<string> {
    for (let i = 0; i < 3; i++) {
      const token = newUploadToken();
      if (await this.#tokens.issue(token, rec, ttl + UPLOAD_CONFIRM_GRACE_SECONDS)) return token;
    }
    throw new Error('Could not issue upload token');
  }

  /** Consume a token (atomic in the store) and check it belongs to `key` (and `uploadId`). Reuse is rejected. */
  async #consumeToken(token: string, key: string, uploadId?: string): Promise<UploadTokenRecord> {
    if (!isUploadToken(token)) throw new StorageValidationError('Invalid upload token');
    const rec = await this.#tokens.consume(token);
    if (!rec || rec.key !== key || rec.uploadId !== uploadId)
      throw new StorageValidationError('Upload token invalid, expired or already used');
    return rec;
  }

  /** Derive the key server-side and always enforce org ownership. */
  async #key(ref: MeetingObjectRef): Promise<string> {
    if (!ref || typeof ref !== 'object') throw new StorageValidationError('ref is required');
    const normalized = normalizeMeetingObjectRef(ref);
    const key = buildObjectKey(normalized);
    assertKeyOwnedBy(key, normalized.organizationId, normalized.meetingId);
    await this.#authorize(normalized);
    return key;
  }

  /**
   * Validate a stored key for READS: owner (organizationId, meetingId) and shape must hold under organizations/ or the
   * legacy org/ prefix. The key is used as stored; it is never rebuilt from ids.
   */
  async #storedKey(s: StoredObjectKey): Promise<string> {
    if (!s || typeof s !== 'object') throw new StorageValidationError('stored key is required');
    assertKeyOwnedBy(s.key, s.organizationId, s.meetingId);
    if (!parseMeetingKey(s.key)) throw new StorageAccessError();
    await this.#authorize({ organizationId: s.organizationId, meetingId: s.meetingId, key: s.key });
    return s.key;
  }

  /** Read an object by its stored key (legacy org/ or organizations/). */
  async getObjectByKey(s: StoredObjectKey): Promise<GetObjectResult> {
    const key = await this.#storedKey(s);
    const res = await settle(
      this.#client.send(new GetObjectCommand({ Bucket: this.#bucket, Key: key })),
    );
    if (!res.Body) throw mapS3Error({ name: 'NoSuchKey' });
    const body =
      res.Body instanceof Readable
        ? res.Body
        : Readable.from(res.Body as unknown as AsyncIterable<Uint8Array>);
    return { body, info: toInfo(res) };
  }

  /**
   * Direct-upload source objects (`organizations/{org}/uploads/{uploadId}/source`, written by the API's presigned
   * upload). They are org- but not meeting-scoped, so they bypass the meeting authorize hook; the key is rebuilt from
   * validated ids (never taken from a caller), so only that org's upload can be read. Worker scan step only.
   */
  async headUploadSource(
    organizationId: string,
    uploadId: string,
  ): Promise<StoredObjectInfo | null> {
    const key = uploadSourceKey(organizationId, uploadId);
    try {
      return toInfo(
        await settle(this.#client.send(new HeadObjectCommand({ Bucket: this.#bucket, Key: key }))),
      );
    } catch (err) {
      if ((err as { code?: string }).code === 'NOT_FOUND') return null;
      throw err;
    }
  }

  async getUploadSource(organizationId: string, uploadId: string): Promise<GetObjectResult> {
    const key = uploadSourceKey(organizationId, uploadId);
    const res = await settle(
      this.#client.send(new GetObjectCommand({ Bucket: this.#bucket, Key: key })),
    );
    if (!res.Body) throw mapS3Error({ name: 'NoSuchKey' });
    const body =
      res.Body instanceof Readable
        ? res.Body
        : Readable.from(res.Body as unknown as AsyncIterable<Uint8Array>);
    return { body, info: toInfo(res) };
  }

  /** HEAD an object by its stored key; null when missing. */
  async headObjectByKey(s: StoredObjectKey): Promise<StoredObjectInfo | null> {
    const key = await this.#storedKey(s);
    try {
      return toInfo(
        await settle(this.#client.send(new HeadObjectCommand({ Bucket: this.#bucket, Key: key }))),
      );
    } catch (err) {
      if ((err as { code?: string }).code === 'NOT_FOUND') return null;
      throw err;
    }
  }

  /** Presigned GET for a stored key. Presigned URLs for existing objects must go through this, not a rebuilt ref. */
  async getPresignedDownloadUrlByKey(
    s: StoredObjectKey,
    opts?: PresignOptions,
  ): Promise<PresignedUrl> {
    const key = await this.#storedKey(s);
    const ttl = this.#ttl(opts, this.#cfg.downloadTtlSeconds);
    const url = await settle(
      this.#presign(
        this.#client,
        new GetObjectCommand({
          Bucket: this.#bucket,
          Key: key,
          ...downloadResponseOverrides(opts?.contentType),
        }),
        {
          expiresIn: ttl,
        },
      ),
    );
    return this.#presigned(url, 'GET', ttl);
  }

  #ttl(opts: PresignOptions | undefined, def: number): number {
    return assertTtl(opts?.ttlSeconds ?? def);
  }

  #presigned(
    url: string,
    method: PresignedUrl['method'],
    ttl: number,
    extra: Partial<PresignedUrl> = {},
  ): PresignedUrl {
    return { url, method, expiresAt: new Date(Date.now() + ttl * 1000), ...extra };
  }

  async putObject(ref: MeetingObjectRef, body: PutObjectBody, spec: UploadSpec) {
    const key = await this.#key(ref);
    validateUploadSpec(spec, this.#cfg.limits);
    if (!(body instanceof Readable)) {
      const actual = typeof body === 'string' ? Buffer.byteLength(body) : body.byteLength;
      if (actual !== spec.sizeBytes)
        throw new StorageValidationError('sizeBytes does not match body');
    }
    const res = await settle(
      this.#client.send(
        new PutObjectCommand({
          Bucket: this.#bucket,
          Key: key,
          Body: body,
          ContentType: normalizeMimeType(spec.mimeType),
          ContentLength: spec.sizeBytes,
          ChecksumSHA256: spec.checksumSha256,
          Metadata: spec.metadata,
        }),
      ),
    );
    return res.ETag ? { etag: res.ETag } : {};
  }

  /**
   * Server-side write of a small derived JSON artifact (currently only kind `waveform`). Derived and UNTRACKED: it has
   * no FileObject row, is deterministic per recording (safe to overwrite/regenerate) and must not be listed as a file. Not part of the client
   * upload allowlist (which is media-only); capped at MAX_DERIVED_JSON_BYTES.
   */
  async putDerivedJson(
    ref: MeetingObjectRef,
    value: unknown,
  ): Promise<{ etag?: string; sizeBytes: number }> {
    if (ref?.kind !== 'waveform')
      throw new StorageValidationError('Only waveform artifacts can be written as JSON');
    const key = await this.#key(ref);
    const body = Buffer.from(JSON.stringify(value), 'utf8');
    if (body.byteLength > MAX_DERIVED_JSON_BYTES)
      throw new StorageValidationError('Derived JSON too large');
    const res = await settle(
      this.#client.send(
        new PutObjectCommand({
          Bucket: this.#bucket,
          Key: key,
          Body: body,
          ContentType: 'application/json',
          ContentLength: body.byteLength,
        }),
      ),
    );
    return { ...(res.ETag ? { etag: res.ETag } : {}), sizeBytes: body.byteLength };
  }

  async getObject(ref: MeetingObjectRef): Promise<GetObjectResult> {
    const key = await this.#key(ref);
    const res = await settle(
      this.#client.send(new GetObjectCommand({ Bucket: this.#bucket, Key: key })),
    );
    if (!res.Body) throw mapS3Error({ name: 'NoSuchKey' });
    const body =
      res.Body instanceof Readable
        ? res.Body
        : Readable.from(res.Body as unknown as AsyncIterable<Uint8Array>);
    return { body, info: toInfo(res) };
  }

  async headObject(ref: MeetingObjectRef): Promise<StoredObjectInfo | null> {
    const key = await this.#key(ref);
    try {
      return toInfo(
        await settle(this.#client.send(new HeadObjectCommand({ Bucket: this.#bucket, Key: key }))),
      );
    } catch (err) {
      if ((err as { code?: string }).code === 'NOT_FOUND') return null;
      throw err;
    }
  }

  async deleteObject(ref: MeetingObjectRef): Promise<void> {
    const key = await this.#key(ref);
    await settle(this.#client.send(new DeleteObjectCommand({ Bucket: this.#bucket, Key: key })));
  }

  /**
   * Single-use presigned POST. Policy pins exact size, Content-Type, the base64 sha256 checksum and a one-time
   * `x-amz-meta-upload-token`. Limitation: POST policies cannot express If-None-Match, so a replay within the TTL can
   * re-POST the same bytes (the checksum pins the body); confirmUpload still accepts the token only once.
   */
  async getPresignedUploadPost(
    ref: MeetingObjectRef,
    spec: PresignUploadSpec,
    opts?: PresignOptions,
  ): Promise<PresignedUpload> {
    const key = await this.#key(ref);
    validateUploadSpec(spec, this.#cfg.limits);
    const checksum = assertSha256Base64(spec?.checksumSha256);
    const ttl = this.#ttl(opts, this.#cfg.uploadTtlSeconds);
    const mime = normalizeMimeType(spec.mimeType);
    const uploadToken = await this.#issueToken(
      { key, checksumSha256: checksum, sizeBytes: spec.sizeBytes },
      ttl,
    );
    const { url, fields } = await settle(
      this.#presignPost(this.#client, {
        Bucket: this.#bucket,
        Key: key,
        Expires: ttl,
        Conditions: [
          ['content-length-range', spec.sizeBytes, spec.sizeBytes],
          ['eq', '$Content-Type', mime],
          ['eq', '$x-amz-checksum-sha256', checksum],
          ['eq', `$${UPLOAD_TOKEN_HEADER}`, uploadToken],
        ],
        Fields: {
          'Content-Type': mime,
          'x-amz-checksum-sha256': checksum,
          [UPLOAD_TOKEN_HEADER]: uploadToken,
        },
      }),
    );
    return { ...this.#presigned(url, 'POST', ttl, { fields }), uploadToken };
  }

  /**
   * Single-use presigned PUT. Signs Content-Type, Content-Length, x-amz-checksum-sha256 (REQUIRED), a one-time
   * x-amz-meta-upload-token and `If-None-Match: *` (the PUT fails with 412 if the key already exists, on providers
   * that support conditional writes). The client must send `headers` verbatim.
   */
  async getPresignedUploadUrl(
    ref: MeetingObjectRef,
    spec: PresignUploadSpec,
    opts?: PresignOptions,
  ): Promise<PresignedUpload> {
    const key = await this.#key(ref);
    validateUploadSpec(spec, this.#cfg.limits);
    const checksum = assertSha256Base64(spec?.checksumSha256);
    const ttl = this.#ttl(opts, this.#cfg.uploadTtlSeconds);
    const mime = normalizeMimeType(spec.mimeType);
    const uploadToken = await this.#issueToken(
      { key, checksumSha256: checksum, sizeBytes: spec.sizeBytes },
      ttl,
    );
    const signed = [
      'content-type',
      'content-length',
      'x-amz-checksum-sha256',
      UPLOAD_TOKEN_HEADER,
      'if-none-match',
    ];
    const url = await settle(
      this.#presign(
        this.#client,
        new PutObjectCommand({
          Bucket: this.#bucket,
          Key: key,
          ContentType: mime,
          ContentLength: spec.sizeBytes,
          ChecksumSHA256: checksum,
          Metadata: { [UPLOAD_TOKEN_METADATA_KEY]: uploadToken },
          IfNoneMatch: '*',
        }),
        { expiresIn: ttl, signableHeaders: new Set(signed), unhoistableHeaders: new Set(signed) },
      ),
    );
    const headers = {
      'content-type': mime,
      'content-length': String(spec.sizeBytes),
      'x-amz-checksum-sha256': checksum,
      [UPLOAD_TOKEN_HEADER]: uploadToken,
      'if-none-match': '*',
    };
    return { ...this.#presigned(url, 'PUT', ttl, { headers }), uploadToken };
  }

  /**
   * Confirm a single-part (PUT/POST) upload: atomically consume the one-time token (reuse -> StorageValidationError),
   * then HEAD the object and require matching token metadata, size and sha256. A mismatching object is deleted.
   */
  async confirmUpload(ref: MeetingObjectRef, uploadToken: string): Promise<StoredObjectInfo> {
    const key = await this.#key(ref);
    const rec = await this.#consumeToken(uploadToken, key);
    let head;
    try {
      head = await settle(
        this.#client.send(
          new HeadObjectCommand({ Bucket: this.#bucket, Key: key, ChecksumMode: 'ENABLED' }),
        ),
      );
    } catch (err) {
      if ((err as { code?: string }).code === 'NOT_FOUND')
        throw new StorageValidationError('Upload not found');
      throw err;
    }
    const ok =
      head.Metadata?.[UPLOAD_TOKEN_METADATA_KEY] === uploadToken &&
      head.ContentLength === rec.sizeBytes &&
      head.ChecksumSHA256 === rec.checksumSha256;
    if (!ok) {
      await this.deleteObject(ref).catch(() => undefined);
      throw new StorageValidationError('Uploaded object does not match the presigned upload');
    }
    return toInfo(head);
  }

  /** HEAD with checksum mode; null when the object does not exist. */
  async #headWithChecksum(key: string) {
    try {
      return await settle(
        this.#client.send(
          new HeadObjectCommand({ Bucket: this.#bucket, Key: key, ChecksumMode: 'ENABLED' }),
        ),
      );
    } catch (err) {
      if ((err as { code?: string }).code === 'NOT_FOUND') return null;
      throw err;
    }
  }

  /** Stream the object and compute its sha256 (base64) and size. Used when S3 has no full-object checksum. */
  async #streamSha256(key: string): Promise<{ checksumSha256: string; sizeBytes: number }> {
    const res = await settle(
      this.#client.send(new GetObjectCommand({ Bucket: this.#bucket, Key: key })),
    );
    if (!res.Body) throw mapS3Error({ name: 'NoSuchKey' });
    const body =
      res.Body instanceof Readable
        ? res.Body
        : Readable.from(res.Body as unknown as AsyncIterable<Uint8Array>);
    const h = createHash('sha256');
    let sizeBytes = 0;
    for await (const chunk of body) {
      const b = typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Uint8Array);
      sizeBytes += b.byteLength;
      h.update(b);
    }
    return { checksumSha256: h.digest('base64'), sizeBytes };
  }

  /**
   * Verify-on-complete for a single-part upload. First call: consumes the one-time token and checks the object
   * (token metadata, size, sha256) via confirmUpload. Retries after a lost response: the token is gone, so the
   * object itself is the proof. It still carries this token in its metadata and a full-object sha256 that S3
   * enforced at PUT time (mismatching objects were deleted by the first call). Never trusts the client's hash.
   */
  async verifyUpload(ref: MeetingObjectRef, uploadToken: string): Promise<UploadVerification> {
    const key = await this.#key(ref);
    if (!isUploadToken(uploadToken)) throw new StorageValidationError('Invalid upload token');
    try {
      const info = await this.confirmUpload(ref, uploadToken);
      // confirmUpload's info carries hex (StoredObjectInfo boundary); convert back for the base64 field.
      if (!info.checksumSha256) throw new StorageValidationError('Upload has no sha256');
      return toVerification(sha256HexToBase64(info.checksumSha256), info.sizeBytes);
    } catch (err) {
      if (!(err instanceof StorageValidationError) || !/already used|expired/.test(err.message))
        throw err;
      const head = await this.#headWithChecksum(key);
      const sum = head?.ChecksumSHA256;
      if (
        !head ||
        head.Metadata?.[UPLOAD_TOKEN_METADATA_KEY] !== uploadToken ||
        !sum ||
        sum.includes('-')
      )
        throw err;
      return toVerification(sum, head.ContentLength ?? 0);
    }
  }

  /**
   * Complete a multipart upload (per-part checksums checked against ListParts) and verify the declared whole-object
   * sha256 by streaming the stored object (S3 only keeps a composite checksum for multipart). Retry-safe: when the
   * token was already consumed by an earlier complete, the object is re-hashed and must match the declared sha256
   * recorded at createMultipartUpload. A mismatching object is deleted.
   */
  async verifyMultipartUpload(
    ref: MeetingObjectRef,
    uploadId: string,
    parts: CompletedPart[],
    uploadToken: string,
  ): Promise<UploadVerification> {
    const key = await this.#key(ref);
    try {
      await this.completeMultipartUpload(ref, uploadId, parts, uploadToken);
    } catch (err) {
      // Retry after a lost response: the token is gone; fall through and verify the stored object itself.
      if (!(err instanceof StorageValidationError) || !/already used|expired/.test(err.message))
        throw err;
    }
    const head = await this.#headWithChecksum(key);
    if (!head) throw new StorageValidationError('Upload not found');
    const declared = head.Metadata?.[DECLARED_SHA256_METADATA_KEY];
    if (!declared) throw new StorageValidationError('Upload has no declared sha256');
    const actual = await this.#streamSha256(key);
    if (
      actual.checksumSha256 !== declared ||
      (head.ContentLength !== undefined && head.ContentLength !== actual.sizeBytes)
    ) {
      await this.deleteObject(ref).catch(() => undefined);
      throw new StorageValidationError('Uploaded object does not match the declared sha256');
    }
    return toVerification(actual.checksumSha256, actual.sizeBytes);
  }

  /**
   * Expiry cleanup for abandoned multipart uploads: abort every in-progress multipart upload under
   * organizations/ (plus legacy org/ and the session-chunk prefix) initiated before `olderThan` (default: now - upload TTL - confirm
   * grace). Single-part PUTs that were never confirmed are cleaned by the caller from its upload records
   * (status != verified and expiresAt + grace passed) via deleteObject, plus a bucket lifecycle rule as backstop.
   */
  async abortStaleMultipartUploads(olderThan?: Date): Promise<{ aborted: number }> {
    const cutoff =
      olderThan ??
      new Date(Date.now() - (this.#cfg.uploadTtlSeconds + UPLOAD_CONFIRM_GRACE_SECONDS) * 1000);
    let aborted = 0;
    // Legacy org/ uploads (pre ADR-010 Phase A) are swept too: writers no longer start them, so any left are abandoned.
    for (const prefix of [ORGANIZATIONS_KEY_PREFIX, LEGACY_ORG_KEY_PREFIX, SESSION_CHUNK_PREFIX]) {
      let keyMarker: string | undefined;
      let uploadIdMarker: string | undefined;
      for (let page = 0; page < 1000; page++) {
        const res = await settle(
          this.#client.send(
            new ListMultipartUploadsCommand({
              Bucket: this.#bucket,
              Prefix: prefix,
              KeyMarker: keyMarker,
              UploadIdMarker: uploadIdMarker,
            }),
          ),
        );
        for (const u of res.Uploads ?? []) {
          if (!u.Key || !u.UploadId || !u.Initiated || u.Initiated >= cutoff) continue;
          await settle(
            this.#client.send(
              new AbortMultipartUploadCommand({
                Bucket: this.#bucket,
                Key: u.Key,
                UploadId: u.UploadId,
              }),
            ),
          );
          aborted++;
        }
        if (!res.IsTruncated) break;
        keyMarker = res.NextKeyMarker;
        uploadIdMarker = res.NextUploadIdMarker;
      }
    }
    return { aborted };
  }

  async getPresignedDownloadUrl(
    ref: MeetingObjectRef,
    opts?: PresignOptions,
  ): Promise<PresignedUrl> {
    const key = await this.#key(ref);
    const ttl = this.#ttl(opts, this.#cfg.downloadTtlSeconds);
    const url = await settle(
      this.#presign(
        this.#client,
        new GetObjectCommand({
          Bucket: this.#bucket,
          Key: key,
          ...downloadResponseOverrides(opts?.contentType),
        }),
        {
          expiresIn: ttl,
        },
      ),
    );
    return this.#presigned(url, 'GET', ttl);
  }

  #checkPartSize(partSizeBytes: number): void {
    const { maxPartBytes } = this.#cfg.limits;
    if (!Number.isInteger(partSizeBytes) || partSizeBytes < 1 || partSizeBytes > maxPartBytes) {
      throw new StorageValidationError('partSizeBytes out of range');
    }
  }

  #checkPartNumber(partNumber: number): void {
    if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > this.#cfg.limits.maxParts) {
      throw new StorageValidationError('partNumber out of range');
    }
  }

  async createMultipartUpload(
    ref: MeetingObjectRef,
    spec: MultipartSpec,
  ): Promise<MultipartUpload> {
    const key = await this.#key(ref);
    validateUploadSpec(spec, this.#cfg.limits);
    const checksum = assertSha256Base64(spec?.checksumSha256);
    this.#checkPartSize(spec.partSizeBytes);
    if (spec.partSizeBytes < S3_MIN_PART_BYTES && spec.partSizeBytes < spec.sizeBytes) {
      throw new StorageValidationError('partSizeBytes below provider minimum');
    }
    const partCount = Math.ceil(spec.sizeBytes / spec.partSizeBytes);
    if (partCount > this.#cfg.limits.maxParts) throw new StorageValidationError('Too many parts');
    const res = await settle(
      this.#client.send(
        new CreateMultipartUploadCommand({
          Bucket: this.#bucket,
          Key: key,
          ContentType: normalizeMimeType(spec.mimeType),
          ChecksumAlgorithm: 'SHA256',
          Metadata: { ...spec.metadata, [DECLARED_SHA256_METADATA_KEY]: checksum },
        }),
      ),
    );
    if (!res.UploadId) throw mapS3Error(new Error('missing UploadId'));
    const uploadToken = await this.#issueToken(
      { key, checksumSha256: checksum, sizeBytes: spec.sizeBytes, uploadId: res.UploadId },
      this.#cfg.uploadTtlSeconds,
    );
    return { uploadId: res.UploadId, partCount, partSizeBytes: spec.partSizeBytes, uploadToken };
  }

  async getPresignedPartUrl(
    ref: MeetingObjectRef,
    uploadId: string,
    partNumber: number,
    partSizeBytes: number,
    partChecksumSha256: string,
    opts?: PresignOptions,
  ): Promise<PresignedUrl> {
    const key = await this.#key(ref);
    this.#checkPartNumber(partNumber);
    this.#checkPartSize(partSizeBytes);
    const checksum = assertSha256Base64(partChecksumSha256, 'partChecksumSha256');
    const ttl = this.#ttl(opts, this.#cfg.uploadTtlSeconds);
    const signed = ['content-length', 'x-amz-checksum-sha256'];
    const url = await settle(
      this.#presign(
        this.#client,
        new UploadPartCommand({
          Bucket: this.#bucket,
          Key: key,
          UploadId: uploadId,
          PartNumber: partNumber,
          ContentLength: partSizeBytes,
          ChecksumSHA256: checksum,
        }),
        { expiresIn: ttl, signableHeaders: new Set(signed), unhoistableHeaders: new Set(signed) },
      ),
    );
    return this.#presigned(url, 'PUT', ttl, {
      headers: { 'content-length': String(partSizeBytes), 'x-amz-checksum-sha256': checksum },
    });
  }

  async listParts(ref: MeetingObjectRef, uploadId: string): Promise<CompletedPart[]> {
    const key = await this.#key(ref);
    const out: CompletedPart[] = [];
    let marker: string | undefined;
    do {
      const res = await settle(
        this.#client.send(
          new ListPartsCommand({
            Bucket: this.#bucket,
            Key: key,
            UploadId: uploadId,
            PartNumberMarker: marker,
          }),
        ),
      );
      for (const p of res.Parts ?? []) {
        if (p.PartNumber !== undefined && p.ETag)
          out.push({
            partNumber: p.PartNumber,
            etag: p.ETag,
            ...(p.ChecksumSHA256 ? { checksumSha256: p.ChecksumSHA256 } : {}),
          });
      }
      marker = res.IsTruncated ? res.NextPartNumberMarker : undefined;
      if (out.length > this.#cfg.limits.maxParts)
        throw new StorageValidationError('Too many parts');
    } while (marker);
    return out;
  }

  /**
   * Complete a multipart upload once: consumes the one-time token first (a second complete is rejected), requires a
   * base64 sha256 per part that matches what the provider stored (ListParts), sends per-part ChecksumSHA256 and
   * `If-None-Match: *` so an existing completed key is not overwritten. Limitation: S3 multipart SHA256 is a
   * composite (checksum of part checksums), so the declared whole-object sha256 is stored as metadata but is NOT
   * verified by the provider; verify it when the object is read (e.g. the worker hashes while downloading).
   */
  async completeMultipartUpload(
    ref: MeetingObjectRef,
    uploadId: string,
    parts: CompletedPart[],
    uploadToken: string,
  ) {
    const key = await this.#key(ref);
    if (parts.length === 0) throw new StorageValidationError('At least one part is required');
    if (parts.length > this.#cfg.limits.maxParts)
      throw new StorageValidationError('Too many parts');
    parts.forEach((p) => {
      this.#checkPartNumber(p.partNumber);
      assertSha256Base64(p.checksumSha256, 'part checksumSha256');
    });
    const sorted = [...parts].sort((a, b) => a.partNumber - b.partNumber);
    if (sorted.some((p, i) => i > 0 && p.partNumber === sorted[i - 1]!.partNumber))
      throw new StorageValidationError('Duplicate part');
    await this.#consumeToken(uploadToken, key, uploadId);
    const stored = new Map((await this.listParts(ref, uploadId)).map((p) => [p.partNumber, p]));
    for (const p of sorted) {
      const s = stored.get(p.partNumber);
      if (!s || s.etag !== p.etag || s.checksumSha256 !== p.checksumSha256)
        throw new StorageValidationError(`Part ${p.partNumber} checksum mismatch`);
    }
    const res = await settle(
      this.#client.send(
        new CompleteMultipartUploadCommand({
          Bucket: this.#bucket,
          Key: key,
          UploadId: uploadId,
          IfNoneMatch: '*',
          MultipartUpload: {
            Parts: sorted.map((p) => ({
              PartNumber: p.partNumber,
              ETag: p.etag,
              ChecksumSHA256: p.checksumSha256,
            })),
          },
        }),
      ),
    );
    return res.ETag ? { etag: res.ETag } : {};
  }

  async abortMultipartUpload(ref: MeetingObjectRef, uploadId: string): Promise<void> {
    const key = await this.#key(ref);
    await settle(
      this.#client.send(
        new AbortMultipartUploadCommand({ Bucket: this.#bucket, Key: key, UploadId: uploadId }),
      ),
    );
  }

  // ---- Recording-session chunked upload (contracts v0.2 api/recording-sessions, #38 @ f85a9d3) ----

  #sessionRef(ref: SessionRef, seq: number): MeetingObjectRef {
    if (!Number.isInteger(seq) || seq < 0 || seq > MAX_CHUNKS - 1)
      throw new StorageValidationError('seq out of range');
    return {
      organizationId: refOrganizationId(ref),
      meetingId: ref.meetingId,
      kind: 'session_chunk',
      objectId: ref.sessionId,
      index: seq,
    };
  }

  /** List stored chunks of a session (seq -> size). Non-chunk objects under the prefix are reported as extra. */
  async #listSession(ref: SessionRef): Promise<{ chunks: Map<number, number>; extra: number }> {
    const key0 = await this.#key(this.#sessionRef(ref, 0));
    const prefix = key0.slice(0, key0.lastIndexOf('/') + 1);
    const chunks = new Map<number, number>();
    let extra = 0;
    let token: string | undefined;
    do {
      const res = await settle(
        this.#client.send(
          new ListObjectsV2Command({
            Bucket: this.#bucket,
            Prefix: prefix,
            ContinuationToken: token,
          }),
        ),
      );
      for (const o of res.Contents ?? []) {
        const m = /^(\d{5})\.part$/.exec((o.Key ?? '').slice(prefix.length));
        if (m) chunks.set(Number(m[1]), o.Size ?? 0);
        else extra++;
      }
      token = res.IsTruncated ? res.NextContinuationToken : undefined;
      if (chunks.size > MAX_CHUNKS) throw new StorageValidationError('Too many chunks');
    } while (token);
    return { chunks, extra };
  }

  /**
   * Presigned PUT for one session chunk (contracts ChunkUploadUrlRequest -> ChunkUploadUrlResponse.upload).
   * Signs Content-Type, Content-Length = sizeBytes, x-amz-checksum-sha256 (sha256 hex is REQUIRED) and
   * `If-None-Match: *` (a stored chunk cannot be overwritten by replaying the URL). Refuses when seq is out of
   * range or already stored, or when the stored running total + sizeBytes would exceed the session cap.
   * TTL defaults to and is capped at CHUNK_UPLOAD_URL_TTL_SECONDS (300).
   */
  async getPresignedSessionChunkUrl(
    ref: SessionRef,
    req: { seq: number; sizeBytes: number; sha256: string },
    mimeType: string,
    opts?: PresignOptions,
  ): Promise<PresignedUrl> {
    const objRef = this.#sessionRef(ref, req.seq);
    const key = await this.#key(objRef);
    if (!Number.isInteger(req.sizeBytes) || req.sizeBytes < 1 || req.sizeBytes > MAX_CHUNK_BYTES) {
      throw new StorageValidationError('sizeBytes out of range');
    }
    if (req.sha256 === undefined || req.sha256 === null)
      throw new StorageValidationError('sha256 is required');
    if (typeof req.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(req.sha256))
      throw new StorageValidationError('Invalid sha256');
    validateUploadSpec({ mimeType, sizeBytes: req.sizeBytes }, this.#cfg.limits);
    const ttl = assertTtl(opts?.ttlSeconds ?? SESSION_CHUNK_TTL_SECONDS);
    if (ttl > SESSION_CHUNK_TTL_SECONDS)
      throw new RangeError(`Session chunk TTL must be <= ${SESSION_CHUNK_TTL_SECONDS}s`);

    const { chunks } = await this.#listSession(ref);
    if (chunks.has(req.seq)) throw new StorageValidationError('Chunk already uploaded');
    let running = 0;
    for (const size of chunks.values()) running += size;
    if (running + req.sizeBytes > this.#cfg.limits.maxObjectBytes)
      throw new StorageValidationError('Recording session exceeds maximum size');

    const mime = normalizeMimeType(mimeType);
    const checksum = sha256HexToBase64(req.sha256);
    const signed = ['content-type', 'content-length', 'x-amz-checksum-sha256', 'if-none-match'];
    const url = await settle(
      this.#presign(
        this.#client,
        new PutObjectCommand({
          Bucket: this.#bucket,
          Key: key,
          ContentType: mime,
          ContentLength: req.sizeBytes,
          ChecksumSHA256: checksum,
          IfNoneMatch: '*',
        }),
        { expiresIn: ttl, signableHeaders: new Set(signed), unhoistableHeaders: new Set(signed) },
      ),
    );
    const headers: Record<string, string> = {
      'content-type': mime,
      'content-length': String(req.sizeBytes),
      'x-amz-checksum-sha256': checksum,
      'if-none-match': '*',
    };
    return this.#presigned(url, 'PUT', ttl, { headers });
  }

  /**
   * CompleteRecordingSession: stored chunks must be exactly seq 0..chunkCount-1 (no gaps, no extras). Each is
   * HEAD-checked: size <= MAX_CHUNK_BYTES and, when `chunks` is given, equal sizeBytes/sha256. An oversized or
   * mismatching chunk is deleted immediately; any failure deletes ALL session chunks, then throws.
   */
  async verifySessionChunks(
    ref: SessionRef,
    complete: {
      chunkCount: number;
      chunks?: Array<{ seq: number; sha256: string; sizeBytes?: number }>;
    },
  ): Promise<{ totalBytes: number; chunkSizes: number[] }> {
    const { chunkCount } = complete;
    if (!Number.isInteger(chunkCount) || chunkCount < 1 || chunkCount > MAX_CHUNKS) {
      throw new StorageValidationError('chunkCount out of range');
    }
    try {
      const declared = new Map<number, { sha256: string; sizeBytes?: number }>();
      for (const c of complete.chunks ?? []) {
        if (declared.has(c.seq) || c.seq >= chunkCount)
          throw new StorageValidationError('Invalid chunk manifest');
        declared.set(c.seq, c);
      }
      if (complete.chunks && declared.size !== chunkCount)
        throw new StorageValidationError('Invalid chunk manifest');
      const listed = await this.#listSession(ref);
      if (listed.extra > 0 || [...listed.chunks.keys()].some((seq) => seq >= chunkCount)) {
        throw new StorageValidationError('Unexpected objects in session');
      }
      const sizes: number[] = [];
      let total = 0;
      for (let seq = 0; seq < chunkCount; seq++) {
        const objRef = this.#sessionRef(ref, seq);
        const key = await this.#key(objRef);
        let head;
        try {
          head = await settle(
            this.#client.send(
              new HeadObjectCommand({ Bucket: this.#bucket, Key: key, ChecksumMode: 'ENABLED' }),
            ),
          );
        } catch (err) {
          if ((err as { code?: string }).code === 'NOT_FOUND')
            throw new StorageValidationError(`Missing chunk seq ${seq}`);
          throw err;
        }
        const size = head.ContentLength ?? 0;
        const d = declared.get(seq);
        const bad =
          size < 1 ||
          size > MAX_CHUNK_BYTES ||
          (d?.sizeBytes !== undefined && d.sizeBytes !== size) ||
          // Every chunk URL signs a sha256, so a stored chunk without one was not uploaded through it.
          !head.ChecksumSHA256 ||
          (d !== undefined && head.ChecksumSHA256 !== sha256HexToBase64(d.sha256));
        if (bad) {
          await this.deleteObject(objRef).catch(() => undefined);
          throw new StorageValidationError(`Chunk seq ${seq} rejected`);
        }
        total += size;
        if (total > this.#cfg.limits.maxObjectBytes)
          throw new StorageValidationError('Recording session exceeds maximum size');
        sizes.push(size);
      }
      return { totalBytes: total, chunkSizes: sizes };
    } catch (err) {
      await this.abortSession(ref).catch(() => undefined);
      throw err;
    }
  }

  /** AbortRecordingSession / failed verify: delete every stored chunk of the session. */
  async abortSession(ref: SessionRef): Promise<{ deleted: number }> {
    const { chunks } = await this.#listSession(ref);
    let deleted = 0;
    for (const seq of chunks.keys()) {
      await this.deleteObject(this.#sessionRef(ref, seq)).catch((err: unknown) => {
        if ((err as { code?: string }).code !== 'NOT_FOUND') throw err;
      });
      deleted++;
    }
    return { deleted };
  }

  /**
   * Best-effort startup check that the bucket is not public (policy status + ACL grants).
   * Providers that don't implement these APIs (e.g. R2, some MinIO setups) report "unsupported".
   */
  async verifyBucketPrivate(): Promise<BucketPrivacyResult> {
    const unsupported = (err: unknown) => {
      const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
      return (
        ['NotImplemented', 'NoSuchBucketPolicy', 'MethodNotAllowed', 'XNotImplemented'].includes(
          e?.name ?? '',
        ) ||
        e?.$metadata?.httpStatusCode === 501 ||
        e?.$metadata?.httpStatusCode === 405
      );
    };
    const checks: BucketPrivacyResult['checks'] = { policy: 'error', acl: 'error' };
    try {
      const r = await this.#client.send(new GetBucketPolicyStatusCommand({ Bucket: this.#bucket }));
      checks.policy = r.PolicyStatus?.IsPublic ? 'public' : 'private';
    } catch (err) {
      checks.policy =
        (err as { name?: string }).name === 'NoSuchBucketPolicy'
          ? 'private'
          : unsupported(err)
            ? 'unsupported'
            : 'error';
    }
    try {
      const r = await this.#client.send(new GetBucketAclCommand({ Bucket: this.#bucket }));
      const pub = (r.Grants ?? []).some(
        (g) => g.Grantee?.URI && PUBLIC_GRANTEES.includes(g.Grantee.URI),
      );
      checks.acl = pub ? 'public' : 'private';
    } catch (err) {
      checks.acl = unsupported(err) ? 'unsupported' : 'error';
    }
    const status =
      checks.policy === 'public' || checks.acl === 'public'
        ? 'public'
        : checks.policy === 'private' && checks.acl === 'private'
          ? 'private'
          : 'unknown';
    return { status, checks };
  }

  /**
   * INTERNAL (api/worker only): head the object and return a contracts FileObject, which
   * includes provider/bucket/key. Never send this to clients; map with toPublicFileObject.
   * Returns null when the object is missing.
   */
  async describeObject(
    ref: MeetingObjectRef,
    fileObjectId: string,
    createdAt?: Date,
  ): Promise<FileObject | null> {
    const info = await this.headObject(ref);
    if (!info) return null;
    const f: FileObject = {
      id: fileObjectId,
      organizationId: refOrganizationId(ref),
      provider: this.#providerId,
      bucket: this.#bucket,
      key: buildObjectKey(ref),
      mimeType: info.mimeType ?? 'application/octet-stream',
      sizeBytes: info.sizeBytes,
      createdAt: (createdAt ?? info.updatedAt ?? new Date()).toISOString(),
    };
    if (info.checksumSha256) f.checksumSha256 = info.checksumSha256;
    return f;
  }
}

/** Takes the S3 base64 digest; returns hex in sha256/checksumSha256 and base64 only in checksumSha256Base64. */
function toVerification(checksumBase64: string | undefined, sizeBytes: number): UploadVerification {
  if (!checksumBase64) throw new StorageValidationError('Upload has no sha256');
  const hex = sha256Base64ToHex(checksumBase64);
  return {
    verified: true,
    sha256: hex,
    checksumSha256: hex,
    checksumSha256Base64: checksumBase64,
    sizeBytes,
  };
}

function toInfo(res: {
  ContentLength?: number | undefined;
  ContentType?: string | undefined;
  ETag?: string | undefined;
  ChecksumSHA256?: string | undefined;
  LastModified?: Date | undefined;
  Metadata?: Record<string, string> | undefined;
}): StoredObjectInfo {
  const m: StoredObjectInfo = { sizeBytes: res.ContentLength ?? 0 };
  if (res.ContentType) m.mimeType = res.ContentType;
  if (res.ETag) m.etag = res.ETag;
  // Boundary: S3 reports base64; StoredObjectInfo/FileObject carry lowercase hex. Multipart objects only have a
  // composite checksum ("<b64>-<parts>"), which is not a whole-object sha256, so it is omitted rather than converted.
  if (res.ChecksumSHA256 && !/-\d+$/.test(res.ChecksumSHA256))
    m.checksumSha256 = sha256Base64ToHex(res.ChecksumSHA256);
  if (res.LastModified) m.updatedAt = res.LastModified;
  if (res.Metadata && Object.keys(res.Metadata).length) m.metadata = res.Metadata;
  return m;
}

export function createStorageServiceFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  opts: Omit<S3StorageServiceOptions, 'config'>,
): S3StorageService {
  return new S3StorageService({ ...opts, config: loadStorageConfig(env) });
}

const UPLOAD_SOURCE_KEY_RE = /^organizations\/([^/]+)\/uploads\/([^/]+)\/source$/;
/** API recording-session chunk keys: organizations/{org}/recording-sessions/{sessionId}/chunks/{seq:5}. */
const SESSION_CHUNK_KEY_RE = /^organizations\/([^/]+)\/recording-sessions\/([^/]+)\/chunks\/(\d{5})$/;

/** Rebuilds an upload-source or session-chunk key from its parsed ids; rejects anything else (no arbitrary keys). */
function assertUploadSourceKey(key: string, allowChunks = false): string {
  const k = typeof key === 'string' ? key : '';
  const m = UPLOAD_SOURCE_KEY_RE.exec(k);
  if (m && uploadSourceKey(m[1]!, m[2]!) === k) return k;
  const c = allowChunks ? SESSION_CHUNK_KEY_RE.exec(k) : null;
  if (c && `${organizationPrefix(c[1]!)}recording-sessions/${uploadSourceIdCheck(c[2]!)}/chunks/${c[3]!}` === k) {
    return k;
  }
  throw new StorageValidationError('Invalid upload source key');
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function uploadSourceIdCheck(v: string): string {
  if (!UUID_RE.test(v)) throw new StorageValidationError('Invalid sessionId');
  return v;
}

export type S3UploadSourceSignerOptions = {
  config: StorageConfig;
  client?: S3Client;
  presign?: typeof getSignedUrl;
  now?: () => Date;
};

/**
 * Key-level signer for the API's direct uploads (organizations/{org}/uploads/{uploadId}/source), shaped like the
 * apps/api MediaSigner port. Only upload-source keys are accepted. PUTs sign Content-Type, Content-Length and
 * x-amz-checksum-sha256; GETs force attachment + an allowlisted content type; HEAD uses checksum mode.
 */
export class S3UploadSourceSigner {
  readonly #client: S3Client;
  readonly #bucket: string;
  readonly #cfg: StorageConfig;
  readonly #presign: typeof getSignedUrl;
  readonly #now: () => Date;

  constructor(opts: S3UploadSourceSignerOptions) {
    this.#cfg = opts.config;
    this.#bucket = opts.config.bucket;
    this.#client = opts.client ?? createS3Client(opts.config);
    this.#presign = opts.presign ?? getSignedUrl;
    this.#now = opts.now ?? (() => new Date());
  }

  get bucket(): string {
    return this.#bucket;
  }

  #expiresAt(ttl: number): Date {
    return new Date(this.#now().getTime() + ttl * 1000);
  }

  async presignPut(s: {
    key: string;
    mimeType: string;
    sizeBytes: number;
    checksumSha256Base64: string;
    ttlSeconds: number;
  }): Promise<{ url: string; method: 'PUT'; headers: Record<string, string>; expiresAt: Date }> {
    const key = assertUploadSourceKey(s.key, true);
    validateUploadSpec({ mimeType: s.mimeType, sizeBytes: s.sizeBytes }, this.#cfg.limits);
    const checksum = assertSha256Base64(s.checksumSha256Base64);
    const ttl = assertTtl(s.ttlSeconds);
    const mime = normalizeMimeType(s.mimeType);
    const signed = ['content-type', 'content-length', 'x-amz-checksum-sha256'];
    const url = await settle(
      this.#presign(
        this.#client,
        new PutObjectCommand({
          Bucket: this.#bucket,
          Key: key,
          ContentType: mime,
          ContentLength: s.sizeBytes,
          ChecksumSHA256: checksum,
        }),
        { expiresIn: ttl, signableHeaders: new Set(signed), unhoistableHeaders: new Set(signed) },
      ),
    );
    return {
      url,
      method: 'PUT',
      headers: {
        'content-type': mime,
        'content-length': String(s.sizeBytes),
        'x-amz-checksum-sha256': checksum,
      },
      expiresAt: this.#expiresAt(ttl),
    };
  }

  async presignGet(s: {
    key: string;
    ttlSeconds: number;
    contentType: string;
  }): Promise<{ url: string; method: 'GET'; headers: Record<string, string>; expiresAt: Date }> {
    const key = assertUploadSourceKey(s.key);
    const ttl = assertTtl(s.ttlSeconds);
    const url = await settle(
      this.#presign(
        this.#client,
        new GetObjectCommand({
          Bucket: this.#bucket,
          Key: key,
          ...downloadResponseOverrides(s.contentType),
        }),
        { expiresIn: ttl },
      ),
    );
    return { url, method: 'GET', headers: {}, expiresAt: this.#expiresAt(ttl) };
  }

  /** Size + full-object SHA-256 (base64); checksum null when absent or a multipart composite. Null when missing. */
  async head(key: string): Promise<{ sizeBytes: number; checksumSha256Base64: string | null } | null> {
    const k = assertUploadSourceKey(key, true);
    let res;
    try {
      res = await settle(
        this.#client.send(
          new HeadObjectCommand({ Bucket: this.#bucket, Key: k, ChecksumMode: 'ENABLED' }),
        ),
      );
    } catch (err) {
      if ((err as { code?: string }).code === 'NOT_FOUND') return null;
      throw err;
    }
    const c = res.ChecksumSHA256;
    return {
      sizeBytes: res.ContentLength ?? 0,
      checksumSha256Base64: c && !c.includes('-') ? c : null,
    };
  }
}

/** Throws unless `key` is an API recording-session chunk key of `organizationId` (and `sessionId` when given). */
export function assertSessionChunkKey(key: string, organizationId: string, sessionId?: string): string {
  const k = typeof key === 'string' ? key : '';
  const c = SESSION_CHUNK_KEY_RE.exec(k);
  if (
    !c ||
    c[1] !== organizationId ||
    (sessionId !== undefined && c[2] !== sessionId) ||
    `${organizationPrefix(c[1])}recording-sessions/${uploadSourceIdCheck(c[2]!)}/chunks/${c[3]!}` !== k
  ) {
    throw new StorageAccessError();
  }
  return k;
}

/**
 * Worker-side reader/deleter for API recording-session chunks (organizations/{org}/recording-sessions/{sid}/chunks/
 * {seq5}). Every call is bound to an org + session; keys of another org or session are refused.
 */
export class S3SessionChunkStore {
  readonly #client: S3Client;
  readonly #bucket: string;

  constructor(opts: { config: StorageConfig; client?: S3Client }) {
    this.#bucket = opts.config.bucket;
    this.#client = opts.client ?? createS3Client(opts.config);
  }

  /** Streams a chunk; StorageNotFoundError when it is missing. */
  async readChunk(organizationId: string, sessionId: string, key: string): Promise<Readable> {
    const k = assertSessionChunkKey(key, organizationId, sessionId);
    const res = await settle(this.#client.send(new GetObjectCommand({ Bucket: this.#bucket, Key: k })));
    if (!res.Body) throw mapS3Error({ name: 'NoSuchKey' });
    return res.Body instanceof Readable
      ? res.Body
      : Readable.from(res.Body as unknown as AsyncIterable<Uint8Array>);
  }

  /** Idempotent delete (S3 DeleteObject succeeds for a missing key). */
  async deleteChunk(organizationId: string, sessionId: string, key: string): Promise<void> {
    const k = assertSessionChunkKey(key, organizationId, sessionId);
    await settle(this.#client.send(new DeleteObjectCommand({ Bucket: this.#bucket, Key: k })));
  }
}

const SOURCE_EXT_BY_MIME: Record<string, MediaSourceExtLike> = {
  'audio/webm': 'webm',
  'video/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'video/mp4': 'mp4',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/wave': 'wav',
};
type MediaSourceExtLike = 'webm' | 'ogg' | 'mp3' | 'm4a' | 'mp4' | 'wav';

/** Recording source extension for a (parameterised) media mime type, or null when it is not a source type. */
export function sourceExtForMime(mimeType: string): MediaSourceExtLike | null {
  const base = (mimeType.split(';')[0] ?? '').trim().toLowerCase();
  return SOURCE_EXT_BY_MIME[base] ?? null;
}
