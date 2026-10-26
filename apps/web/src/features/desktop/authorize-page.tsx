import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { AlertCircle, CheckCircle2, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { useSession } from '@/features/session/use-session';
import { useApi } from '@/lib/api/context';
import { useOrgStore } from '@/stores/org-store';
import { describeDesktopAuthorizeError, type DesktopAuthorizeFailure } from './authorize-errors';
import {
  buildCallbackUrl,
  isValidAuthorizationCode,
  toDesktopAuthorizeRequest,
  type DesktopAuthorizeSearch,
} from './authorize';

type Status =
  | { kind: 'idle' }
  | { kind: 'requesting' }
  | { kind: 'redirecting' }
  | { kind: 'cancelled' }
  | { kind: 'failed'; failure: DesktopAuthorizeFailure };

const INVALID_CODE: DesktopAuthorizeFailure = {
  title: 'Unexpected response',
  message: 'We received an unexpected sign-in code. Start sign-in again from the desktop app.',
  retryable: false,
};

/** Indirection so tests can observe the loopback redirect without navigating jsdom. */
export const desktopRedirect = {
  assign: (url: string) => window.location.assign(url),
};

function Notice({
  title,
  children,
  focusRef,
  testId,
}: {
  title: string;
  children: ReactNode;
  focusRef?: React.Ref<HTMLDivElement>;
  testId: string;
}) {
  return (
    <Alert variant="destructive" data-testid={testId} ref={focusRef} tabIndex={-1}>
      <AlertCircle className="h-4 w-4" aria-hidden />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription className="flex flex-col gap-3">{children}</AlertDescription>
    </Alert>
  );
}

/**
 * /desktop/authorize (ADR-012 §1.4-1.6): confirm user, organization and device, then POST
 * /auth/desktop/authorize and redirect to the app's 127.0.0.1 loopback callback with `code` and `state`.
 * Nothing is sent until the user confirms. Errors are inline (focus moves to them), never server text.
 */
export function DesktopAuthorizePage({ search }: { search: DesktopAuthorizeSearch }) {
  const api = useApi();
  const { data: session } = useSession();
  const org = useOrgStore((s) => s.organizations.find((o) => o.id === s.currentOrganizationId));
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  // Parsing runs regex + URL checks; only redo it when the search object changes.
  const request = useMemo(() => toDesktopAuthorizeRequest(search), [search]);
  const focusRef = useRef<HTMLDivElement>(null);
  const headingId = useId();
  const detailsId = useId();

  useEffect(() => {
    if (status.kind === 'failed' || status.kind === 'cancelled' || status.kind === 'redirecting')
      focusRef.current?.focus();
  }, [status]);

  const pending = status.kind === 'requesting' || status.kind === 'redirecting';

  const authorize = async () => {
    if (!request || pending) return;
    setStatus({ kind: 'requesting' });
    let res;
    try {
      res = await api.desktop.authorize(request);
    } catch (error) {
      setStatus({ kind: 'failed', failure: describeDesktopAuthorizeError(error) });
      return;
    }
    if (!isValidAuthorizationCode(res?.code)) {
      setStatus({ kind: 'failed', failure: INVALID_CODE });
      return;
    }
    setStatus({ kind: 'redirecting' });
    desktopRedirect.assign(buildCallbackUrl(request.redirectUri, res.code, request.state));
  };

  const announce =
    status.kind === 'requesting'
      ? 'Authorizing the desktop app…'
      : status.kind === 'redirecting'
        ? 'Returning to the desktop app…'
        : status.kind === 'cancelled'
          ? 'Desktop sign-in cancelled.'
          : status.kind === 'failed'
            ? `${status.failure.title}. ${status.failure.message}`
            : '';

  const body = (() => {
    if (!request)
      return (
        <Notice title="Invalid sign-in link" testId="desktop-invalid">
          This desktop sign-in link is incomplete or malformed. Start sign-in again from the MeetOps
          desktop app.
        </Notice>
      );
    if (!org)
      return (
        <Notice title="No organization selected" testId="desktop-no-org">
          Create or select an organization before signing in to the desktop app.
        </Notice>
      );
    if (status.kind === 'cancelled')
      return (
        <div
          ref={focusRef}
          tabIndex={-1}
          data-testid="desktop-cancelled"
          className="text-sm outline-none"
        >
          Sign-in cancelled. The desktop app was not given access. You can close this tab.
        </div>
      );
    if (status.kind === 'redirecting')
      return (
        <div
          ref={focusRef}
          tabIndex={-1}
          data-testid="desktop-redirecting"
          className="flex items-center gap-2 text-sm outline-none"
        >
          <CheckCircle2 className="h-5 w-5 text-link" aria-hidden />
          <span>Returning to the desktop app. If nothing happens, go back to MeetOps desktop.</span>
        </div>
      );
    return (
      <div className="flex flex-col gap-4">
        <dl id={detailsId} className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-muted-foreground">Signed in as</dt>
          <dd data-testid="desktop-user" className="break-all">
            {session ? `${session.user.name} (${session.user.email})` : 'Unknown user'}
          </dd>
          <dt className="text-muted-foreground">Organization</dt>
          <dd data-testid="desktop-org">{org.name}</dd>
          <dt className="text-muted-foreground">Device</dt>
          <dd data-testid="desktop-device">{request.deviceLabel ?? 'Unnamed device'}</dd>
        </dl>
        <p className="text-sm text-muted-foreground">
          Only continue if you just started sign-in from the MeetOps desktop app on this computer.
          The app gets access to meetings and recordings in this organization only.
        </p>
        {status.kind === 'failed' ? (
          <Notice title={status.failure.title} focusRef={focusRef} testId="desktop-error">
            <span>{status.failure.message}</span>
            {status.failure.requestId ? (
              <span className="text-xs" data-testid="request-id">
                Reference: {status.failure.requestId}
              </span>
            ) : null}
          </Notice>
        ) : null}
        <div className="flex flex-wrap gap-2">
          {status.kind === 'failed' && !status.failure.retryable ? null : (
            <Button
              className="h-11 min-w-44"
              onClick={() => void authorize()}
              disabled={pending}
              aria-busy={pending || undefined}
              aria-describedby={detailsId}
            >
              {pending ? (
                <Loader2 className="mr-2 h-4 w-4 motion-safe:animate-spin" aria-hidden />
              ) : null}
              {pending
                ? 'Authorizing…'
                : status.kind === 'failed'
                  ? 'Try again'
                  : 'Allow desktop sign-in'}
            </Button>
          )}
          <Button
            variant="outline"
            className="h-11"
            onClick={() => setStatus({ kind: 'cancelled' })}
            disabled={pending}
          >
            Cancel
          </Button>
        </div>
      </div>
    );
  })();

  return (
    <section className="mx-auto max-w-lg p-6" aria-labelledby={headingId}>
      <Card aria-busy={pending || undefined}>
        <CardHeader>
          <CardTitle id={headingId} role="heading" aria-level={1}>
            Sign in to MeetOps desktop
          </CardTitle>
          <CardDescription>
            Confirm the account, organization and device. Your password never goes to the desktop
            app.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div
            role="status"
            aria-live="polite"
            aria-atomic="true"
            className="sr-only"
            data-testid="desktop-live"
          >
            {announce}
          </div>
          {body}
        </CardContent>
      </Card>
    </section>
  );
}
