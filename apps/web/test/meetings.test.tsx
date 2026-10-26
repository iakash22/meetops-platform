import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/lib/api/client';
import { MAX_UPLOAD_BYTES, validateUploadFile } from '@/features/meetings/upload-button';
import { meeting1, uploadResponse } from './fixtures/data';
import { createMockApi, renderApp, resetStores } from './fixtures/render';
import { waitForRouteData } from './fixtures/route-ready';

describe('meetings', () => {
  beforeEach(() => resetStores());

  it('lists meetings with status and links to detail', async () => {
    const { history, api } = renderApp('/meetings');
    await waitForRouteData(api.meetings.list, { heading: 'Meetings' });
    expect(await screen.findByText('Weekly sync')).toBeInTheDocument();
    expect(screen.getByText('Recording')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('link', { name: 'Weekly sync' }));
    await waitFor(() =>
      expect(history.location.pathname).toBe('/meetings/20000000-0000-4000-8000-000000000001'),
    );
  });

  it('shows the detail page with status, summary and transcript placeholders', async () => {
    const { api } = renderApp('/meetings/20000000-0000-4000-8000-000000000001');
    await waitForRouteData(api.meetings.get);
    expect(await screen.findByRole('heading', { name: 'Weekly sync' })).toBeInTheDocument();
    expect(api.meetings.get).toHaveBeenCalledWith(
      '00000000-0000-4000-8000-000000000001',
      '20000000-0000-4000-8000-000000000001',
    );
    expect(screen.getByTestId('meeting-status')).toHaveTextContent('Completed');
    expect(screen.getByRole('heading', { name: 'Summary' })).toBeInTheDocument();
    expect(screen.getByText('Summary not available yet')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Transcript' })).toBeInTheDocument();
    expect(screen.getByText('Transcript not available yet')).toBeInTheDocument();
  });

  it('shows an error state when the meeting is not found', async () => {
    const { api } = renderApp(
      '/meetings/nope',
      createMockApi({
        meetings: { get: vi.fn().mockRejectedValue(new ApiError(404, 'NOT_FOUND', 'x', 'req_7')) },
      }),
    );
    await waitForRouteData(api.meetings.get);
    expect(await screen.findByTestId('error-state')).toHaveTextContent('req_7');
  });

  async function pickAndConsent(file: File) {
    await userEvent.upload(screen.getByTestId('upload-input'), file);
    expect(await screen.findByTestId('consent-notice')).toHaveTextContent(
      'This meeting is recorded.',
    );
    const confirm = screen.getByRole('button', { name: 'Confirm and upload' });
    expect(confirm).toBeDisabled();
    await userEvent.click(screen.getByRole('checkbox', { name: /agreed to be recorded/ }));
    await userEvent.click(confirm);
  }

  it('uploads: consent → initUpload → PUT with progress → complete → pending badge', async () => {
    const { api } = renderApp('/meetings/20000000-0000-4000-8000-000000000001');
    await waitForRouteData(api.meetings.get);
    await screen.findByRole('heading', { name: 'Weekly sync' });
    const file = new File(['abc'], 'rec.webm', { type: 'audio/webm' });
    await pickAndConsent(file);
    expect(await screen.findByText('Upload complete')).toBeInTheDocument();
    expect(api.storage.initUpload).toHaveBeenCalledWith('00000000-0000-4000-8000-000000000001', {
      filename: 'rec.webm',
      mimeType: 'audio/webm',
      sizeBytes: 3,
      checksumSha256: 'ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=', // sha256('abc')
      meetingId: meeting1.id,
      consent: {
        consentVersion: '2026-10',
        attestedAt: expect.any(String),
        method: 'all_parties_consented',
      },
    });
    expect(api.storage.putToPresignedUrl).toHaveBeenCalledWith(
      uploadResponse.upload,
      file,
      expect.any(Function),
      expect.any(AbortSignal),
    );
    expect(api.storage.completeUpload).toHaveBeenCalledWith(
      '00000000-0000-4000-8000-000000000001',
      'fo_1',
    );
    expect(screen.getByTestId('scan-status')).toHaveAttribute('data-status', 'pending');
  });

  it('download after complete: 404 (not yet clean) shows processing, not an error', async () => {
    const api = createMockApi({
      storage: { getDownloadUrl: vi.fn().mockRejectedValue(new ApiError(404, 'NOT_FOUND', 'x')) },
    });
    renderApp('/meetings', api);
    await waitForRouteData(api.meetings.list, { heading: 'Meetings' });
    await screen.findByText('Weekly sync');
    await pickAndConsent(new File(['a'], 'a.mp4', { type: 'video/mp4' }));
    await userEvent.click(await screen.findByRole('button', { name: /Download/ }));
    expect(await screen.findByText(/Still processing/)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it.each([
    [new ApiError(409, 'CONFLICT', 'x'), /exceed the 1.4 GB total/],
    [new ApiError(413, 'BAD_REQUEST', 'x'), /exceed the 1.4 GB total/],
    [new ApiError(413, 'PAYLOAD_TOO_LARGE', 'x'), /exceed the 1.4 GB total/],
    [
      Object.assign(new ApiError(422, 'VALIDATION_FAILED', 'x'), {
        reason: 'CONSENT_VERSION_UNSUPPORTED',
      }),
      /consent notice has changed/,
    ],
  ])('maps init failure %#', async (err, text) => {
    const api = createMockApi({ storage: { initUpload: vi.fn().mockRejectedValue(err) } });
    renderApp('/meetings', api);
    await waitForRouteData(api.meetings.list, { heading: 'Meetings' });
    await screen.findByText('Weekly sync');
    await pickAndConsent(new File(['a'], 'a.mp4', { type: 'video/mp4' }));
    expect(await screen.findByText(text)).toBeInTheDocument();
    expect(api.storage.putToPresignedUrl).not.toHaveBeenCalled();
  });

  it('rejects non audio/video files before requesting an upload url', async () => {
    const api = createMockApi();
    renderApp('/meetings', api);
    await waitForRouteData(api.meetings.list, { heading: 'Meetings' });
    const input = screen.getByTestId('upload-input');
    await userEvent.upload(input, new File(['x'], 'evil.html', { type: 'text/html' }), {
      applyAccept: false,
    });
    expect(await screen.findByText(/Only audio or video files/)).toBeInTheDocument();
    expect(api.storage.initUpload).not.toHaveBeenCalled();
  });

  it('shows an error when the PUT fails', async () => {
    const api = createMockApi({
      storage: { putToPresignedUrl: vi.fn().mockRejectedValue(new ApiError(403, 'UNKNOWN', 'x')) },
    });
    renderApp('/meetings', api);
    await waitForRouteData(api.meetings.list, { heading: 'Meetings' });
    await screen.findByText('Weekly sync');
    await pickAndConsent(new File(['a'], 'a.mp4', { type: 'video/mp4' }));
    expect(await screen.findByText('Upload failed')).toBeInTheDocument();
    expect(api.storage.completeUpload).not.toHaveBeenCalled();
  });

  it('upload cap matches the backend 1.4 GB (1_400_000_000 bytes)', () => {
    expect(MAX_UPLOAD_BYTES).toBe(1_400_000_000);
    const sized = (n: number) => {
      const f = new File(['a'], 'a.mp4', { type: 'video/mp4' });
      Object.defineProperty(f, 'size', { value: n });
      return f;
    };
    expect(validateUploadFile(sized(1_400_000_000))).toBeNull();
    expect(validateUploadFile(sized(1_400_000_001))).toBe('The file is larger than 1.4 GB.');
    expect(validateUploadFile(sized(5 * 1024 ** 3))).toBe('The file is larger than 1.4 GB.');
  });

  it('validateUploadFile enforces type and size', () => {
    expect(validateUploadFile(new File(['a'], 'a.mp3', { type: 'audio/mpeg' }))).toBeNull();
    expect(validateUploadFile(new File([], 'a.mp3', { type: 'audio/mpeg' }))).toMatch(/empty/);
    expect(validateUploadFile(new File(['a'], 'a.txt', { type: 'text/plain' }))).toMatch(/audio/);
  });
});
