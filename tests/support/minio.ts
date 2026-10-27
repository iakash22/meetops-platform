/**
 * Optional MinIO/S3 harness for the media integration suite.
 *
 * Set QA_MINIO_ENDPOINT, QA_MINIO_ACCESS_KEY and QA_MINIO_SECRET_KEY (never commit them). Each suite creates a
 * unique throwaway bucket `qa-media-<random>` and deletes every object and the bucket in teardown. The AWS SDK is
 * resolved from @meetops/storage's dependencies, so the tests package needs no new dependency.
 */
import { createHash, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Readable } from 'node:stream';

const storagePkg = fileURLToPath(new URL('../../packages/storage/package.json', import.meta.url));
const req = createRequire(storagePkg);
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- SDK loaded dynamically from another package
type Any = any;
const load = async (m: string): Promise<Any> => import(pathToFileURL(req.resolve(m)).href);

export const minioEnv = () => {
  const endpoint = process.env.QA_MINIO_ENDPOINT;
  const accessKeyId = process.env.QA_MINIO_ACCESS_KEY;
  const secretAccessKey = process.env.QA_MINIO_SECRET_KEY;
  return endpoint && accessKeyId && secretAccessKey
    ? { endpoint, accessKeyId, secretAccessKey }
    : null;
};

/** Configured and answering its health endpoint. */
export async function minioReachable(): Promise<boolean> {
  const e = minioEnv();
  if (!e) return false;
  try {
    const r = await fetch(new URL('/minio/health/live', e.endpoint), {
      signal: AbortSignal.timeout(3000),
    });
    return r.ok;
  } catch {
    return false;
  }
}

export const sha256B64 = (b: Buffer) => createHash('sha256').update(b).digest('base64');
export const sha256Hex = (b: Buffer) => createHash('sha256').update(b).digest('hex');

export type SignedRequest = {
  url: string;
  method: 'PUT' | 'GET';
  headers: Record<string, string>;
  expiresAt: Date;
};

export type MinioBucket = {
  bucket: string;
  endpoint: string;
  /** Secrets, only so a test can assert they never reach the logs. */
  secrets: string[];
  /** MediaSigner port (apps/api media/domain/ports.ts) backed by this bucket. */
  signer: {
    presignPut(s: {
      key: string;
      mimeType: string;
      sizeBytes: number;
      checksumSha256Base64: string;
      ttlSeconds: number;
    }): Promise<SignedRequest>;
    presignGet(s: { key: string; ttlSeconds: number; contentType: string }): Promise<SignedRequest>;
    head(key: string): Promise<{ sizeBytes: number; checksumSha256Base64: string | null } | null>;
  };
  /** Worker-side object source (HEAD size + streaming body). */
  source(key: string): { size(): Promise<number | null>; body(): Promise<Readable> };
  getBuffer(key: string): Promise<Buffer>;
  putBuffer(key: string, body: Buffer, contentType: string): Promise<void>;
  storageService(): Promise<{ verifyBucketPrivate(): Promise<{ status: string }> }>;
  destroy(): Promise<void>;
};

