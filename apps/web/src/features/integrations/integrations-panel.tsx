import { useId, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, GitBranch, Link2Off, SquareKanban } from 'lucide-react';
import type { IntegrationProvider } from '@meetops/contracts';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ErrorState, LoadingState } from '@/components/states/states';
import { ApiError } from '@/lib/api/client';
import { useApi } from '@/lib/api/context';
import { useOrganizationId } from '@/lib/api/queries';
import { notify, toastError } from '@/lib/errors/notify';
import { getIntegrationsApi, safeAuthorizeUrl, validateTarget, type IntegrationDto } from './api';

const META: Record<
  IntegrationProvider,
  { name: string; target: string; placeholder: string; blurb: string }
> = {
  github: {
    name: 'GitHub',
    target: 'Default repository',
    placeholder: 'owner/repo',
    blurb: 'File accepted meeting tasks as GitHub issues.',
  },
  jira: {
    name: 'Jira',
    target: 'Default project key',
    placeholder: 'OPS',
    blurb: 'File accepted meeting tasks as Jira issues.',
  },
};

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

/** Full-page redirect to the provider's OAuth screen; an object so tests can stub it. */
export const oauthRedirect = { assign: (url: string) => window.location.assign(url) };

export function IntegrationsPanel() {
  const navigate = (url: string) => oauthRedirect.assign(url);
  const { query } = useIntegrations();
  if (query.isError) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  if (!query.data) return <LoadingState />;
  return (
    <div className="grid gap-4 md:grid-cols-2">
      {query.data.items.map((i) => (
        <IntegrationCard key={i.provider} item={i} navigate={navigate} />
      ))}
    </div>
  );
}

function IntegrationCard({
  item,
  navigate,
}: {
  item: IntegrationDto;
  navigate: (url: string) => void;
}) {
  const { integrations, organizationId, key } = useIntegrations();
  const queryClient = useQueryClient();
  const meta = META[item.provider];
  const uid = useId();
  const [target, setTarget] = useState(item.defaultTarget ?? '');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const connected = item.status === 'connected';

  const connect = useMutation({
    mutationFn: () => integrations.connect(organizationId, item.provider),
    onSuccess: ({ authorizeUrl }) => {
      const url = safeAuthorizeUrl(authorizeUrl);
      if (!url) notify.error(`Couldn't connect ${meta.name}`, 'The sign-in link was not secure.');
      else navigate(url);
    },
    onError: (err) => toastError(err, { title: `Couldn't connect ${meta.name}` }),
  });
  const save = useMutation({
    mutationFn: (defaultTarget: string | null) =>
      integrations.update(organizationId, item.provider, { defaultTarget }),
    onSuccess: async () => {
      notify.success(`${meta.name} settings saved`);
      await queryClient.invalidateQueries({ queryKey: key });
    },
    onError: (err) => {
      if (
        err instanceof ApiError &&
        (err.status === 422 || err.status === 400) &&
        err.details.some((d) => d.path.startsWith('/defaultTarget'))
      )
        setFieldError(`Enter a valid ${meta.target.toLowerCase()}.`);
      else toastError(err, { title: `Couldn't save ${meta.name} settings` });
    },
  });
  const disconnect = useMutation({
    mutationFn: () => integrations.disconnect(organizationId, item.provider),
    onSuccess: async () => {
      notify.success(`${meta.name} disconnected`);
      setTarget('');
      await queryClient.invalidateQueries({ queryKey: key });
    },
    onError: (err) => toastError(err, { title: `Couldn't disconnect ${meta.name}` }),
  });

  const inputId = `${uid}-target`;
  return (
    <Card data-testid={`integration-${item.provider}`}>
      <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
        <div className="flex items-center gap-2">
          {item.provider === 'github' ? (
            <GitBranch aria-hidden className="size-5" />
          ) : (
            <SquareKanban aria-hidden className="size-5" />
          )}
          <CardTitle>
            <h2>{meta.name}</h2>
          </CardTitle>
        </div>
        <Badge
          variant={item.status === 'error' ? 'destructive' : connected ? 'default' : 'secondary'}
        >
          {item.status === 'error' ? 'Needs attention' : connected ? 'Connected' : 'Not connected'}
        </Badge>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <p className="text-muted-foreground">{meta.blurb}</p>
        {connected && item.accountLabel ? (
          <p>
            Connected to <span className="font-medium">{item.accountLabel}</span>
          </p>
        ) : null}
        {item.status === 'error' && item.lastError ? (
          <p className="text-destructive">{item.lastError}</p>
        ) : null}
        {connected ? (
          <form
            noValidate
            className="grid gap-1.5"
            onSubmit={(e) => {
              e.preventDefault();
              const err = validateTarget(item.provider, target);
              setFieldError(err);
              if (!err) save.mutate(target.trim() || null);
            }}
          >
            <Label htmlFor={inputId}>{meta.target}</Label>
            <div className="flex gap-2">
              <Input
                id={inputId}
                value={target}
                placeholder={meta.placeholder}
                maxLength={140}
                autoComplete="off"
                spellCheck={false}
                aria-invalid={fieldError ? true : undefined}
                aria-describedby={fieldError ? `${inputId}-error` : undefined}
                onChange={(e) => {
                  setTarget(e.target.value);
                  if (fieldError) setFieldError(null);
                }}
                className="h-11"
              />
              <Button className="min-h-11" type="submit" disabled={save.isPending}>
                {save.isPending ? 'Saving…' : 'Save'}
              </Button>
            </div>
            {fieldError ? (
              <p id={`${inputId}-error`} role="alert" className="text-destructive">
                {fieldError}
              </p>
            ) : null}
          </form>
        ) : null}
        <div className="flex gap-2">
          {connected ? (
            <Button
              className="min-h-11"
              type="button"
              variant="outline"
              disabled={disconnect.isPending}
              onClick={() => disconnect.mutate()}
            >
              <Link2Off aria-hidden />
              Disconnect
            </Button>
          ) : (
            <Button
              className="min-h-11"
              type="button"
              disabled={connect.isPending || !organizationId}
              onClick={() => connect.mutate()}
            >
              <ExternalLink aria-hidden />
              {item.status === 'error' ? `Reconnect ${meta.name}` : `Connect ${meta.name}`}
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
