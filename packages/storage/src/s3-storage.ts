import { Readable } from 'node:stream';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListPartsCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
  UploadPartCommand
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { PresignedUrl, StorageObjectMetadata } from '@meetops/contracts';
import { loadStorageConfig, type StorageConfig } from './config.js';
import type {
  CompletedPart,
  GetObjectResult,
  MultipartUpload,
  PutObjectBody,
  PutObjectOptions,
  StorageService
} from './types.js';
import { StorageValidationError, type OwnershipHook, type ValidationHook } from './validation.js';

export type S3StorageServiceOptions = {
  config: StorageConfig;
  /** Inject a client (tests). Defaults to one built from config. */
  client?: S3Client;
  validators?: ValidationHook[];
  ownershipCheck?: OwnershipHook;
  /** Injectable presigner (tests). */
  presign?: typeof getSignedUrl;
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

function isNotFound(err: unknown): boolean {
  if (err instanceof S3ServiceException) {
    return err.name === 'NotFound' || err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404;
  }
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e?.name === 'NotFound' || e?.name === 'NoSuchKey' || e?.$metadata?.httpStatusCode === 404;
}

export class StorageNotFoundError extends Error {
  override readonly name = 'StorageNotFoundError';
}

export class S3StorageService implements StorageService {
  readonly providerId;
  readonly bucket;
  private readonly client: S3Client;
  private readonly validators: ValidationHook[];
  private readonly ownershipCheck: OwnershipHook | undefined;
  private readonly presign: typeof getSignedUrl;
  private readonly defaultExpires: number;

  constructor(opts: S3StorageServiceOptions) {
    this.providerId = opts.config.provider;
    this.bucket = opts.config.bucket;
    this.client = opts.client ?? createS3Client(opts.config);
    this.validators = opts.validators ?? [];
    this.ownershipCheck = opts.ownershipCheck;
    this.presign = opts.presign ?? getSignedUrl;
    this.defaultExpires = opts.config.presignExpiresInSeconds;
  }

  private async guard(key: string): Promise<void> {
    if (!key || key.startsWith('/')) throw new StorageValidationError(`Invalid key: "${key}"`);
    if (this.ownershipCheck) await this.ownershipCheck(key);
  }

  private async validate(key: string, o: PutObjectOptions | undefined): Promise<void> {
    for (const v of this.validators) {
      await v({
        key,
        ...(o?.contentType !== undefined ? { contentType: o.contentType } : {}),
        ...(o?.contentLength !== undefined ? { contentLength: o.contentLength } : {})
      });
    }
  }

  private presigned(url: string, method: PresignedUrl['method'], expires: number, headers?: Record<string, string>): PresignedUrl {
    return { url, method, expiresAt: new Date(Date.now() + expires * 1000), ...(headers ? { headers } : {}) };
  }

  async putObject(key: string, body: PutObjectBody, options?: PutObjectOptions) {
    await this.guard(key);
    let len = options?.contentLength;
    if (len === undefined && !(body instanceof Readable)) {
      len = typeof body === 'string' ? Buffer.byteLength(body) : body.byteLength;
    }
    await this.validate(key, { ...options, ...(len !== undefined ? { contentLength: len } : {}) });
    const res = await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: options?.contentType,
        ContentLength: len,
        ChecksumSHA256: options?.checksumSha256,
        Metadata: options?.metadata
      })
    );
    return res.ETag ? { etag: res.ETag } : {};
  }

  async getObject(key: string): Promise<GetObjectResult> {
    await this.guard(key);
    try {
      const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      const body = res.Body;
      if (!body) throw new StorageNotFoundError(`Empty body for ${key}`);
      const stream = body instanceof Readable ? body : Readable.from(body as unknown as AsyncIterable<Uint8Array>);
      return { body: stream, metadata: this.toMeta(key, res) };
    } catch (err) {
      if (isNotFound(err)) throw new StorageNotFoundError(`Object not found: ${key}`);
      throw err;
    }
  }

  async getPresignedUploadUrl(key: string, options?: PutObjectOptions): Promise<PresignedUrl> {
    await this.guard(key);
    await this.validate(key, options);
    const expires = options?.expiresInSeconds ?? this.defaultExpires;
    const cmd = new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ContentType: options?.contentType,
      ContentLength: options?.contentLength,
      ChecksumSHA256: options?.checksumSha256,
      Metadata: options?.metadata
    });
    const url = await this.presign(this.client, cmd, { expiresIn: expires });
    const headers: Record<string, string> = {};
    if (options?.contentType) headers['content-type'] = options.contentType;
    return this.presigned(url, 'PUT', expires, Object.keys(headers).length ? headers : undefined);
  }

  async getPresignedDownloadUrl(key: string, expiresInSeconds?: number): Promise<PresignedUrl> {
    await this.guard(key);
    const expires = expiresInSeconds ?? this.defaultExpires;
    const url = await this.presign(this.client, new GetObjectCommand({ Bucket: this.bucket, Key: key }), { expiresIn: expires });
    return this.presigned(url, 'GET', expires);
  }

  async headObject(key: string): Promise<StorageObjectMetadata | null> {
    await this.guard(key);
    try {
      const res = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return this.toMeta(key, res);
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async deleteObject(key: string): Promise<void> {
    await this.guard(key);
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async createMultipartUpload(key: string, options?: PutObjectOptions): Promise<MultipartUpload> {
    await this.guard(key);
    await this.validate(key, options);
    const res = await this.client.send(
      new CreateMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        ContentType: options?.contentType,
        Metadata: options?.metadata
      })
    );
    if (!res.UploadId) throw new Error('S3 did not return an UploadId');
    return { key, uploadId: res.UploadId };
  }

  async getPresignedPartUrl(key: string, uploadId: string, partNumber: number, expiresInSeconds?: number): Promise<PresignedUrl> {
    await this.guard(key);
    if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10000) {
      throw new StorageValidationError(`partNumber must be 1..10000, got ${partNumber}`);
    }
    const expires = expiresInSeconds ?? this.defaultExpires;
    const url = await this.presign(
      this.client,
      new UploadPartCommand({ Bucket: this.bucket, Key: key, UploadId: uploadId, PartNumber: partNumber }),
      { expiresIn: expires }
    );
    return this.presigned(url, 'PUT', expires);
  }

  async completeMultipartUpload(key: string, uploadId: string, parts: CompletedPart[]) {
    await this.guard(key);
    if (parts.length === 0) throw new StorageValidationError('At least one part is required');
    const sorted = [...parts].sort((a, b) => a.partNumber - b.partNumber);
    const res = await this.client.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: { Parts: sorted.map((p) => ({ PartNumber: p.partNumber, ETag: p.etag })) }
      })
    );
    return res.ETag ? { etag: res.ETag } : {};
  }

  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    await this.guard(key);
    await this.client.send(new AbortMultipartUploadCommand({ Bucket: this.bucket, Key: key, UploadId: uploadId }));
  }

  /** Lists uploaded parts, for resuming an interrupted multipart upload. */
  async listParts(key: string, uploadId: string): Promise<CompletedPart[]> {
    await this.guard(key);
    const out: CompletedPart[] = [];
    let marker: string | undefined;
    do {
      const res = await this.client.send(
        new ListPartsCommand({ Bucket: this.bucket, Key: key, UploadId: uploadId, PartNumberMarker: marker })
      );
      for (const p of res.Parts ?? []) {
        if (p.PartNumber !== undefined && p.ETag) out.push({ partNumber: p.PartNumber, etag: p.ETag });
      }
      marker = res.IsTruncated ? res.NextPartNumberMarker : undefined;
    } while (marker);
    return out;
  }

  private toMeta(
    key: string,
    res: {
      ContentLength?: number | undefined;
      ContentType?: string | undefined;
      ETag?: string | undefined;
      ChecksumSHA256?: string | undefined;
      LastModified?: Date | undefined;
      Metadata?: Record<string, string> | undefined;
    }
  ): StorageObjectMetadata {
    const m: StorageObjectMetadata = { key, bucket: this.bucket, size: res.ContentLength ?? 0 };
    if (res.ContentType) m.contentType = res.ContentType;
    if (res.ETag) m.etag = res.ETag;
    if (res.ChecksumSHA256) m.checksumSha256 = res.ChecksumSHA256;
    if (res.LastModified) m.updatedAt = res.LastModified;
    if (res.Metadata && Object.keys(res.Metadata).length) m.custom = res.Metadata;
    return m;
  }
}

/** Build a StorageService from process env (STORAGE_*). */
export function createStorageServiceFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  opts: Omit<S3StorageServiceOptions, 'config'> = {}
): S3StorageService {
  return new S3StorageService({ ...opts, config: loadStorageConfig(env) });
}
