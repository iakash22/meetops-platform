import { useEffect, useId, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { ErrorState, LoadingState } from '@/components/states/states';
import { describeError } from '@/lib/api/error-messages';
import { useApi } from '@/lib/api/context';
import { useOrganizationId } from '@/lib/api/queries';
export { useCanManageConsentSettings } from './consent-gate';
import { consentSettingsQueryKey } from '@/features/uploads/consent-queries';
import {
  MAX_CONSENT_NOTICE_TEXT_LENGTH,
  MAX_RETENTION_DAYS,
  MIN_RETENTION_DAYS,
  type ConsentSettings,
  type ConsentSettingsMode,
  type UpdateConsentSettingsRequest,
} from '@/features/uploads/types';

type Draft = Pick<ConsentSettings, 'mode' | 'noticeText' | 'skipExternalParticipants'> & {
  retentionDays: string;
};

/** Only the changed fields (PATCH is partial, min one field). */
export function diffConsentSettings(base: ConsentSettings, d: Draft): UpdateConsentSettingsRequest {
  const out: UpdateConsentSettingsRequest = {};
  if (d.mode !== base.mode) out.mode = d.mode;
  if (d.noticeText.trim() !== base.noticeText) out.noticeText = d.noticeText.trim();
  if (d.skipExternalParticipants !== base.skipExternalParticipants)
    out.skipExternalParticipants = d.skipExternalParticipants;
  const days = Number(d.retentionDays);
  if (days !== base.retentionDays) out.retentionDays = days;
  return out;
}

export function validateDraft(d: Draft): Partial<Record<'noticeText' | 'retentionDays', string>> {
  const errs: Partial<Record<'noticeText' | 'retentionDays', string>> = {};
  const t = d.noticeText.trim();
  if (!t) errs.noticeText = 'Enter the notice participants see.';
  else if (t.length > MAX_CONSENT_NOTICE_TEXT_LENGTH)
    errs.noticeText = `Keep the notice under ${MAX_CONSENT_NOTICE_TEXT_LENGTH} characters.`;
  const n = Number(d.retentionDays);
  if (!/^\d+$/.test(d.retentionDays) || n < MIN_RETENTION_DAYS || n > MAX_RETENTION_DAYS)
    errs.retentionDays = `Enter a whole number of days from ${MIN_RETENTION_DAYS} to ${MAX_RETENTION_DAYS}.`;
  return errs;
}

const MODES: Array<{ value: ConsentSettingsMode; label: string; hint: string }> = [
  {
    value: 'all_parties_consented',
    label: 'Require explicit consent',
    hint: 'Every participant must explicitly agree to be recorded.',
  },
  {
    value: 'all_parties_notified',
    label: 'Notice only',
    hint: 'A visible recording notice is enough; participants are not asked to opt in.',
  },
];

/** Org consent / retention settings. Rendered only for owner/admin (see SettingsPage). */
export function ConsentSettingsPanel() {
  const api = useApi();
  const organizationId = useOrganizationId();
  const queryClient = useQueryClient();
  const id = useId();
  const key = consentSettingsQueryKey(organizationId);
  const q = useQuery({ queryKey: key, queryFn: () => api.consentSettings.get(organizationId) });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    if (q.data) setDraft({ ...q.data, retentionDays: String(q.data.retentionDays) });
  }, [q.data]);

  const save = useMutation({
    mutationFn: (body: UpdateConsentSettingsRequest) =>
      api.consentSettings.update(organizationId, body),
    onSuccess: (data) => queryClient.setQueryData(key, data),
  });

  if (q.isPending) return <LoadingState label="Loading consent settings…" />;
  if (q.isError) return <ErrorState title="Couldn't load consent settings" error={q.error} />;
  if (!draft) return null;

  const errs = touched ? validateDraft(draft) : {};
  const changes = diffConsentSettings(q.data, draft);
  const dirty = Object.keys(changes).length > 0;

  return (
    <form
      aria-labelledby={`${id}-h`}
      noValidate
      className="max-w-2xl space-y-6"
      onSubmit={(e) => {
        e.preventDefault();
        setTouched(true);
        if (Object.keys(validateDraft(draft)).length === 0 && dirty) save.mutate(changes);
      }}
    >
      <div>
        <h2 id={`${id}-h`} className="text-lg font-semibold">
          Recording consent
        </h2>
        <p className="text-sm text-muted-foreground">
          Notice version {q.data.currentConsentVersion} · last updated{' '}
          <time dateTime={q.data.updatedAt}>{new Date(q.data.updatedAt).toLocaleString()}</time>
        </p>
      </div>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Consent mode</legend>
        {MODES.map((m) => (
          <label key={m.value} className="flex min-h-11 cursor-pointer items-start gap-3 text-sm">
            <input
              type="radio"
              name={`${id}-mode`}
              value={m.value}
              checked={draft.mode === m.value}
              onChange={() => setDraft({ ...draft, mode: m.value })}
              className="mt-0.5 size-5 accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
            <span>
              {m.label}
              <span className="block text-muted-foreground">{m.hint}</span>
            </span>
          </label>
        ))}
      </fieldset>

      <div className="space-y-2">
        <Label htmlFor={`${id}-notice`}>Notice shown to participants</Label>
        <Textarea
          id={`${id}-notice`}
          rows={5}
          maxLength={MAX_CONSENT_NOTICE_TEXT_LENGTH}
          value={draft.noticeText}
          aria-invalid={!!errs.noticeText}
          aria-describedby={`${id}-notice-hint${errs.noticeText ? ` ${id}-notice-err` : ''}`}
          onChange={(e) => setDraft({ ...draft, noticeText: e.target.value })}
        />
        <p id={`${id}-notice-hint`} className="text-xs text-muted-foreground">
          {draft.noticeText.length}/{MAX_CONSENT_NOTICE_TEXT_LENGTH} characters. Changing it may
          issue a new notice version.
        </p>
        {errs.noticeText ? (
          <p id={`${id}-notice-err`} className="text-sm text-destructive">
            {errs.noticeText}
          </p>
        ) : null}
      </div>

      <label className="flex min-h-11 cursor-pointer items-center gap-3 text-sm">
        <input
          type="checkbox"
          checked={draft.skipExternalParticipants}
          onChange={(e) => setDraft({ ...draft, skipExternalParticipants: e.target.checked })}
          className="size-5 accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        Don&apos;t record external participants
      </label>

      <div className="space-y-2">
        <Label htmlFor={`${id}-days`}>Retention (days)</Label>
        <Input
          id={`${id}-days`}
          inputMode="numeric"
          className="min-h-11 w-40"
          value={draft.retentionDays}
          aria-invalid={!!errs.retentionDays}
          aria-describedby={errs.retentionDays ? `${id}-days-err` : undefined}
          onChange={(e) => setDraft({ ...draft, retentionDays: e.target.value })}
        />
        {errs.retentionDays ? (
          <p id={`${id}-days-err`} className="text-sm text-destructive">
            {errs.retentionDays}
          </p>
        ) : null}
      </div>

      <div className="flex items-center gap-3">
        <Button type="submit" className="min-h-11" disabled={!dirty || save.isPending}>
          {save.isPending ? 'Saving…' : 'Save changes'}
        </Button>
        <p role="status" className="text-sm">
          {save.isSuccess && !dirty ? 'Saved' : ''}
        </p>
      </div>
      {save.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {describeError(save.error).message}
        </p>
      ) : null}
    </form>
  );
}
