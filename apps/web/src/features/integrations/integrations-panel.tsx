import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, GitBranch, Link2Off, SquareKanban } from 'lucide-react';
import type { IntegrationProvider } from '@meetops/contracts';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ErrorState, LoadingState } from '@/components/states/states';
import { useCanManageDirectory } from '@/features/directory/queries';
import { useApi } from '@/lib/api/context';
import { useOrganizationId } from '@/lib/api/queries';
import { notify, toastError } from '@/lib/errors/notify';
import {
  PROVIDERS,
  currentByProvider,
  getIntegrationsApi,
  isConnectEnabled,
  AUTHORIZE_HOSTS,
  safeAuthorizeUrl,
  type Integration,
} from './api';

const META: Record<IntegrationProvider, { name: string; blurb: string }> = {
  github: { name: 'GitHub', blurb: 'File accepted meeting tasks as GitHub issues.' },
  jira: { name: 'Jira', blurb: 'File accepted meeting tasks as Jira issues.' },
};

/** Full-page redirect to the provider's OAuth screen; an object so tests can stub it. */
export const oauthRedirect = { assign: (url: string) => window.location.assign(url) };

function useIntegrations() {
  const api = useApi();
  const organizationId = useOrganizationId();
  const integrations = getIntegrationsApi(api.request);
  const key = ['orgs', organizationId, 'integrations'] as const;
  const query = useQuery({
    queryKey: key,
    queryFn: () => integrations.list(organizationId),
    enabled: !!organizationId,
  });
  return { integrations, organizationId, key, query };
}

export function IntegrationsPanel() {
  const { query } = useIntegrations();
  const canManage = useCanManageDirectory();
  if (query.isError) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  if (!query.data) return <LoadingState />;
  const current = currentByProvider(query.data.items);
  return (
    <div className="space-y-3">
      {!canManage ? (
        <p className="text-sm text-muted-foreground">
          Only owners and admins can connect or disconnect integrations.
        </p>
      ) : null}
      <div className="grid gap-4 md:grid-cols-2">
        {PROVIDERS.map((p) => (
          <IntegrationCard key={p} provider={p} item={current[p]} canManage={canManage} />
        ))}
      </div>
    </div>
  );
}

function IntegrationCard({
  provider,
  item,
  canManage,
}: {
  provider: IntegrationProvider;
  item: Integration | null;
  canManage: boolean;
}) {
  const { integrations, organizationId, key } = useIntegrations();
  const queryClient = useQueryClient();
  const meta = META[provider];
  const [confirming, setConfirming] = useState(false);
  const connectOn = isConnectEnabled();

  const connect = useMutation({
    mutationFn: () => integrations.connect(organizationId, provider),
    onSuccess: ({ authorizeUrl }) => {
      const url = safeAuthorizeUrl(authorizeUrl, AUTHORIZE_HOSTS[provider]);
      if (!url) notify.error(`Couldn't connect ${meta.name}`, 'The sign-in link was not secure.');
      else oauthRedirect.assign(url);
    },
    onError: (err) => toastError(err, { title: `Couldn't connect ${meta.name}` }),
  });
  const disconnect = useMutation({
    mutationFn: (id: string) => integrations.disconnect(organizationId, id),
    onSuccess: async () => {
      setConfirming(false);
      notify.success(`${meta.name} disconnected`);
      await queryClient.invalidateQueries({ queryKey: key });
    },
    onError: (err) => {
      setConfirming(false);
      toastError(err, { title: `Couldn't disconnect ${meta.name}` });
    },
  });

  const status = item?.status;
  return (
    <Card data-testid={`integration-${provider}`}>
      <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
        <div className="flex items-center gap-2">
          {provider === 'github' ? (
            <GitBranch aria-hidden className="size-5" />
          ) : (
            <SquareKanban aria-hidden className="size-5" />
          )}
          <CardTitle>
            <h2>{meta.name}</h2>
          </CardTitle>
        </div>
        <Badge
          variant={
            status === 'error' ? 'destructive' : status === 'active' ? 'default' : 'secondary'
          }
        >
          {status === 'error'
            ? 'Needs attention'
            : status === 'active'
              ? 'Connected'
              : 'Not connected'}
        </Badge>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <p className="text-muted-foreground">{meta.blurb}</p>
        {item ? (
          <p>
            Connected to <span className="font-medium">{item.displayName}</span>
          </p>
        ) : null}
        {status === 'error' ? (
          <p className="text-destructive">
            {meta.name} stopped responding to MeetOps. Reconnect it to resume syncing.
          </p>
        ) : null}
        {canManage ? (
          <div className="flex flex-wrap gap-2">
            {item ? (
              <Button
                className="min-h-11"
                type="button"
                variant="outline"
                disabled={disconnect.isPending}
                onClick={() => setConfirming(true)}
              >
                <Link2Off aria-hidden />
                Disconnect
              </Button>
            ) : null}
            {(!item || status === 'error') && connectOn ? (
              <Button
                className="min-h-11"
                type="button"
                disabled={connect.isPending || !organizationId}
                onClick={() => connect.mutate()}
              >
                <ExternalLink aria-hidden />
                {status === 'error' ? `Reconnect ${meta.name}` : `Connect ${meta.name}`}
              </Button>
            ) : null}
            {(!item || status === 'error') && !connectOn ? (
              <p className="text-muted-foreground">Connecting {meta.name} is coming soon.</p>
            ) : null}
          </div>
        ) : null}
      </CardContent>
      <Dialog
        open={confirming}
        onOpenChange={(o) => (disconnect.isPending ? null : setConfirming(o))}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Disconnect {meta.name}?</DialogTitle>
            <DialogDescription>
              MeetOps will stop filing tasks to {item?.displayName ?? meta.name}. You can connect it
              again later.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              disabled={disconnect.isPending}
              onClick={() => setConfirming(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              className="min-h-11"
              disabled={disconnect.isPending || !item}
              onClick={() => item && disconnect.mutate(item.id)}
            >
              {disconnect.isPending ? 'Disconnecting…' : 'Disconnect'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
