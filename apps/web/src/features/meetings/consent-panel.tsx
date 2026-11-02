import { useId, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Id } from '@meetops/contracts';
import { Badge, type BadgeProps } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { ErrorState, LoadingState } from '@/components/states/states';
import { ApiError } from '@/lib/api/client';
import { useApi } from '@/lib/api/context';
import { describeError } from '@/lib/api/error-messages';
import { useOrganizationId } from '@/lib/api/queries';
import { notify } from '@/lib/errors/notify';
import { useSession } from '@/features/session/use-session';
import {
  MAX_REVOCATION_REASON_LENGTH,
  MEETING_CONSENT_WRITE_ROLES,
  meetingConsentQueryKey,
  type MeetingConsentEvent,
  type MeetingConsentStatus,
} from './consent-api';

/** Mirrors the API rule: owner/admin/member may record or revoke; viewers get 403. UI hint only. */
export function useCanWriteMeetingConsent(): boolean {
  const { data } = useSession();
  const orgId = useOrganizationId();
  if (!data || data.activeOrganizationId !== orgId) return false;
  return MEETING_CONSENT_WRITE_ROLES.includes(data.role as never);
}

export function useMeetingConsent(meetingId: Id | undefined) {
  const api = useApi();
  const organizationId = useOrganizationId();
  return useQuery({
    queryKey: meetingConsentQueryKey(organizationId, meetingId ?? ''),
    queryFn: () => api.meetingConsent.status(organizationId, meetingId!),
    enabled: !!organizationId && !!meetingId,
    retry: false,
  });
}

type BadgeState = 'valid' | 'outdated' | 'revoked' | 'none';

function badgeState(s: MeetingConsentStatus): BadgeState {
  if (s.state === 'granted') return s.valid ? 'valid' : 'outdated';
  return s.state;
}

const BADGE: Record<BadgeState, { label: string; variant: NonNullable<BadgeProps['variant']> }> = {
  valid: { label: 'Consent recorded', variant: 'default' },
  outdated: { label: 'Consent outdated', variant: 'secondary' },
  revoked: { label: 'Consent revoked', variant: 'destructive' },
  none: { label: 'No consent', variant: 'outline' },
};

export function MeetingConsentBadge({ status }: { status: MeetingConsentStatus }) {
  const b = BADGE[badgeState(status)];
  return (
    <Badge variant={b.variant} data-testid="consent-status">
      {b.label}
    </Badge>
  );
}

const METHOD_TEXT: Record<string, string> = {
  all_parties_notified: 'everyone was told it was recorded',
  all_parties_consented: 'everyone agreed to be recorded',
};

function formatTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

function EventRow({ e }: { e: MeetingConsentEvent }) {
  const granted = e.eventType === 'granted';
  return (
    <li className="flex flex-col gap-0.5 border-b border-border py-2 last:border-0">
      <span className="text-sm font-medium">
        {granted ? 'Consent recorded' : 'Consent revoked'}
        {granted && e.method ? ` · ${METHOD_TEXT[e.method] ?? e.method}` : ''}
      </span>
      <span className="text-xs text-muted-foreground">
        <time dateTime={e.occurredAt}>{formatTime(e.occurredAt)}</time>
        {granted && e.consentVersion ? ` · notice ${e.consentVersion}` : ''}
      </span>
      {!granted && e.reason ? (
        <span className="whitespace-pre-line break-words text-sm">Reason: {e.reason}</span>
      ) : null}
    </li>
  );
}

export function RevokeConsentDialog({ meetingId }: { meetingId: Id }) {
  const api = useApi();
  const organizationId = useOrganizationId();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const ids = useId();
  const mutation = useMutation({
    mutationFn: () => {
      const r = reason.trim();
      return api.meetingConsent.revoke(organizationId, meetingId, r ? { reason: r } : {});
    },
    onSuccess: () => {
      setOpen(false);
      setReason('');
      notify.success('Consent revoked', 'New uploads and recordings need consent again.');
      return queryClient.invalidateQueries({
        queryKey: meetingConsentQueryKey(organizationId, meetingId),
      });
    },
    onError: (e) => notify.error("Couldn't revoke consent", describeError(e).message),
  });
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) mutation.reset();
      }}
    >
      <Button type="button" variant="outline" className="min-h-11" onClick={() => setOpen(true)}>
        Revoke consent
      </Button>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Revoke recording consent?</DialogTitle>
          <DialogDescription>
            New uploads and recordings for this meeting will need consent again. The history is
            kept: earlier consent stays on record and nothing is deleted.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            mutation.mutate();
          }}
        >
          <div className="space-y-2">
            <Label htmlFor={`${ids}-reason`}>Reason (optional)</Label>
            <Textarea
              id={`${ids}-reason`}
              value={reason}
              maxLength={MAX_REVOCATION_REASON_LENGTH}
              onChange={(e) => setReason(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              onClick={() => setOpen(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              variant="destructive"
              className="min-h-11"
              disabled={mutation.isPending}
            >
              Revoke consent
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Meeting page: consent status badge, history (newest first) and, for writers, Revoke. */
export function MeetingConsentPanel({ meetingId }: { meetingId: Id }) {
  const query = useMeetingConsent(meetingId);
  const canWrite = useCanWriteMeetingConsent();
  if (query.isError) {
    if (query.error instanceof ApiError && query.error.status === 404) return null;
    return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  }
  if (!query.data) return <LoadingState />;
  const s = query.data;
  return (
    <section aria-labelledby={`consent-${meetingId}`} className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h2 id={`consent-${meetingId}`} className="text-base font-semibold">
            Recording consent
          </h2>
          <MeetingConsentBadge status={s} />
        </div>
        {canWrite && s.state === 'granted' ? <RevokeConsentDialog meetingId={meetingId} /> : null}
      </div>
      {!canWrite ? (
        <p className="text-xs text-muted-foreground">
          Viewers can see consent but can’t record or revoke it.
        </p>
      ) : null}
      {s.events.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No consent recorded yet. Consent is recorded when you upload a recording.
        </p>
      ) : (
        <ol aria-label="Consent history" data-testid="consent-history">
          {s.events.map((e) => (
            <EventRow key={e.id} e={e} />
          ))}
        </ol>
      )}
    </section>
  );
}
