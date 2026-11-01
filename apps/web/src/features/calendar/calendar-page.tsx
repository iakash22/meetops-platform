import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Link2Off,
  Video,
} from 'lucide-react';
import type { CalendarProviderStatus } from '@meetops/contracts';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState, ErrorState, LoadingState } from '@/components/states/states';
import { PageHeader } from '@/components/ui/typography';
import { useApi } from '@/lib/api/context';
import { useOrganizationId } from '@/lib/api/queries';
import { notify, toastError } from '@/lib/errors/notify';
import { isAllowedConferenceUrl } from '@meetops/contracts/types';
import { AUTHORIZE_HOSTS, safeAuthorizeUrl } from '@/features/integrations/api';
import { getCalendarApi, groupByDay, weekWindow } from './api';

/** Full-page redirect to the provider's OAuth screen; an object so tests can stub it. */
export const calendarRedirect = { assign: (url: string) => window.location.assign(url) };

const NAMES: Record<CalendarProviderStatus['provider'], string> = { google: 'Google Calendar' };

const dayLabel = (key: string) =>
  new Date(`${key}T00:00:00`).toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
  });
const timeLabel = (iso: string) =>
  new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

export function CalendarPage({ now = () => new Date() }: { now?: () => Date }) {
  const api = useApi();
  const organizationId = useOrganizationId();
  const calendar = getCalendarApi(api.request);
  const [offset, setOffset] = useState(0);
  const providers = useQuery({
    queryKey: ['orgs', organizationId, 'calendar', 'providers'],
    queryFn: () => calendar.providers(organizationId),
    enabled: !!organizationId,
  });
  const connected = (providers.data?.items ?? []).some(
    (p) => p.connection && p.connection.status !== 'revoked',
  );
  const win = weekWindow(now(), offset);
  const events = useQuery({
    queryKey: ['orgs', organizationId, 'calendar', 'events', win.from.toISOString()],
    queryFn: () => calendar.events(organizationId, win.from.toISOString(), win.to.toISOString()),
    enabled: !!organizationId && connected,
  });

  const range = `${win.from.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} – ${new Date(
    win.to.getTime() - 86_400_000,
  ).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Schedule"
        title="Calendar"
        description="Your upcoming meetings from your connected calendar. Only you can see your calendar."
      />
      {providers.isError ? (
        <ErrorState error={providers.error} onRetry={() => void providers.refetch()} />
      ) : !providers.data ? (
        <LoadingState />
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {providers.data.items.map((p) => (
            <ProviderCard key={p.provider} status={p} />
          ))}
        </div>
      )}
      {connected ? (
        <section aria-labelledby="week-heading" className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 id="week-heading" className="text-lg font-semibold">
              {range}
            </h2>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="outline"
                className="min-h-11"
                aria-label="Previous week"
                onClick={() => setOffset((o) => o - 1)}
              >
                <ChevronLeft aria-hidden />
              </Button>
              <Button
                type="button"
                variant="outline"
                className="min-h-11"
                disabled={offset === 0}
                onClick={() => setOffset(0)}
              >
                This week
              </Button>
              <Button
                type="button"
                variant="outline"
                className="min-h-11"
                aria-label="Next week"
                onClick={() => setOffset((o) => o + 1)}
              >
                <ChevronRight aria-hidden />
              </Button>
            </div>
          </div>
          {events.isError ? (
            <ErrorState error={events.error} onRetry={() => void events.refetch()} />
          ) : !events.data ? (
            <LoadingState />
          ) : events.data.items.length === 0 ? (
            <EmptyState title="No events this week" description="Nothing on your calendar." />
          ) : (
            <ol className="space-y-4">
              {groupByDay(events.data.items).map(([day, items]) => (
                <li key={day}>
                  <h3 className="mb-2 text-sm font-medium text-muted-foreground">
                    {dayLabel(day)}
                  </h3>
                  <ul className="divide-y rounded-md border">
                    {items.map((e) => (
                      <li
                        key={`${e.connectionId}:${e.id}`}
                        className="flex flex-wrap items-center gap-3 p-3 text-sm"
                      >
                        <span className="w-28 shrink-0 tabular-nums text-muted-foreground">
                          {e.allDay ? 'All day' : `${timeLabel(e.startsAt)}–${timeLabel(e.endsAt)}`}
                        </span>
                        <span
                          className={
                            e.status === 'cancelled'
                              ? 'min-w-0 flex-1 truncate line-through'
                              : 'min-w-0 flex-1 truncate font-medium'
                          }
                        >
                          {e.title}
                        </span>
                        {e.status === 'tentative' ? (
                          <Badge variant="secondary">Tentative</Badge>
                        ) : null}
                        {isAllowedConferenceUrl(e.conferenceUrl) ? (
                          <a
                            className="inline-flex items-center gap-1 text-primary underline-offset-4 hover:underline"
                            href={e.conferenceUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            <Video aria-hidden className="size-4" />
                            Join
                          </a>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ol>
          )}
        </section>
      ) : null}
    </div>
  );
}

function ProviderCard({ status }: { status: CalendarProviderStatus }) {
  const api = useApi();
  const organizationId = useOrganizationId();
  const calendar = getCalendarApi(api.request);
  const queryClient = useQueryClient();
  const name = NAMES[status.provider];
  const conn =
    status.connection && status.connection.status !== 'revoked' ? status.connection : null;
  const connect = useMutation({
    mutationFn: () => calendar.connect(organizationId, status.provider),
    onSuccess: ({ authorizeUrl }) => {
      const url = safeAuthorizeUrl(authorizeUrl, AUTHORIZE_HOSTS[status.provider]);
      if (!url) notify.error(`Couldn't connect ${name}`, 'The sign-in link was not secure.');
      else calendarRedirect.assign(url);
    },
    onError: (err) => toastError(err, { title: `Couldn't connect ${name}`, onRetry: retryConnect }),
  });
  function retryConnect(): void {
    connect.mutate();
  }
  const disconnect = useMutation({
    mutationFn: (id: string) => calendar.disconnect(organizationId, id),
    onSuccess: async () => {
      notify.success(`${name} disconnected`);
      await queryClient.invalidateQueries({ queryKey: ['orgs', organizationId, 'calendar'] });
    },
    onError: (err) => toastError(err, { title: `Couldn't disconnect ${name}` }),
  });
  return (
    <Card data-testid={`calendar-${status.provider}`}>
      <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
        <div className="flex items-center gap-2">
          <CalendarDays aria-hidden className="size-5" />
          <CardTitle>
            <h2>{name}</h2>
          </CardTitle>
        </div>
        <Badge variant={conn?.status === 'error' ? 'destructive' : conn ? 'default' : 'secondary'}>
          {conn?.status === 'error' ? 'Needs attention' : conn ? 'Connected' : 'Not connected'}
        </Badge>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {conn ? (
          <p>
            Connected as <span className="font-medium">{conn.displayName}</span>
          </p>
        ) : (
          <p className="text-muted-foreground">Read-only access to your events.</p>
        )}
        {conn?.status === 'error' ? (
          <p className="text-destructive">Access expired. Reconnect to see your events.</p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          {conn ? (
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              disabled={disconnect.isPending}
              onClick={() => disconnect.mutate(conn.id)}
            >
              <Link2Off aria-hidden />
              Disconnect
            </Button>
          ) : null}
          {!status.configured ? (
            <p className="text-muted-foreground">{name} is not set up on this deployment yet.</p>
          ) : !conn || conn.status === 'error' ? (
            <Button
              type="button"
              className="min-h-11"
              disabled={connect.isPending || !organizationId}
              onClick={() => connect.mutate()}
            >
              <ExternalLink aria-hidden />
              {conn ? `Reconnect ${name}` : `Connect ${name}`}
            </Button>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}
