import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Upload, X } from 'lucide-react';
import type { Id } from '@meetops/contracts';
import { CONSENT_METHODS, CURRENT_CONSENT_VERSION } from '@meetops/contracts/types';
import { Button } from '@/components/ui/button';
import { ApiError } from '@/lib/api/client';
import { notify } from '@/lib/errors/notify';
import { describeError } from '@/lib/api/error-messages';
import { useApi } from '@/lib/api/context';
import { useOrganizationId } from '@/lib/api/queries';
import { hashFile } from '@/features/uploads/hash-file';
import { ScanStatusBadge } from '@/features/uploads/scan-status-badge';
import { DownloadLink } from '@/features/uploads/download-link';
import { consentSettingsQueryKey } from '@/features/uploads/consent-queries';
import type { CompleteUploadResponse } from '@/features/uploads/types';
import { UPLOAD_ACCEPT, validateUploadFile } from '@/features/uploads/validate';

export { MAX_UPLOAD_BYTES, validateUploadFile } from '@/features/uploads/validate';
export { sha256Base64Of as sha256Base64 } from '@/features/uploads/sha256';

type ConsentMethod = (typeof CONSENT_METHODS)[number];
type Phase = 'hashing' | 'uploading' | 'completing';

const METHOD_LABEL: Record<ConsentMethod, string> = {
  all_parties_notified: 'Everyone in the recording was told it was being recorded',
  all_parties_consented: 'Everyone in the recording agreed to be recorded',
};
const PHASE_LABEL: Record<Phase, string> = {
  hashing: 'Preparing file…',
  uploading: 'Uploading…',
  completing: 'Finishing…',
};

/** Fixed copy for upload-specific failures; everything else uses the error-code mapping. */
export function describeUploadError(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.reason === 'CONSENT_REQUIRED') return 'Confirm consent before uploading.';
    if (e.reason === 'CONSENT_VERSION_UNSUPPORTED')
      return 'The consent notice has changed. Review it and confirm again.';
    if (e.reason === 'CONSENT_INVALID')
      return "Consent couldn't be verified. Check your device clock and try again.";
    // Size caps: 413 PAYLOAD_TOO_LARGE (contracts 0.5.0). A 409 is a real conflict and uses the generic mapping.
    if (e.code === 'PAYLOAD_TOO_LARGE' || e.status === 413)
      return 'This recording would exceed the 1.4 GB total. Upload a smaller file.';
    if (e.status === 400) return 'The file is larger than 1.4 GB or not a supported type.';
  }
  if (e instanceof Error && e.message === 'Could not read the file.') return e.message;
  return describeError(e).message;
}

/**
 * Upload with a consent step: pick → client checks (type, size) → consent attestation →
 * sha256 in a Web Worker → presigned PUT with progress → complete → scan status.
 */
