import type { MAX_MEDIA_BYTES } from '@meetops/contracts/types';

/**
 * Mirrors contracts MAX_UPLOAD_BYTES (= MAX_MEDIA_BYTES = 1_400_000_000, decimal 1.4 GB) and
 * ALLOWED_MEDIA_MIME_TYPES, declared locally to keep the TypeBox runtime out of the bundle.
 * The `satisfies` breaks typecheck if contracts change the cap.
 */
export const MAX_UPLOAD_BYTES = 1_400_000_000 satisfies typeof MAX_MEDIA_BYTES;
export const ALLOWED_UPLOAD_TYPES = [
  'audio/webm',
  'audio/ogg',
  'audio/mpeg',
  'audio/mp4',
  'audio/wav',
  'audio/x-wav',
  'video/webm',
  'video/mp4',
] as const;
const ALLOWED = new Set<string>(ALLOWED_UPLOAD_TYPES);
/** `accept=` for the picker (hint only; validated again below and by the API). */
export const UPLOAD_ACCEPT = ALLOWED_UPLOAD_TYPES.join(',');

export function validateUploadFile(file: File): string | null {
  const base = file.type.split(';')[0]?.trim().toLowerCase() ?? '';
  if (!ALLOWED.has(base))
    return 'Only audio or video files (WebM, Ogg, MP3, MP4, WAV) can be uploaded.';
  if (file.name.length > 255 || /[/\\\p{Cc}]/u.test(file.name))
    return 'Rename the file and try again.';
  if (file.size < 1) return 'The file is empty.';
  if (file.size > MAX_UPLOAD_BYTES) return 'The file is larger than 1.4 GB.';
  return null;
}
