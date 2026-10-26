import { useState } from 'react';
import { Download } from 'lucide-react';
import type { Id } from '@meetops/contracts';
import { Button } from '@/components/ui/button';
import { ApiError, assertHttpsUrl } from '@/lib/api/client';
import { describeError } from '@/lib/api/error-messages';
import { useApi } from '@/lib/api/context';
import { useOrganizationId } from '@/lib/api/queries';

/**
 * Safe `download` filename: drops path separators, control and reserved characters, caps length.
 * React escapes the visible text; this protects the attribute and the saved file name.
 */
export function safeDownloadName(name: string): string {
  const cleaned = name
    .replace(/[\p{Cc}/\\:*?"<>|]+/gu, '_')
    .replace(/^\.+/, '')
    .trim();
  return (cleaned || 'download').slice(0, 255);
}

/**
 * Fetches a presigned GET (<= 300 s) on click and navigates to it at once. The URL is never cached
 * (no query cache, no state), so an expired link cannot be reused. The API (feat/api-uploads@431a254)
 * answers 404 until scanStatus is `clean`, with the same body as an unknown id, and no scanner exists
 * yet; this link is only rendered after a successful complete, so 404 (and 409) means "processing".
 */
export function DownloadLink({ fileObjectId, filename }: { fileObjectId: Id; filename: string }) {
  const api = useApi();
  const organizationId = useOrganizationId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [processing, setProcessing] = useState(false);
  const name = safeDownloadName(filename);

  async function onClick() {
    setBusy(true);
    setError(null);
    setProcessing(false);
    try {
      const { url } = await api.storage.getDownloadUrl(organizationId, fileObjectId);
      assertHttpsUrl(url);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      a.rel = 'noopener noreferrer';
      a.click();
    } catch (e) {
      if (e instanceof ApiError && (e.status === 404 || e.status === 409)) setProcessing(true);
      else setError(describeError(e).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col items-start gap-1">
      <Button
        type="button"
        variant="outline"
        className="min-h-11"
        onClick={() => void onClick()}
        disabled={busy}
        aria-busy={busy}
      >
        <Download aria-hidden />
        <span>
          Download <span className="sr-only">{name}</span>
        </span>
      </Button>
      {processing ? (
        <p role="status" className="text-sm text-muted-foreground">
          Still processing. The download is available once the security scan finishes.
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