export function UploadButton({ meetingId }: { meetingId?: Id }) {
  const api = useApi();
  const organizationId = useOrganizationId();
  const queryClient = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [validation, setValidation] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase | null>(null);
  const [progress, setProgress] = useState(0);
  const ids = useId();

  // Notice + version come from org settings (all roles may GET). Fetched only once a file is chosen.
  const settings = useQuery({
    queryKey: consentSettingsQueryKey(organizationId),
    queryFn: () => api.consentSettings.get(organizationId),
    enabled: !!file && !!organizationId,
    retry: false,
    staleTime: 60_000,
  });
  const allParty = settings.data?.mode !== 'one_party';
  const methods: readonly ConsentMethod[] = allParty ? ['all_parties_consented'] : CONSENT_METHODS;
  const [method, setMethod] = useState<ConsentMethod>('all_parties_consented');
  const [confirmed, setConfirmed] = useState(false);

  useEffect(() => () => abortRef.current?.abort(), []);

  const mutation = useMutation({
    mutationFn: async (f: File): Promise<CompleteUploadResponse> => {
      const ac = new AbortController();
      abortRef.current = ac;
      setProgress(0);
      setPhase('hashing');
      const checksumSha256 = await hashFile(f, ac.signal);
      const { fileObjectId, upload } = await api.storage.createUpload(organizationId, {
        filename: f.name,
        mimeType: f.type,
        sizeBytes: f.size,
        checksumSha256,
        ...(meetingId ? { meetingId } : {}),
        consent: {
          consentVersion: settings.data?.currentConsentVersion ?? CURRENT_CONSENT_VERSION,
          attestedAt: new Date().toISOString(),
          method: methods.includes(method) ? method : 'all_parties_consented',
        },
      });
      setPhase('uploading');
      await api.storage.putToPresignedUrl(upload, f, {
        onProgress: (fraction) => setProgress(Math.min(100, Math.round(fraction * 100))),
        signal: ac.signal,
      });
      setProgress(100);
      setPhase('completing');
      return api.storage.completeUpload(organizationId, fileObjectId);
    },
    onSettled: () => {
      setPhase(null);
      abortRef.current = null;
    },
    onSuccess: () => {
      setConfirmed(false);
      notify.success('Upload complete', 'Processing starts shortly.');
      return queryClient.invalidateQueries({ queryKey: ['orgs', organizationId, 'meetings'] });
    },
    onError: (e) => {
      // Non-field failures are toasts (docs/references.md); a cancel is informational.
      if (e instanceof DOMException && e.name === 'AbortError') notify.info('Upload cancelled');
      else notify.error('Upload failed', describeUploadError(e));
      if (e instanceof ApiError && e.reason === 'CONSENT_VERSION_UNSUPPORTED') {
        setConfirmed(false);
        void queryClient.invalidateQueries({ queryKey: consentSettingsQueryKey(organizationId) });
      }
    },
  });

  const reset = useCallback(() => {
    abortRef.current?.abort();
    setFile(null);
    setConfirmed(false);
    mutation.reset();
  }, [mutation]);

  const busy = mutation.isPending;
  const consentStep = !!file && !busy && !mutation.isSuccess;

  return (
    <div className="flex w-full max-w-md flex-col items-end gap-3">
      <input
        ref={inputRef}
        type="file"
        accept={UPLOAD_ACCEPT}
        className="sr-only"
        tabIndex={-1}
        aria-hidden
        data-testid="upload-input"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (!f) return;
          const err = validateUploadFile(f);
          setValidation(err);
          mutation.reset();
          setConfirmed(false);
          setFile(err ? null : f);
        }}
      />
      {!file || mutation.isSuccess ? (
        <Button
          type="button"
          className="min-h-11"
          onClick={() => {
            if (mutation.isSuccess) reset();
            inputRef.current?.click();
          }}
          disabled={!organizationId}
        >
          <Upload aria-hidden />
          Upload recording
        </Button>
      ) : null}
      {validation ? (
        <p role="alert" className="text-sm text-destructive">
          {validation}
        </p>
      ) : null}

      {consentStep ? (
        <form
          aria-labelledby={`${ids}-title`}
          className="w-full rounded-lg border border-border bg-card p-4 text-left"
          onSubmit={(e) => {
            e.preventDefault();
            if (confirmed && file) mutation.mutate(file);
          }}
        >
          <h3 id={`${ids}-title`} className="text-sm font-semibold">
            Recording consent
          </h3>
          <p className="mt-1 break-all text-xs text-muted-foreground">{file.name}</p>
          <p className="mt-3 whitespace-pre-line text-sm" data-testid="consent-notice">
            {settings.data?.noticeText ??
              'Only upload recordings that everyone in them knew about. Uploads are kept according to your organization’s retention policy.'}
          </p>
          <fieldset className="mt-3 space-y-2">
            <legend className="sr-only">How consent was obtained</legend>
            {methods.map((m) => (
              <label key={m} className="flex min-h-11 cursor-pointer items-center gap-3 text-sm">
                <input
                  type={methods.length > 1 ? 'radio' : 'checkbox'}
                  name={`${ids}-method`}
                  className="size-5 accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  checked={methods.length > 1 ? method === m && confirmed : confirmed}
                  onChange={(e) => {
                    setMethod(m);
                    setConfirmed(methods.length > 1 ? true : e.target.checked);
                  }}
                />
                {METHOD_LABEL[m]}
              </label>
            ))}
          </fieldset>
          <div className="mt-4 flex justify-end gap-2">
            <Button type="button" variant="outline" className="min-h-11" onClick={reset}>
              Cancel
            </Button>
            <Button type="submit" className="min-h-11" disabled={!confirmed || settings.isPending}>
              Confirm and upload
            </Button>
          </div>
        </form>
      ) : null}

      {busy && phase ? (
        <div className="w-full" role="status" aria-live="polite">
          <div className="mb-1 flex items-center justify-between text-sm">
            <span>{PHASE_LABEL[phase]}</span>
            <Button type="button" variant="outline" size="sm" className="min-h-11" onClick={reset}>
              <X aria-hidden /> Cancel upload
            </Button>
          </div>
          <div
            role="progressbar"
            aria-label="Upload progress"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={phase === 'uploading' ? progress : undefined}
            className="h-2 w-full overflow-hidden rounded-full bg-secondary"
          >
            <div
              className="h-full origin-left bg-primary motion-safe:transition-transform motion-safe:duration-200"
              style={{ transform: `scaleX(${phase === 'hashing' ? 0 : progress / 100})` }}
            />
          </div>
        </div>
      ) : null}

      {mutation.isSuccess && file ? (
        <div className="flex w-full flex-wrap items-center justify-end gap-3" role="status">
          <span className="text-sm">Upload complete</span>
          <ScanStatusBadge status={mutation.data.scanStatus} />
          <DownloadLink fileObjectId={mutation.data.fileObject.id} filename={file.name} />
        </div>
      ) : null}
    </div>
  );
}
