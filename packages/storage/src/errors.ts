/** Storage errors never include object keys, bucket names or URLs in their messages. */
export type StorageErrorCode = 'NOT_FOUND' | 'FORBIDDEN' | 'VALIDATION' | 'STORAGE_ERROR';

export class StorageError extends Error {
  override readonly name: string = 'StorageError';
  constructor(
    readonly code: StorageErrorCode,
    message: string
  ) {
    super(message);
  }
}

/** Object missing OR access denied by the backend (deliberately indistinguishable). */
export class StorageNotFoundError extends StorageError {
  override readonly name = 'StorageNotFoundError';
  constructor(message = 'Object not found') {
    super('NOT_FOUND', message);
  }
}

/** Caller is not allowed to touch this object (org ownership check failed). */
export class StorageAccessError extends StorageError {
  override readonly name = 'StorageAccessError';
  constructor(message = 'Access denied') {
    super('FORBIDDEN', message);
  }
}

export class StorageValidationError extends StorageError {
  override readonly name = 'StorageValidationError';
  constructor(message: string) {
    super('VALIDATION', message);
  }
}

const NOT_FOUND_NAMES = new Set(['NotFound', 'NoSuchKey', 'NoSuchUpload', 'AccessDenied', 'Forbidden', 'AllAccessDisabled']);

/** Map a raw S3 SDK error to a StorageError without leaking keys or backend messages. */
export function mapS3Error(err: unknown): StorageError {
  if (err instanceof StorageError) return err;
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } } | undefined;
  const status = e?.$metadata?.httpStatusCode;
  if ((e?.name && NOT_FOUND_NAMES.has(e.name)) || status === 404 || status === 403) return new StorageNotFoundError();
  return new StorageError('STORAGE_ERROR', `Storage backend error${e?.name ? ` (${e.name})` : ''}`);
}
