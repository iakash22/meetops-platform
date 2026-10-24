import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { AlertCircle, CheckCircle2, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import { useApi } from '@/lib/api/context';
import { useOrgStore } from '@/stores/org-store';
import { describePairError, isPairingCodeExpired, type PairFailure } from './pair-errors';
import {
  buildPairingMessage,
  ExtensionUnavailableError,
  getChromeRuntime,
  isValidPairingCode,
  sendPairingMessage,
  toPairRequest,
  type PairSearch,
} from './pairing';

type Status =
  | { kind: 'idle' }
  | { kind: 'requesting' }
  | { kind: 'delivering' }
  | { kind: 'success'; organizationName: string }
  | { kind: 'failed'; failure: PairFailure };

const FAILURES = {
  invalidCode: {
    title: 'Invalid pairing code',
    message: 'We received an unexpected pairing code. Try again.',
    retryable: true,
  },
  expired: {
    title: 'Pairing code expired',
    message: 'The pairing code expired before it reached the extension. Try again.',
    retryable: true,
  },
  unreachable: {
    title: "Couldn't reach the extension",
    message:
      'Make sure the MeetOps extension is installed and enabled, then try again or start pairing from the extension.',
    retryable: true,
  },
} satisfies Record<string, PairFailure>;

const PENDING_LABEL = {
  requesting: 'Requesting a pairing code…',
  delivering: 'Sending the code to the extension…',
} as const;

/** Focusable (tabIndex -1) notice; receives focus when it appears so screen readers and keyboards land on it. */
function Notice({
  title,
  children,
  focusRef,
  testId = 'pair-notice',
}: {
  title: string;
  children: ReactNode;
  focusRef?: React.Ref<HTMLDivElement>;
  testId?: string;
}) {
  return (
    <Alert variant="destructive" data-testid={testId} ref={focusRef} tabIndex={-1}>
      <AlertCircle className="h-4 w-4" aria-hidden />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription className="flex flex-col gap-3">{children}</AlertDescription>
    </Alert>
  );
}

/** /extension/pair (ADR-005 A1.1): confirm org + device, POST pair, hand the code to the extension. */
export function ExtensionPairPage({ search }: { search: PairSearch }) {
  const api = useApi();
  const org = useOrgStore((s) => s.organizations.find((o) => o.id === s.currentOrganizationId));
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const request = toPairRequest(search);
  const hasRuntime = getChromeRuntime() !== null;
  const focusRef = useRef<HTMLDivElement>(null);
  const headingId = useId();
  const detailsId = useId();

  // Move focus to the outcome (error or success) so it is announced and the next action is reachable.
  useEffect(() => {
    if (status.kind === 'failed' || status.kind === 'success') focusRef.current?.focus();
  }, [status]);

  const pending = status.kind === 'requesting' || status.kind === 'delivering';
  const fail = (failure: PairFailure) => setStatus({ kind: 'failed', failure });

  const pair = async () => {
    if (!request || pending) return;
    setStatus({ kind: 'requesting' });
    let res;
    try {
      res = await api.extension.pair(request);
    } catch (error) {
      fail(describePairError(error));
      return;
    }
    if (!isValidPairingCode(res.pairingCode)) return fail(FAILURES.invalidCode);
    if (isPairingCodeExpired(res.expiresAt)) return fail(FAILURES.expired);
    setStatus({ kind: 'delivering' });
    try {
      await sendPairingMessage(
        request.extensionId,
        buildPairingMessage(res.pairingCode, request.nonce),
      );
    } catch (err) {
      if (err instanceof ExtensionUnavailableError) return fail(FAILURES.unreachable);
      throw err;
    }
    // TODO(contracts): the extension's sendMessage response has no contract shape, so "delivered" only means the
    // extension acknowledged receipt; it does not confirm the token exchange (POST /auth/extension-token) succeeded.
    setStatus({ kind: 'success', organizationName: res.organizationName });
  };

  const announce =
    status.kind === 'requesting' || status.kind === 'delivering'
      ? PENDING_LABEL[status.kind]
      : status.kind === 'success'
        ? `Extension connected to ${status.organizationName}.`
        : status.kind === 'failed'
          ? `${status.failure.title}. ${status.failure.message}`
          : '';

  const body = (() => {
    if (!request)
      return (
        <Notice title="Invalid pairing link">
          This pairing link is incomplete or malformed. Start pairing again from the MeetOps
          extension.
        </Notice>
      );
    if (!hasRuntime)
      return (
        <Notice title="Extension not available">
          Open this page in Chrome with the MeetOps extension installed, then start pairing from the
          extension.
        </Notice>
      );
    if (!org)
      return (
        <Notice title="No organization selected">
          Create or select an organization before connecting the extension.
        </Notice>
      );
    if (status.kind === 'success')
      return (
        <div
          ref={focusRef}
          tabIndex={-1}
          data-testid="pair-success"
          className="flex items-center gap-2 text-sm outline-none"
        >
          <CheckCircle2 className="h-5 w-5 text-green-600" aria-hidden />
          <span>Extension connected to {status.organizationName}. You can close this tab.</span>
        </div>
      );

    return (
      <div className="flex flex-col gap-4">
        <dl id={detailsId} className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-muted-foreground">Organization</dt>
          <dd data-testid="pair-org">{org.name}</dd>
          <dt className="text-muted-foreground">Device</dt>
          <dd data-testid="pair-device">{request.deviceLabel ?? 'Unnamed device'}</dd>
        </dl>
        {pending ? (
          <div data-testid="pair-pending" aria-hidden className="space-y-2">
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-4 w-1/2" />
          </div>
        ) : null}
        {status.kind === 'failed' ? (
          <Notice title={status.failure.title} focusRef={focusRef} testId="pair-error">
            <span>{status.failure.message}</span>
            {status.failure.requestId ? (
              <span className="text-xs" data-testid="request-id">
                Reference: {status.failure.requestId}
              </span>
            ) : null}
          </Notice>
        ) : null}
        {status.kind === 'failed' && !status.failure.retryable ? null : (
          <Button
            onClick={() => void pair()}
            disabled={pending}
            aria-busy={pending || undefined}
            aria-describedby={detailsId}
            className="w-fit"
          >
            {pending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden /> : null}
            {pending ? 'Connecting…' : status.kind === 'failed' ? 'Try again' : 'Connect extension'}
          </Button>
        )}
      </div>
    );
  })();

  return (
    <section className="mx-auto max-w-lg p-6" aria-labelledby={headingId}>
      <Card aria-busy={pending || undefined}>
        <CardHeader>
          <CardTitle id={headingId} role="heading" aria-level={1}>
            Connect the MeetOps extension
          </CardTitle>
          <CardDescription>
            Confirm the organization and device. The extension never receives your web session.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div
            role="status"
            aria-live="polite"
            aria-atomic="true"
            className="sr-only"
            data-testid="pair-live"
          >
            {announce}
          </div>
          {body}
        </CardContent>
      </Card>
    </section>
  );
}
