import type { StorageProviderId } from './types.js';

/** Hard ceiling for any presigned URL/POST TTL (seconds). */
export const MAX_PRESIGN_TTL_SECONDS = 600;
export const DEFAULT_UPLOAD_TTL_SECONDS = 600;
export const DEFAULT_DOWNLOAD_TTL_SECONDS = 300;
/** S3 minimum part size (all parts except the last). */
export const S3_MIN_PART_BYTES = 5 * 1024 * 1024;

export type StorageLimits = {
  /** Max size of a single object in bytes. */
  maxObjectBytes: number;
  /** Max size of one multipart part in bytes. */
  maxPartBytes: number;
  /** Max number of parts in one multipart upload. */
  maxParts: number;
  /** Allowed mime types for uploads (lowercase, no parameters). */
  allowedMimeTypes: readonly string[];
};

export type StorageConfig = {
  provider: StorageProviderId;
  endpoint?: string;
  region: string;
  bucket: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  forcePathStyle: boolean;
  uploadTtlSeconds: number;
  downloadTtlSeconds: number;
  limits: StorageLimits;
};

export const DEFAULT_ALLOWED_MIME_TYPES: readonly string[] = [
  'audio/mpeg', 'audio/mp4', 'audio/wav', 'audio/x-wav', 'audio/webm', 'audio/ogg', 'audio/flac',
  'video/mp4', 'video/webm', 'video/quicktime',
  'application/json', 'text/plain', 'text/vtt', 'application/pdf'
];

const PROVIDERS: readonly StorageProviderId[] = ['minio', 'r2', 's3'];

function parseBool(name: string, v: string | undefined): boolean | undefined {
  if (v === undefined || v.trim() === '') return undefined;
  const s = v.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'off'].includes(s)) return false;
  throw new Error(`Invalid boolean for ${name}`);
}

function parseInt(name: string, v: string | undefined, def: number, min: number, max: number): number {
  if (v === undefined || v.trim() === '') return def;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} must be an integer in ${min}..${max}`);
  return n;
}

export function assertTtl(ttl: number): number {
  if (!Number.isInteger(ttl) || ttl < 1 || ttl > MAX_PRESIGN_TTL_SECONDS) {
    throw new RangeError(`Presign TTL must be an integer in 1..${MAX_PRESIGN_TTL_SECONDS} seconds`);
  }
  return ttl;
}

/**
 * Env: STORAGE_PROVIDER, STORAGE_ENDPOINT, STORAGE_REGION, STORAGE_BUCKET,
 * STORAGE_ACCESS_KEY_ID, STORAGE_SECRET_ACCESS_KEY, STORAGE_FORCE_PATH_STYLE,
 * STORAGE_UPLOAD_TTL_SECONDS (default 600, max 600), STORAGE_DOWNLOAD_TTL_SECONDS (default 300, max 600),
 * STORAGE_MAX_OBJECT_BYTES (default 5 GiB), STORAGE_MAX_PART_BYTES (default 100 MiB),
 * STORAGE_MAX_PARTS (default 1000, max 10000), STORAGE_ALLOWED_MIME_TYPES (comma list).
 */
export function loadStorageConfig(env: NodeJS.ProcessEnv = process.env): StorageConfig {
  const provider = (env.STORAGE_PROVIDER ?? 'minio').trim().toLowerCase() as StorageProviderId;
  if (!PROVIDERS.includes(provider)) throw new Error('Invalid STORAGE_PROVIDER (expected minio|r2|s3)');
  const bucket = env.STORAGE_BUCKET;
  if (!bucket) throw new Error('STORAGE_BUCKET is required');
  const endpoint = env.STORAGE_ENDPOINT || undefined;
  if ((provider === 'minio' || provider === 'r2') && !endpoint) {
    throw new Error(`STORAGE_ENDPOINT is required for provider ${provider}`);
  }
  const maxPartBytes = parseInt('STORAGE_MAX_PART_BYTES', env.STORAGE_MAX_PART_BYTES, 100 * 1024 * 1024, S3_MIN_PART_BYTES, 5 * 1024 ** 3);
  const mimes = (env.STORAGE_ALLOWED_MIME_TYPES ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const cfg: StorageConfig = {
    provider,
    region: env.STORAGE_REGION || (provider === 'r2' ? 'auto' : 'us-east-1'),
    bucket,
    forcePathStyle: parseBool('STORAGE_FORCE_PATH_STYLE', env.STORAGE_FORCE_PATH_STYLE) ?? provider === 'minio',
    uploadTtlSeconds: parseInt('STORAGE_UPLOAD_TTL_SECONDS', env.STORAGE_UPLOAD_TTL_SECONDS, DEFAULT_UPLOAD_TTL_SECONDS, 1, MAX_PRESIGN_TTL_SECONDS),
    downloadTtlSeconds: parseInt('STORAGE_DOWNLOAD_TTL_SECONDS', env.STORAGE_DOWNLOAD_TTL_SECONDS, DEFAULT_DOWNLOAD_TTL_SECONDS, 1, MAX_PRESIGN_TTL_SECONDS),
    limits: {
      maxObjectBytes: parseInt('STORAGE_MAX_OBJECT_BYTES', env.STORAGE_MAX_OBJECT_BYTES, 5 * 1024 ** 3, 1, 5 * 1024 ** 4),
      maxPartBytes,
      maxParts: parseInt('STORAGE_MAX_PARTS', env.STORAGE_MAX_PARTS, 1000, 1, 10000),
      allowedMimeTypes: mimes.length ? mimes : DEFAULT_ALLOWED_MIME_TYPES
    }
  };
  if (endpoint) cfg.endpoint = endpoint;
  if (env.STORAGE_ACCESS_KEY_ID) cfg.accessKeyId = env.STORAGE_ACCESS_KEY_ID;
  if (env.STORAGE_SECRET_ACCESS_KEY) cfg.secretAccessKey = env.STORAGE_SECRET_ACCESS_KEY;
  return cfg;
}
