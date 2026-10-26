import { useId, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Upload, X } from 'lucide-react';
import type { ConsentMethod, Id } from '@meetops/contracts';
import { CURRENT_CONSENT_VERSION } from '@meetops/contracts/types';
import { Button } from '@/components/ui/button';
import { notify, toastError } from '@/lib/errors/notify';
import { useApi } from '@/lib/api/context';
import { useOrganizationId } from '@/lib/api/queries';

import type { MAX_MEDIA_BYTES } from '@meetops/contracts';

const CONSENT_LABEL: Record<ConsentMethod, string> = {
  all_parties_notified: 'Everyone in the recording was told it is recorded',
  all_parties_consented: 'Everyone in the recording agreed to be recorded',
};

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

/**
 * Upload flow (contracts 0.4.1 InitUploadRequest): pick a file → attest consent (G11, required by the API)
 * → createUpload → PUT to the presigned URL with progress and cancel.
 * Field errors (bad file, missing consent) show inline; request failures show a toast.
 */
export function UploadButton({ meetingId }: { meetingId?: Id }) {
  const api = useApi();
  const organizationId = useOrganizationId();
  const queryClient = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const uid = useId();
  const [validation, setValidation] = useState<string | null>(null);
  const [pending, setPending] = useState<File | null>(null);
  const [method, setMethod] = useState<ConsentMethod | null>(null);
  const [consentError, setConsentError] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);

  const mutation = useMutation({
    mutationFn: async ({ file, consent }: { file: File; consent: ConsentMethod }) => {
      const controller = new AbortController();
      abortRef.current = controller;
      setProgress(0);
      const { upload } = await api.storage.createUpload(organizationId, {
        filename: file.name,
        mimeType: file.type,
        sizeBytes: file.size,
        checksumSha256: await sha256Base64(file),
        ...(meetingId ? { meetingId } : {}),
        consent: {
          consentVersion: CURRENT_CONSENT_VERSION,
          attestedAt: new Date().toISOString(),
          method: consent,
        },
      });
      await api.storage.putToPresignedUrl(upload, file, {
        onProgress: setProgress,
        signal: controller.signal,
      });
    },
    onSuccess: () => {
      notify.success('Upload complete', 'Processing starts shortly.');
      return queryClient.invalidateQueries({ queryKey: ['orgs', organizationId, 'meetings'] });
    },
    onError: (err) => {
      if (err instanceof DOMException && err.name === 'AbortError') notify.info('Upload cancelled');
      else toastError(err, { title: 'Upload failed' });
    },
    onSettled: () => {
      abortRef.current = null;
    },
  });

  const reset = () => {
    setPending(null);
    setMethod(null);
    setConsentError(null);
  };

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
          if (!err) setPending(file);
        }}
      />
      {mutation.isPending ? (
        <div className="flex w-64 items-center gap-2">
          <div
            role="progressbar"
            aria-label="Upload progress"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(progress * 100)}
            className="h-2 flex-1 overflow-hidden rounded-full bg-muted"
          >
            <div
              className="h-full origin-left bg-primary motion-safe:transition-transform motion-safe:duration-200"
              style={{ transform: `scaleX(${progress})` }}
            />
          </div>
          <span className="w-10 text-right text-xs tabular-nums text-muted-foreground">
            {Math.round(progress * 100)}%
          </span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => abortRef.current?.abort()}
            aria-label="Cancel upload"
          >
            <X aria-hidden />
          </Button>
        </div>
      ) : (
        <Button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={!organizationId || pending !== null}
        >
          <Upload aria-hidden />
          Upload recording
        </Button>
      )}
      {validation ? (
        <p role="alert" className="text-sm text-destructive">
          {validation}
        </p>
      ) : null}
      {pending ? (
        <form
          aria-label="Recording consent"
          noValidate
          className="w-80 space-y-3 rounded-xl border bg-card p-4 text-sm motion-safe:animate-in motion-safe:fade-in-0"
          onSubmit={(e) => {
            e.preventDefault();
            if (!method) {
              setConsentError('Confirm how everyone was told about the recording.');
              return;
            }
            mutation.mutate({ file: pending, consent: method });
            reset();
          }}
        >
          <p className="truncate font-medium">{pending.name}</p>
          <fieldset
            className="space-y-2"
            aria-invalid={consentError ? true : undefined}
            aria-describedby={consentError ? `${uid}-consent-error` : undefined}
          >
            <legend className="mb-1 text-muted-foreground">Recording consent</legend>
            {(Object.keys(CONSENT_LABEL) as ConsentMethod[]).map((m) => (
              <label key={m} className="flex min-h-11 cursor-pointer items-start gap-2">
                <input
                  type="radio"
                  name={`${uid}-consent`}
                  value={m}
                  checked={method === m}
                  onChange={() => {
                    setMethod(m);
                    setConsentError(null);
                  }}
                  className="mt-0.5 accent-primary"
                />
                <span>{CONSENT_LABEL[m]}</span>
              </label>
            ))}
          </fieldset>
          {consentError ? (
            <p id={`${uid}-consent-error`} className="text-destructive">
              {consentError}
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={reset}>
              Cancel
            </Button>
            <Button type="submit">Start upload</Button>
          </div>
        </form>
      ) : null}
    </div>
  );
}
