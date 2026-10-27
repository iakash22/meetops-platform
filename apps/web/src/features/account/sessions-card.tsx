import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { SessionSummary } from '@meetops/contracts';
import { LoadingState, ErrorState, EmptyState } from '@/components/states/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ApiError } from '@/lib/api/client';
import { useApi } from '@/lib/api/context';
import { notify, toastError } from '@/lib/errors/notify';
import { describeUserAgent, formatDateTime } from './device-label';
import {
  countryFlag,
  formatLocation,
  isNewLocation,
  type SessionWithGeo,
} from './session-location';

const UNKNOWN = 'Unknown location';
const APPROX_HINT = 'Approximate location based on IP address';
import { useEndLocalSession } from './end-session';
import { accountKeys, useMySessions } from './queries';

/**
 * Active sessions (GET /auth/sessions) with per-session revoke (DELETE /auth/sessions/:id).
 * Revoking needs a second click to confirm. Revoking the current session signs this
 * browser out (the API clears the cookie). A 404 means the session already ended.
 */
export function SessionsCard() {
  const api = useApi();
  const queryClient = useQueryClient();
  const endLocalSession = useEndLocalSession();
  const query = useMySessions();
  const [confirming, setConfirming] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);

  const revoke = async (s: SessionSummary) => {
    setPending(s.id);
    try {
      await api.auth.revokeSession(s.id);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return endLocalSession();
      setPending(null);
      setConfirming(null);
      if (err instanceof ApiError && err.status === 404) {
        notify.info('That session had already ended.');
        await queryClient.invalidateQueries({ queryKey: accountKeys.sessions });
        return;
      }
      toastError(err, { title: "Couldn't revoke that session" });
      return;
    }
    if (s.current) return endLocalSession();
    setPending(null);
    setConfirming(null);
    notify.success(`Signed out ${describeUserAgent(s.userAgent)}.`);
    await queryClient.invalidateQueries({ queryKey: accountKeys.sessions });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>Active sessions</h2>
        </CardTitle>
        <CardDescription>
          Devices signed in to your account. Revoke any you don&apos;t recognise.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        {query.isError ? (
          <ErrorState error={query.error} onRetry={() => void query.refetch()} />
        ) : query.isPending ? (
          <LoadingState label="Loading sessions…" rows={2} />
        ) : query.data.items.length === 0 ? (
          <EmptyState title="No active sessions" />
        ) : (
          <ul className="divide-y rounded-lg border" aria-label="Sessions">
            {query.data.items.map((summary) => {
              const s: SessionWithGeo = summary;
              const current = (query.data.items as SessionWithGeo[]).find((x) => x.current);
              const flag = countryFlag(s.geoCountryCode);
              const code = s.geoCountryCode?.trim().toUpperCase();
              const label = describeUserAgent(s.userAgent);
              const location = formatLocation(s);
              const isConfirming = confirming === s.id;
              return (
                <li
                  key={s.id}
                  data-testid="session-row"
                  className="flex flex-wrap items-center justify-between gap-3 p-3"
                >
                  <div className="grid gap-0.5">
                    <span
                      className="flex flex-wrap items-center gap-2 font-medium"
                      data-testid="session-location"
                    >
                      {flag ? (
                        <span role="img" aria-label={code ?? ''}>
                          {flag}
                        </span>
                      ) : code ? (
                        <span className="text-xs text-muted-foreground">[{code}]</span>
                      ) : null}
                      <span>
                        {label} · {location}
                      </span>
                      {location !== UNKNOWN && s.geoApproximate !== false ? (
                        <abbr
                          title={APPROX_HINT}
                          aria-label={APPROX_HINT}
                          className="cursor-help text-xs text-muted-foreground no-underline"
                        >
                          ≈ approximate
                        </abbr>
                      ) : null}
                      {s.current ? <Badge variant="secondary">This device</Badge> : null}
                      {isNewLocation(s, current) ? (
                        <Badge variant="destructive" data-testid="new-location">
                          New location
                        </Badge>
                      ) : null}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      Last active{' '}
                      <time dateTime={s.lastSeenAt}>{formatDateTime(s.lastSeenAt)}</time>
                      {s.ip ? ` · ${s.ip}` : ''}
                    </span>
                  </div>
                  {isConfirming ? (
                    <div className="flex gap-2">
                      <Button
                        variant="destructive"
                        size="sm"
                        disabled={pending !== null}
                        onClick={() => void revoke(s)}
                      >
                        {pending === s.id
                          ? 'Revoking…'
                          : s.current
                            ? 'Sign out this device'
                            : 'Confirm revoke'}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={pending !== null}
                        onClick={() => setConfirming(null)}
                      >
                        Cancel
                      </Button>
                    </div>
                  ) : (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={pending !== null}
                      aria-label={`Revoke ${label}${s.current ? ' (this device)' : ''}`}
                      onClick={() => setConfirming(s.id)}
                    >
                      Revoke
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {query.data?.truncated ? (
          <p className="text-xs text-muted-foreground">
            Showing the most recent sessions only. Use “Log out all devices” to end all of them.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
