import { useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Upload } from 'lucide-react';
import type { Id } from '@meetops/contracts';
import { Button } from '@/components/ui/button';
import { ErrorState } from '@/components/states/states';
import { useApi } from '@/lib/api/context';
import { useOrganizationId } from '@/lib/api/queries';

/** Mirrors contracts CreateUploadRequest: audio/video only, ≤ 5 GiB. */
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024 * 1024;
const MIME_RE = /^(audio|video)\/[a-z0-9.+-]+$/;

export function validateUploadFile(file: File): string | null {
  if (!MIME_RE.test(file.type)) return 'Only audio or video files can be uploaded.';
  if (file.size < 1) return 'The file is empty.';
  if (file.size > MAX_UPLOAD_BYTES) return 'The file is larger than 5 GB.';
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
