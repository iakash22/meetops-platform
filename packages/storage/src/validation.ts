export class StorageValidationError extends Error {
  override readonly name = 'StorageValidationError';
}

export type ValidationInput = { key: string; contentType?: string; contentLength?: number };
export type ValidationHook = (input: ValidationInput) => void | Promise<void>;
/** Called before any key-addressed operation; throw to deny. */
export type OwnershipHook = (key: string) => void | Promise<void>;

export const DEFAULT_AUDIO_VIDEO_TYPES = [
  'audio/mpeg', 'audio/mp4', 'audio/wav', 'audio/x-wav', 'audio/webm', 'audio/ogg', 'audio/flac',
  'video/mp4', 'video/webm', 'video/quicktime'
];

export function contentTypeValidator(allowed: readonly string[]): ValidationHook {
  const set = new Set(allowed.map((t) => t.toLowerCase()));
  return ({ contentType }) => {
    if (!contentType) throw new StorageValidationError('contentType is required');
    const base = contentType.split(';')[0]!.trim().toLowerCase();
    if (!set.has(base)) throw new StorageValidationError(`Content type not allowed: ${contentType}`);
  };
}

export function sizeValidator(maxBytes: number, minBytes = 1): ValidationHook {
  return ({ contentLength }) => {
    if (contentLength === undefined) return;
    if (!Number.isFinite(contentLength) || contentLength < minBytes || contentLength > maxBytes) {
      throw new StorageValidationError(`Size ${contentLength} outside allowed range ${minBytes}..${maxBytes}`);
    }
  };
}
