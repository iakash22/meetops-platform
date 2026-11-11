import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Role } from '@meetops/contracts';
import { ApiError } from '@/lib/api/client';
import { diffConsentSettings, validateDraft } from '@/features/settings/consent-settings-panel';
import { safeDownloadName } from '@/features/uploads/download-link';
import { createMockApi, renderApp, resetStores } from './fixtures/render';
import { consentSettings, sessionResponse } from './fixtures/data';

function setup(
  path: string,
  role: Role = 'owner',
  extra: Parameters<typeof createMockApi>[0] = {},
) {
  const api = createMockApi({
    auth: { session: vi.fn().mockResolvedValue({ ...sessionResponse, role }) },
    ...extra,
  });
  return { ...renderApp(path, api), user: userEvent.setup() };
}

describe('/settings?tab=consent', () => {
  beforeEach(() => resetStores());

  it.each(['owner', 'admin'] as const)(
    '%s sees the tab and can save a partial PATCH',
    async (role) => {
      const { api, user } = setup('/settings?tab=consent', role);
      const days = await screen.findByLabelText('Retention (days)');
      expect(screen.getByRole('link', { name: 'Consent' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
      await user.clear(days);
      await user.type(days, '30');
      await user.click(screen.getByRole('radio', { name: /One-party/ }));
      await user.click(screen.getByRole('button', { name: 'Save changes' }));
      expect(await screen.findByText('Saved')).toBeInTheDocument();
      expect(api.consentSettings.update).toHaveBeenCalledWith(
        '00000000-0000-4000-8000-000000000001',
        {
          mode: 'all_parties_notified',
          retentionDays: 30,
        },
      );
    },
  );

  it.each(['member', 'viewer'] as const)('%s never sees or loads it', async (role) => {
    const { api } = setup('/settings?tab=consent', role);
    expect(await screen.findByRole('link', { name: 'Employees' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Consent' })).toBeNull();
    expect(screen.queryByLabelText('Retention (days)')).toBeNull();
    expect(api.consentSettings.get).not.toHaveBeenCalled();
  });

  it('validates retention range and blocks the PATCH', async () => {
    const { api, user } = setup('/settings?tab=consent');
    const days = await screen.findByLabelText('Retention (days)');
    await user.clear(days);
    await user.type(days, '4000');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(screen.getByText(/from 7 to 365/)).toBeInTheDocument();
    expect(days).toHaveAttribute('aria-invalid', 'true');
    expect(api.consentSettings.update).not.toHaveBeenCalled();
  });

  it('shows a fixed message on 403', async () => {
    const { user } = setup('/settings?tab=consent', 'admin', {
      consentSettings: {
        update: vi.fn().mockRejectedValue(new ApiError(403, 'FORBIDDEN', 'secret')),
      },
    });
    await user.click(await screen.findByLabelText(/Don.t record external participants/));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByRole('alert')).toHaveTextContent("You don't have permission");
    expect(screen.queryByText('secret')).toBeNull();
  });
});

describe('consent helpers', () => {
  const draft = { ...consentSettings, retentionDays: '365' };
  it('diff sends only changed fields', () => {
    expect(diffConsentSettings(consentSettings, draft)).toEqual({});
    expect(diffConsentSettings(consentSettings, { ...draft, noticeText: ' New ' })).toEqual({
      noticeText: 'New',
    });
  });
  it('validate', () => {
    expect(validateDraft(draft)).toEqual({});
    expect(validateDraft({ ...draft, noticeText: '  ' }).noticeText).toBeDefined();
    expect(validateDraft({ ...draft, noticeText: 'x'.repeat(4001) }).noticeText).toBeDefined();
    expect(validateDraft({ ...draft, retentionDays: '0' }).retentionDays).toBeDefined();
    expect(validateDraft({ ...draft, retentionDays: '1.5' }).retentionDays).toBeDefined();
  });
  it('safeDownloadName strips path and control characters', () => {
    expect(safeDownloadName('../../etc/passwd')).toBe('_.._etc_passwd');
    expect(safeDownloadName('a<b>"c".webm')).toBe('a_b_c_.webm');
    expect(safeDownloadName('\u0000')).toBe('_');
    expect(safeDownloadName('')).toBe('download');
  });
});
