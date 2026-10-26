import { useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Upload } from 'lucide-react';
import type { Id } from '@meetops/contracts';
import { Button } from '@/components/ui/button';
import { ErrorState } from '@/components/states/states';
import { useApi } from '@/lib/api/context';
import { useOrganizationId } from '@/lib/api/queries';

import type { MAX_MEDIA_BYTES } from '@meetops/contracts';

/**
 * Mirrors contracts CreateUploadRequest (MAX_UPLOAD_BYTES = MAX_MEDIA_BYTES = 1_400_000_000,
 * decimal 1.4 GB). Declared locally to avoid pulling the TypeBox runtime into the bundle;
 * the `satisfies` breaks typecheck if contracts change the value.
 */
export const MAX_UPLOAD_BYTES = 1_400_000_000 satisfies typeof MAX_MEDIA_BYTES;
const MIME_RE = /^(audio|video)\/[a-z0-9.+-]+$/;

function readBytes(file: Blob): Promise<ArrayBuffer> {
  if (typeof file.arrayBuffer === 'function') return file.arrayBuffer();
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as ArrayBuffer);
    r.onerror = () => reject(r.error ?? new Error('read failed'));
    r.readAsArrayBuffer(file);
  });
}

/** Standard base64 sha256 of the whole file (contracts Sha256Base64; required by CreateUploadRequest). */
export async function sha256Base64(file: Blob): Promise<string> {
  // Copy into this realm's Uint8Array: WebCrypto rejects ArrayBuffers from another realm (e.g. jsdom FileReader).
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new Uint8Array(new Uint8Array(await readBytes(file)))),
  );
  let bin = '';
  for (const b of digest) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function validateUploadFile(file: File): string | null {
  if (!MIME_RE.test(file.type)) return 'Only audio or video files can be uploaded.';
  if (file.size < 1) return 'The file is empty.';
  if (file.size > MAX_UPLOAD_BYTES) return 'The file is larger than 1.4 GB.';
  return null;
}

/** Request a presigned URL (createUpload), then PUT the file to it. */
export function UploadButton({ meetingId }: { meetingId?: Id }) {
  const api = useApi();
  const organizationId = useOrganizationId();
  const queryClient = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const [validation, setValidation] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: async (file: File) => {
      const { upload } = await api.storage.createUpload(organizationId, {
        filename: file.name,
        mimeType: file.type,
        sizeBytes: file.size,
        checksumSha256: await sha256Base64(file),
        ...(meetingId ? { meetingId } : {}),
      });
      await api.storage.putToPresignedUrl(upload, file);
    },
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ['orgs', organizationId, 'meetings'] }),
  });

  return (
    <div className="flex flex-col items-end gap-2">
      <input
        ref={inputRef}
        type="file"
        accept="audio/*,video/*"
        className="hidden"
        data-testid="upload-input"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (!file) return;
          const err = validateUploadFile(file);
          setValidation(err);
          if (!err) mutation.mutate(file);
        }}
      />
      <Button
        type="button"
        onClick={() => inputRef.current?.click()}
        disabled={!organizationId || mutation.isPending}
      >
        <Upload aria-hidden />
        {mutation.isPending ? 'Uploading…' : 'Upload recording'}
      </Button>
      {validation ? (
        <p role="alert" className="text-sm text-destructive">
          {validation}
        </p>
      ) : null}
      {mutation.isSuccess ? (
        <p role="status" className="text-sm">
          Upload complete
        </p>
      ) : null}
      {mutation.isError ? <ErrorState title="Upload failed" error={mutation.error} /> : null}
    </div>
  );
}