export async function createMinioBucket(): Promise<MinioBucket> {
  const e = minioEnv();
  if (!e) throw new Error('MinIO env not set');
  const s3 = await load('@aws-sdk/client-s3');
  const { getSignedUrl } = await load('@aws-sdk/s3-request-presigner');
  const client = new s3.S3Client({
    region: 'us-east-1',
    endpoint: e.endpoint,
    forcePathStyle: true,
    credentials: { accessKeyId: e.accessKeyId, secretAccessKey: e.secretAccessKey },
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
  const bucket = `qa-media-${randomBytes(6).toString('hex')}`;
  await client.send(new s3.CreateBucketCommand({ Bucket: bucket }));
  const { downloadResponseOverrides } = (await import(
    pathToFileURL(
      fileURLToPath(new URL('../../packages/storage/src/download-headers.ts', import.meta.url)),
    ).href
  )) as { downloadResponseOverrides: (ct: string) => Record<string, string> };

  const signed = ['content-type', 'content-length', 'x-amz-checksum-sha256'];
  const exp = (ttl: number) => new Date(Date.now() + ttl * 1000);
  return {
    bucket,
    endpoint: e.endpoint,
    secrets: [e.secretAccessKey, e.accessKeyId],
    signer: {
      async presignPut(s) {
        const url: string = await getSignedUrl(
          client,
          new s3.PutObjectCommand({
            Bucket: bucket,
            Key: s.key,
            ContentType: s.mimeType,
            ContentLength: s.sizeBytes,
            ChecksumSHA256: s.checksumSha256Base64,
          }),
          {
            expiresIn: s.ttlSeconds,
            signableHeaders: new Set(signed),
            unhoistableHeaders: new Set(signed),
          },
        );
        return {
          url,
          method: 'PUT',
          headers: {
            'content-type': s.mimeType,
            'content-length': String(s.sizeBytes),
            'x-amz-checksum-sha256': s.checksumSha256Base64,
          },
          expiresAt: exp(s.ttlSeconds),
        };
      },
      async presignGet(s) {
        const url: string = await getSignedUrl(
          client,
          new s3.GetObjectCommand({
            Bucket: bucket,
            Key: s.key,
            ...downloadResponseOverrides(s.contentType),
          }),
          { expiresIn: s.ttlSeconds },
        );
        return { url, method: 'GET', headers: {}, expiresAt: exp(s.ttlSeconds) };
      },
      async head(key) {
        try {
          const h = await client.send(
            new s3.HeadObjectCommand({ Bucket: bucket, Key: key, ChecksumMode: 'ENABLED' }),
          );
          return {
            sizeBytes: Number(h.ContentLength ?? 0),
            checksumSha256Base64: h.ChecksumSHA256 ?? null,
          };
        } catch (err) {
          const code = (err as { $metadata?: { httpStatusCode?: number } }).$metadata
            ?.httpStatusCode;
          if (code === 404) return null;
          throw err;
        }
      },
    },
    source(key) {
      return {
        size: async () => {
          try {
            const h = await client.send(new s3.HeadObjectCommand({ Bucket: bucket, Key: key }));
            return Number(h.ContentLength ?? 0);
          } catch {
            return null;
          }
        },
        body: async () =>
          (await client.send(new s3.GetObjectCommand({ Bucket: bucket, Key: key })))
            .Body as Readable,
      };
    },
    async getBuffer(key) {
      const r = await client.send(new s3.GetObjectCommand({ Bucket: bucket, Key: key }));
      return Buffer.from(await r.Body.transformToByteArray());
    },
    async putBuffer(key, body, contentType) {
      await client.send(
        new s3.PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }),
      );
    },
    async storageService() {
      const st = await import(
        pathToFileURL(
          fileURLToPath(new URL('../../packages/storage/src/index.ts', import.meta.url)),
        ).href
      );
      return new st.S3StorageService({
        config: {
          provider: 'minio',
          endpoint: e.endpoint,
          region: 'us-east-1',
          bucket,
          accessKeyId: e.accessKeyId,
          secretAccessKey: e.secretAccessKey,
          forcePathStyle: true,
          uploadTtlSeconds: 300,
          downloadTtlSeconds: 300,
          limits: { maxObjectBytes: 1_400_000_000, maxPartBytes: 100 * 1024 * 1024 },
        },
        client,
        authorize: () => {},
      });
    },
    async destroy() {
      let token: string | undefined;
      do {
        const l = await client.send(
          new s3.ListObjectsV2Command({ Bucket: bucket, ContinuationToken: token }),
        );
        const keys = (l.Contents ?? []).map((o: { Key: string }) => ({ Key: o.Key }));
        if (keys.length)
          await client.send(
            new s3.DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: keys } }),
          );
        token = l.IsTruncated ? l.NextContinuationToken : undefined;
      } while (token);
      // Abort any dangling multipart uploads, then drop the bucket.
      const mp = await client.send(new s3.ListMultipartUploadsCommand({ Bucket: bucket }));
      for (const u of mp.Uploads ?? [])
        await client.send(
          new s3.AbortMultipartUploadCommand({ Bucket: bucket, Key: u.Key, UploadId: u.UploadId }),
        );
      await client.send(new s3.DeleteBucketCommand({ Bucket: bucket }));
      client.destroy();
    },
  };
}
