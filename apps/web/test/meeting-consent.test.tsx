import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Role } from '@meetops/contracts';
import { CURRENT_CONSENT_VERSION } from '@meetops/contracts/types';
import { ApiError } from '@/lib/api/client';
import { createMockApi, renderApp, resetStores } from './fixtures/render';
import {
  consentGranted,
  consentRevoked,
  consentStatusGranted,
  sessionResponse,
} from './fixtures/data';

const ORG = '00000000-0000-4000-8000-000000000001';
const MEETING = '20000000-0000-4000-8000-000000000001';
const PATH = `/meetings/${MEETING}`;

function setup(role: Role = 'owner', extra: Parameters<typeof createMockApi>[0] = {}) {
  const api = createMockApi({
    auth: { session: vi.fn().mockResolvedValue({ ...sessionResponse, role }) },
    ...extra,
  });
  return { ...renderApp(PATH, api), user: userEvent.setup() };
}

const mp3 = () => new File(['abc'], 'call.mp3', { type: 'audio/mpeg' });

describe('meeting consent panel', () => {
  beforeEach(() => resetStores());

  it('shows "No consent" with an empty history', async () => {
    setup();
    expect(await screen.findByTestId('consent-status')).toHaveTextContent('No consent');
    expect(screen.getByText(/No consent recorded yet/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Revoke consent' })).toBeNull();
  });

  it('shows a granted badge and the history newest first', async () => {
    setup('owner', {
      meetingConsent: {
        status: vi.fn().mockResolvedValue({
          ...consentStatusGranted,
          state: 'revoked',
          valid: false,
          latest: consentRevoked,
          events: [consentRevoked, consentGranted],
        }),
      },
    });
    expect(await screen.findByTestId('consent-status')).toHaveTextContent('Consent revoked');
    const items = within(screen.getByRole('list', { name: 'Consent history' })).getAllByRole(
      'listitem',
    );
    expect(items[0]).toHaveTextContent('Consent revoked');
    expect(items[0]).toHaveTextContent('Reason: Participant asked');
    expect(items[1]).toHaveTextContent('Consent recorded · everyone agreed to be recorded');
  });

  it('flags a grant for an older notice version as outdated', async () => {
    setup('owner', {
      meetingConsent: {
        status: vi.fn().mockResolvedValue({ ...consentStatusGranted, valid: false }),
      },
    });
    expect(await screen.findByTestId('consent-status')).toHaveTextContent('Consent outdated');
  });

  it('revokes only after confirming in the dialog, sending the trimmed reason', async () => {
    const status = vi.fn().mockResolvedValue(consentStatusGranted);
    const { api, user } = setup('member', { meetingConsent: { status } });
    expect(await screen.findByTestId('consent-status')).toHaveTextContent('Consent recorded');
    await user.click(screen.getByRole('button', { name: 'Revoke consent' }));
    const dialog = await screen.findByRole('dialog', { name: 'Revoke recording consent?' });
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(api.meetingConsent.revoke).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Revoke consent' }));
    const d2 = await screen.findByRole('dialog');
    await user.type(within(d2).getByLabelText('Reason (optional)'), '  Participant asked  ');
    await user.click(within(d2).getByRole('button', { name: 'Revoke consent' }));
    await waitFor(() =>
      expect(api.meetingConsent.revoke).toHaveBeenCalledWith(ORG, MEETING, {
        reason: 'Participant asked',
      }),
    );
    await waitFor(() => expect(status.mock.calls.length).toBeGreaterThan(1));
  });

  it('viewers see status and history but no revoke or upload actions', async () => {
    const { api } = setup('viewer', {
      meetingConsent: { status: vi.fn().mockResolvedValue(consentStatusGranted) },
    });
    expect(await screen.findByTestId('consent-status')).toHaveTextContent('Consent recorded');
    expect(screen.getByRole('list', { name: 'Consent history' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Revoke consent' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Upload recording' })).toBeDisabled();
    expect(screen.getByText(/Viewers can’t upload or record consent/)).toBeInTheDocument();
    expect(api.meetingConsent.record).not.toHaveBeenCalled();
  });
});

describe('upload dialog consent step', () => {
  beforeEach(() => resetStores());

  async function pick(user: ReturnType<typeof userEvent.setup>) {
    await screen.findByTestId('consent-status');
    await user.upload(screen.getByTestId('upload-input'), mp3());
    await screen.findByTestId('consent-notice');
  }

  it('never pre-ticks the box and records meeting consent before the upload starts', async () => {
    const { api, user } = setup();
    await pick(user);
    const box = screen.getByRole('checkbox', { name: /agreed to be recorded/ });
    expect(box).not.toBeChecked();
    expect(screen.getByRole('button', { name: 'Confirm and upload' })).toBeDisabled();
    expect(screen.getByTestId('meeting-consent-note')).toHaveTextContent(
      /records consent for this meeting before the upload starts/,
    );
    await user.click(box);
    await user.click(screen.getByRole('button', { name: 'Confirm and upload' }));
    await waitFor(() => expect(api.storage.createUpload).toHaveBeenCalled());
    expect(api.meetingConsent.record).toHaveBeenCalledWith(ORG, MEETING, {
      consentVersion: CURRENT_CONSENT_VERSION,
      attestedAt: expect.any(String),
      method: 'all_parties_consented',
    });
    const recordOrder = vi.mocked(api.meetingConsent.record).mock.invocationCallOrder[0]!;
    const uploadOrder = vi.mocked(api.storage.createUpload).mock.invocationCallOrder[0]!;
    expect(recordOrder).toBeLessThan(uploadOrder);
  });

  it('skips re-recording when a current grant is on record', async () => {
    const { api, user } = setup('owner', {
      meetingConsent: { status: vi.fn().mockResolvedValue(consentStatusGranted) },
    });
    await pick(user);
    expect(screen.getByTestId('meeting-consent-note')).toHaveTextContent(/already on record/);
    await user.click(screen.getByRole('checkbox', { name: /agreed to be recorded/ }));
    await user.click(screen.getByRole('button', { name: 'Confirm and upload' }));
    await waitFor(() => expect(api.storage.createUpload).toHaveBeenCalled());
    expect(api.meetingConsent.record).not.toHaveBeenCalled();
  });

  it('shows a clear inline error and unticks the box on a 422 CONSENT_REQUIRED', async () => {
    const err = new ApiError(422, 'VALIDATION_FAILED', 'consent');
    err.reason = 'CONSENT_REQUIRED';
    const { api, user } = setup('owner', {
      meetingConsent: { status: vi.fn().mockResolvedValue(consentStatusGranted) },
      storage: { createUpload: vi.fn().mockRejectedValue(err) },
    });
    await pick(user);
    await user.click(screen.getByRole('checkbox', { name: /agreed to be recorded/ }));
    await user.click(screen.getByRole('button', { name: 'Confirm and upload' }));
    expect(await screen.findByTestId('consent-error')).toHaveTextContent(
      'This meeting has no current recording consent. Tick the consent box and try again.',
    );
    expect(screen.getByRole('checkbox', { name: /agreed to be recorded/ })).not.toBeChecked();
    expect(api.storage.putToPresignedUrl).not.toHaveBeenCalled();
  });

  it('does not record consent when the status call failed; the upload init still carries it', async () => {
    const { api, user } = setup('owner', {
      meetingConsent: {
        status: vi.fn().mockRejectedValue(new ApiError(500, 'INTERNAL', 'boom')),
      },
    });
    await waitFor(() => expect(api.meetingConsent.status).toHaveBeenCalled());
    await user.upload(screen.getByTestId('upload-input'), mp3());
    await screen.findByTestId('consent-notice');
    await user.click(screen.getByRole('checkbox', { name: /agreed to be recorded/ }));
    await user.click(screen.getByRole('button', { name: 'Confirm and upload' }));
    await waitFor(() => expect(api.storage.createUpload).toHaveBeenCalled());
    expect(api.meetingConsent.record).not.toHaveBeenCalled();
    expect(vi.mocked(api.storage.createUpload).mock.calls[0]![1]).toMatchObject({
      consent: { consentVersion: CURRENT_CONSENT_VERSION },
    });
  });

  it('a 404 from missing consent routes does not block the upload (enforcement off)', async () => {
    const notFound = () => new ApiError(404, 'NOT_FOUND', 'no route');
    const { api, user } = setup('owner', {
      meetingConsent: {
        status: vi.fn().mockRejectedValue(notFound()),
        record: vi.fn().mockRejectedValue(notFound()),
      },
    });
    await waitFor(() => expect(api.meetingConsent.status).toHaveBeenCalled());
    await user.upload(screen.getByTestId('upload-input'), mp3());
    await screen.findByTestId('consent-notice');
    await user.click(screen.getByRole('checkbox', { name: /agreed to be recorded/ }));
    await user.click(screen.getByRole('button', { name: 'Confirm and upload' }));
    await waitFor(() => expect(api.storage.completeUpload).toHaveBeenCalled());
    expect(screen.queryByTestId('consent-error')).toBeNull();
  });

  it('a 404 from the record route alone does not block the upload either', async () => {
    const { api, user } = setup('owner', {
      meetingConsent: { record: vi.fn().mockRejectedValue(new ApiError(404, 'NOT_FOUND', 'x')) },
    });
    await pick(user);
    await user.click(screen.getByRole('checkbox', { name: /agreed to be recorded/ }));
    await user.click(screen.getByRole('button', { name: 'Confirm and upload' }));
    await waitFor(() => expect(api.storage.completeUpload).toHaveBeenCalled());
    expect(api.meetingConsent.record).toHaveBeenCalled();
  });

  it('stops before uploading when recording consent fails', async () => {
    const err = new ApiError(422, 'VALIDATION_FAILED', 'consent');
    err.reason = 'CONSENT_INVALID';
    const { api, user } = setup('owner', {
      meetingConsent: { record: vi.fn().mockRejectedValue(err) },
    });
    await pick(user);
    await user.click(screen.getByRole('checkbox', { name: /agreed to be recorded/ }));
    await user.click(screen.getByRole('button', { name: 'Confirm and upload' }));
    expect(await screen.findByTestId('consent-error')).toHaveTextContent(/device clock/);
    expect(api.storage.createUpload).not.toHaveBeenCalled();
  });
});
