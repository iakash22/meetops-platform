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
  ListPartsCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import type { FileObject } from '@meetops/contracts';
import type { PresignedUrl } from '@meetops/contracts/legacy';
import { MAX_CHUNK_BYTES, MAX_RECORDING_CHUNKS } from '@meetops/contracts';
import { assertTtl, loadStorageConfig, S3_MIN_PART_BYTES, SESSION_CHUNK_TTL_SECONDS, type StorageConfig } from './config.js';
import { mapS3Error, StorageValidationError } from './errors.js';
import { assertKeyOwnedBy, buildObjectKey, type MeetingObjectRef } from './keys.js';
import type {
  CompletedPart,
  GetObjectResult,
  MultipartSpec,
  MultipartUpload,
  PresignOptions,
  PutObjectBody,
  StorageService,
  StoredObjectInfo,
  UploadSpec
} from './types.js';
import { normalizeMimeType, validateUploadSpec } from './validation.js';

/** Recording session scope (contracts InitRecordingSession). meetingId must exist before chunks are uploaded. */
export type SessionRef = { orgId: string; meetingId: string; sessionId: string };

/** Extra authorization on top of the mandatory org-prefix check (e.g. meeting membership). */
export type AuthorizeHook = (ref: MeetingObjectRef) => void | Promise<void>;

export type S3StorageServiceOptions = {
  config: StorageConfig;
  client?: S3Client;
  authorize?: AuthorizeHook;
  presign?: typeof getSignedUrl;
  presignPost?: typeof createPresignedPost;
};

export function createS3Client(config: StorageConfig): S3Client {
  return new S3Client({
    region: config.region,
    forcePathStyle: config.forcePathStyle,
    ...(config.endpoint ? { endpoint: config.endpoint } : {}),
    ...(config.accessKeyId && config.secretAccessKey
      ? { credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey } }
      : {})
  });
}

export type BucketPrivacyResult = {
  status: 'private' | 'public' | 'unknown';
  checks: { policy: 'private' | 'public' | 'unsupported' | 'error'; acl: 'private' | 'public' | 'unsupported' | 'error' };
};

