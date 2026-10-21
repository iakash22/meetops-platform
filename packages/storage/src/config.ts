import type { StorageProviderId } from './types.js';

export type StorageConfig = {
  provider: StorageProviderId;
  endpoint?: string;
  region: string;
  bucket: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  forcePathStyle: boolean;
  /** Default presign expiry in seconds. */
  presignExpiresInSeconds: number;
};

const PROVIDERS: readonly StorageProviderId[] = ['minio', 'r2', 's3'];

function parseBool(v: string | undefined): boolean | undefined {
  if (v === undefined || v === '') return undefined;
  const s = v.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'off'].includes(s)) return false;
  throw new Error(`Invalid boolean value: ${v}`);
}

/**
 * Load storage config from env:
 * STORAGE_PROVIDER, STORAGE_ENDPOINT, STORAGE_REGION, STORAGE_BUCKET,
 * STORAGE_ACCESS_KEY_ID, STORAGE_SECRET_ACCESS_KEY, STORAGE_FORCE_PATH_STYLE,
 * STORAGE_PRESIGN_EXPIRES_SECONDS.
 */
export function loadStorageConfig(env: NodeJS.ProcessEnv = process.env): StorageConfig {
  const provider = (env.STORAGE_PROVIDER ?? 'minio').trim().toLowerCase() as StorageProviderId;
  if (!PROVIDERS.includes(provider)) {
    throw new Error(`Invalid STORAGE_PROVIDER "${provider}" (expected minio|r2|s3)`);
  }
  const bucket = env.STORAGE_BUCKET;
  if (!bucket) throw new Error('STORAGE_BUCKET is required');
  const endpoint = env.STORAGE_ENDPOINT || undefined;
  if ((provider === 'minio' || provider === 'r2') && !endpoint) {
    throw new Error(`STORAGE_ENDPOINT is required for provider ${provider}`);
  }
  const region = env.STORAGE_REGION || (provider === 'r2' ? 'auto' : 'us-east-1');
  const forcePathStyle = parseBool(env.STORAGE_FORCE_PATH_STYLE) ?? provider === 'minio';
  const expires = Number(env.STORAGE_PRESIGN_EXPIRES_SECONDS ?? 900);
  if (!Number.isInteger(expires) || expires <= 0 || expires > 604800) {
    throw new Error('STORAGE_PRESIGN_EXPIRES_SECONDS must be an integer in 1..604800');
  }
  const cfg: StorageConfig = { provider, region, bucket, forcePathStyle, presignExpiresInSeconds: expires };
  if (endpoint) cfg.endpoint = endpoint;
  if (env.STORAGE_ACCESS_KEY_ID) cfg.accessKeyId = env.STORAGE_ACCESS_KEY_ID;
  if (env.STORAGE_SECRET_ACCESS_KEY) cfg.secretAccessKey = env.STORAGE_SECRET_ACCESS_KEY;
  return cfg;
}