const PUBLIC_GRANTEES = ['http://acs.amazonaws.com/groups/global/AllUsers', 'http://acs.amazonaws.com/groups/global/AuthenticatedUsers'];

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
  readonly #authorize: AuthorizeHook | undefined;
  readonly #presign: typeof getSignedUrl;
  readonly #presignPost: typeof createPresignedPost;

  constructor(opts: S3StorageServiceOptions) {
    this.#cfg = opts.config;
    this.#providerId = opts.config.provider;
    this.#bucket = opts.config.bucket;
    this.#client = opts.client ?? createS3Client(opts.config);
    this.#authorize = opts.authorize;
    this.#presign = opts.presign ?? getSignedUrl;
    this.#presignPost = opts.presignPost ?? createPresignedPost;
  }

  /** Derive the key server-side and always enforce org ownership. */
  async #key(ref: MeetingObjectRef): Promise<string> {
    if (!ref || typeof ref !== 'object') throw new StorageValidationError('ref is required');
    const key = buildObjectKey(ref);
    assertKeyOwnedBy(key, ref.orgId);
    if (this.#authorize) await this.#authorize(ref);
    return key;
  }

  #ttl(opts: PresignOptions | undefined, def: number): number {
    return assertTtl(opts?.ttlSeconds ?? def);
  }

  #presigned(url: string, method: PresignedUrl['method'], ttl: number, extra: Partial<PresignedUrl> = {}): PresignedUrl {
    return { url, method, expiresAt: new Date(Date.now() + ttl * 1000), ...extra };
  }

  async putObject(ref: MeetingObjectRef, body: PutObjectBody, spec: UploadSpec) {
    const key = await this.#key(ref);
    validateUploadSpec(spec, this.#cfg.limits);
    if (!(body instanceof Readable)) {
      const actual = typeof body === 'string' ? Buffer.byteLength(body) : body.byteLength;
      if (actual !== spec.sizeBytes) throw new StorageValidationError('sizeBytes does not match body');
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
          Metadata: spec.metadata
        })
      )
    );
    return res.ETag ? { etag: res.ETag } : {};
  }

  async getObject(ref: MeetingObjectRef): Promise<GetObjectResult> {
    const key = await this.#key(ref);
    const res = await settle(this.#client.send(new GetObjectCommand({ Bucket: this.#bucket, Key: key })));
    if (!res.Body) throw mapS3Error({ name: 'NoSuchKey' });
    const body = res.Body instanceof Readable ? res.Body : Readable.from(res.Body as unknown as AsyncIterable<Uint8Array>);
    return { body, info: toInfo(res) };
  }

  async headObject(ref: MeetingObjectRef): Promise<StoredObjectInfo | null> {
    const key = await this.#key(ref);
    try {
      return toInfo(await settle(this.#client.send(new HeadObjectCommand({ Bucket: this.#bucket, Key: key }))));
    } catch (err) {
      if ((err as { code?: string }).code === 'NOT_FOUND') return null;
      throw err;
    }
  }

  async deleteObject(ref: MeetingObjectRef): Promise<void> {
    const key = await this.#key(ref);
    await settle(this.#client.send(new DeleteObjectCommand({ Bucket: this.#bucket, Key: key })));
  }

  async getPresignedUploadPost(ref: MeetingObjectRef, spec: UploadSpec, opts?: PresignOptions): Promise<PresignedUrl> {
    const key = await this.#key(ref);
    validateUploadSpec(spec, this.#cfg.limits);
    const ttl = this.#ttl(opts, this.#cfg.uploadTtlSeconds);
    const mime = normalizeMimeType(spec.mimeType);
    const { url, fields } = await settle(
      this.#presignPost(this.#client, {
        Bucket: this.#bucket,
        Key: key,
        Expires: ttl,
        Conditions: [
          ['content-length-range', spec.sizeBytes, spec.sizeBytes],
          ['eq', '$Content-Type', mime]
        ],
        Fields: { 'Content-Type': mime }
      })
    );
    return this.#presigned(url, 'POST', ttl, { fields });
  }

  async getPresignedUploadUrl(ref: MeetingObjectRef, spec: UploadSpec, opts?: PresignOptions): Promise<PresignedUrl> {
    const key = await this.#key(ref);
    validateUploadSpec(spec, this.#cfg.limits);
    const ttl = this.#ttl(opts, this.#cfg.uploadTtlSeconds);
    const mime = normalizeMimeType(spec.mimeType);
    const url = await settle(
      this.#presign(
        this.#client,
        new PutObjectCommand({ Bucket: this.#bucket, Key: key, ContentType: mime, ContentLength: spec.sizeBytes }),
        { expiresIn: ttl, signableHeaders: new Set(['content-type', 'content-length']) }
      )
    );
    return this.#presigned(url, 'PUT', ttl, { headers: { 'content-type': mime, 'content-length': String(spec.sizeBytes) } });
  }

  async getPresignedDownloadUrl(ref: MeetingObjectRef, opts?: PresignOptions): Promise<PresignedUrl> {
    const key = await this.#key(ref);
    const ttl = this.#ttl(opts, this.#cfg.downloadTtlSeconds);
    const url = await settle(this.#presign(this.#client, new GetObjectCommand({ Bucket: this.#bucket, Key: key }), { expiresIn: ttl }));
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

  async createMultipartUpload(ref: MeetingObjectRef, spec: MultipartSpec): Promise<MultipartUpload> {
    const key = await this.#key(ref);
    validateUploadSpec(spec, this.#cfg.limits);
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
          Metadata: spec.metadata
        })
      )
    );
    if (!res.UploadId) throw mapS3Error(new Error('missing UploadId'));
    return { uploadId: res.UploadId, partCount, partSizeBytes: spec.partSizeBytes };
  }

  async getPresignedPartUrl(
    ref: MeetingObjectRef,
    uploadId: string,
    partNumber: number,
    partSizeBytes: number,
    opts?: PresignOptions
  ): Promise<PresignedUrl> {
    const key = await this.#key(ref);
    this.#checkPartNumber(partNumber);
    this.#checkPartSize(partSizeBytes);
    const ttl = this.#ttl(opts, this.#cfg.uploadTtlSeconds);
    const url = await settle(
      this.#presign(
        this.#client,
        new UploadPartCommand({ Bucket: this.#bucket, Key: key, UploadId: uploadId, PartNumber: partNumber, ContentLength: partSizeBytes }),
        { expiresIn: ttl, signableHeaders: new Set(['content-length']) }
      )
    );
    return this.#presigned(url, 'PUT', ttl, { headers: { 'content-length': String(partSizeBytes) } });
  }

  async listParts(ref: MeetingObjectRef, uploadId: string): Promise<CompletedPart[]> {
    const key = await this.#key(ref);
    const out: CompletedPart[] = [];
    let marker: string | undefined;
    do {
      const res = await settle(
        this.#client.send(new ListPartsCommand({ Bucket: this.#bucket, Key: key, UploadId: uploadId, PartNumberMarker: marker }))
      );
      for (const p of res.Parts ?? []) {
        if (p.PartNumber !== undefined && p.ETag) out.push({ partNumber: p.PartNumber, etag: p.ETag });
      }
      marker = res.IsTruncated ? res.NextPartNumberMarker : undefined;
      if (out.length > this.#cfg.limits.maxParts) throw new StorageValidationError('Too many parts');
    } while (marker);
    return out;
  }

  async completeMultipartUpload(ref: MeetingObjectRef, uploadId: string, parts: CompletedPart[]) {
    const key = await this.#key(ref);
    if (parts.length === 0) throw new StorageValidationError('At least one part is required');
    if (parts.length > this.#cfg.limits.maxParts) throw new StorageValidationError('Too many parts');
    parts.forEach((p) => this.#checkPartNumber(p.partNumber));
    const sorted = [...parts].sort((a, b) => a.partNumber - b.partNumber);
    const res = await settle(
      this.#client.send(
        new CompleteMultipartUploadCommand({
          Bucket: this.#bucket,
          Key: key,
          UploadId: uploadId,
          MultipartUpload: { Parts: sorted.map((p) => ({ PartNumber: p.partNumber, ETag: p.etag })) }
        })
      )
    );
    return res.ETag ? { etag: res.ETag } : {};
  }

  async abortMultipartUpload(ref: MeetingObjectRef, uploadId: string): Promise<void> {
    const key = await this.#key(ref);
    await settle(this.#client.send(new AbortMultipartUploadCommand({ Bucket: this.#bucket, Key: key, UploadId: uploadId })));
  }

  // ---- Recording-session chunked upload (contracts v0.2 api/recording-sessions) ----

  #sessionRef(ref: SessionRef, seq: number): MeetingObjectRef {
    if (!Number.isInteger(seq) || seq < 0 || seq > MAX_RECORDING_CHUNKS - 1) throw new StorageValidationError('seq out of range');
    return { orgId: ref.orgId, meetingId: ref.meetingId, kind: 'session_chunk', objectId: ref.sessionId, index: seq };
  }

  /**
   * Presigned PUT for one session chunk (ChunkUploadUrlResponse.upload). TTL defaults to and is capped at
   * CHUNK_UPLOAD_URL_TTL_SECONDS (300). Content-Type is signed. Per-chunk size cannot be signed because the
   * contract request carries no size, so MAX_CHUNK_BYTES is enforced in verifySessionChunks().
   */
  async getPresignedSessionChunkUrl(ref: SessionRef, seq: number, mimeType: string, opts?: PresignOptions): Promise<PresignedUrl> {
    const objRef = this.#sessionRef(ref, seq);
    const key = await this.#key(objRef);
    validateUploadSpec({ mimeType, sizeBytes: 1 }, this.#cfg.limits);
    const ttl = assertTtl(opts?.ttlSeconds ?? SESSION_CHUNK_TTL_SECONDS);
    if (ttl > SESSION_CHUNK_TTL_SECONDS) throw new RangeError(`Session chunk TTL must be <= ${SESSION_CHUNK_TTL_SECONDS}s`);
    const mime = normalizeMimeType(mimeType);
    const url = await settle(
      this.#presign(this.#client, new PutObjectCommand({ Bucket: this.#bucket, Key: key, ContentType: mime }), {
        expiresIn: ttl,
        signableHeaders: new Set(['content-type'])
      })
    );
    return this.#presigned(url, 'PUT', ttl, { headers: { 'content-type': mime } });
  }

  /**
   * On CompleteRecordingSession: HEAD chunks 0..chunkCount-1, require all present, each <= MAX_CHUNK_BYTES,
   * and the total <= limits.maxObjectBytes (MAX_RECORDING_SESSION_BYTES). Oversized/missing => validation error.
   */
  async verifySessionChunks(ref: SessionRef, chunkCount: number): Promise<{ totalBytes: number; chunkSizes: number[] }> {
    if (!Number.isInteger(chunkCount) || chunkCount < 1 || chunkCount > MAX_RECORDING_CHUNKS) {
      throw new StorageValidationError('chunkCount out of range');
    }
    const sizes: number[] = [];
    let total = 0;
    for (let seq = 0; seq < chunkCount; seq++) {
      const info = await this.headObject(this.#sessionRef(ref, seq));
      if (!info) throw new StorageValidationError(`Missing chunk seq ${seq}`);
      if (info.sizeBytes > MAX_CHUNK_BYTES) throw new StorageValidationError(`Chunk seq ${seq} exceeds MAX_CHUNK_BYTES`);
      total += info.sizeBytes;
      if (total > this.#cfg.limits.maxObjectBytes) throw new StorageValidationError('Recording session exceeds maximum size');
      sizes.push(info.sizeBytes);
    }
    return { totalBytes: total, chunkSizes: sizes };
  }

  /** Best-effort delete of session chunks 0..upToSeq (abort or post-assembly cleanup). Missing chunks are ignored. */
  async deleteSessionChunks(ref: SessionRef, chunkCount: number): Promise<void> {
    const n = Math.min(Math.max(0, Math.floor(chunkCount)), MAX_RECORDING_CHUNKS);
    for (let seq = 0; seq < n; seq++) {
      await this.deleteObject(this.#sessionRef(ref, seq)).catch((err: unknown) => {
        if ((err as { code?: string }).code !== 'NOT_FOUND') throw err;
      });
    }
  }

  /**
   * Best-effort startup check that the bucket is not public (policy status + ACL grants).
   * Providers that don't implement these APIs (e.g. R2, some MinIO setups) report "unsupported".
   */
  async verifyBucketPrivate(): Promise<BucketPrivacyResult> {
    const unsupported = (err: unknown) => {
      const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
      return (
        ['NotImplemented', 'NoSuchBucketPolicy', 'MethodNotAllowed', 'XNotImplemented'].includes(e?.name ?? '') ||
        e?.$metadata?.httpStatusCode === 501 ||
        e?.$metadata?.httpStatusCode === 405
      );
    };
    const checks: BucketPrivacyResult['checks'] = { policy: 'error', acl: 'error' };
    try {
      const r = await this.#client.send(new GetBucketPolicyStatusCommand({ Bucket: this.#bucket }));
      checks.policy = r.PolicyStatus?.IsPublic ? 'public' : 'private';
    } catch (err) {
      checks.policy = (err as { name?: string }).name === 'NoSuchBucketPolicy' ? 'private' : unsupported(err) ? 'unsupported' : 'error';
    }
    try {
      const r = await this.#client.send(new GetBucketAclCommand({ Bucket: this.#bucket }));
      const pub = (r.Grants ?? []).some((g) => g.Grantee?.URI && PUBLIC_GRANTEES.includes(g.Grantee.URI));
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
  async describeObject(ref: MeetingObjectRef, fileObjectId: string, createdAt?: Date): Promise<FileObject | null> {
    const info = await this.headObject(ref);
    if (!info) return null;
    const f: FileObject = {
      id: fileObjectId,
      organizationId: ref.orgId,
      provider: this.#providerId,
      bucket: this.#bucket,
      key: buildObjectKey(ref),
      mimeType: info.mimeType ?? 'application/octet-stream',
      sizeBytes: info.sizeBytes,
      createdAt: (createdAt ?? info.updatedAt ?? new Date()).toISOString()
    };
    if (info.checksumSha256) f.checksumSha256 = info.checksumSha256;
    return f;
  }
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
  if (res.ChecksumSHA256) m.checksumSha256 = res.ChecksumSHA256;
  if (res.LastModified) m.updatedAt = res.LastModified;
  if (res.Metadata && Object.keys(res.Metadata).length) m.metadata = res.Metadata;
  return m;
}

export function createStorageServiceFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  opts: Omit<S3StorageServiceOptions, 'config'> = {}
): S3StorageService {
  return new S3StorageService({ ...opts, config: loadStorageConfig(env) });
}
