import { act, screen, waitFor } from '@testing-library/react';
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

  it('uploads: createUpload then PUT to the presigned url', async () => {
    const { api } = renderApp('/meetings/20000000-0000-4000-8000-000000000001');
    await waitForRouteData(api.meetings.get);
    await screen.findByRole('heading', { name: 'Weekly sync' });
    const file = new File(['abc'], 'rec.webm', { type: 'audio/webm' });
    await userEvent.upload(screen.getByTestId('upload-input'), file);
    // Consent is required (contracts 0.4.1): submitting without a choice shows an inline error.
    await userEvent.click(screen.getByRole('button', { name: 'Start upload' }));
    expect(
      screen.getByText('Confirm how everyone was told about the recording.'),
    ).toBeInTheDocument();
    expect(api.storage.createUpload).not.toHaveBeenCalled();
    await userEvent.click(screen.getByLabelText(/agreed to be recorded/));
    await userEvent.click(screen.getByRole('button', { name: 'Start upload' }));
    expect(await screen.findByText('Upload complete')).toBeInTheDocument();
    expect(api.storage.createUpload).toHaveBeenCalledWith('00000000-0000-4000-8000-000000000001', {
      filename: 'rec.webm',
      mimeType: 'audio/webm',
      sizeBytes: 3,
      checksumSha256: 'ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=', // sha256('abc')
      meetingId: meeting1.id,
      consent: {
        consentVersion: '2026-10',
        attestedAt: expect.any(String) as string,
        method: 'all_parties_consented',
      },
    });
    expect(api.storage.putToPresignedUrl).toHaveBeenCalledWith(
      uploadResponse.upload,
      file,
      expect.objectContaining({ signal: expect.any(AbortSignal) as AbortSignal }),
    );
  });

  it('shows progress and cancels an in-flight upload', async () => {
    let seen: { onProgress?: (f: number) => void; signal?: AbortSignal } = {};
    const api = createMockApi({
      storage: {
        putToPresignedUrl: vi.fn(
          (_u: unknown, _f: unknown, opts: typeof seen) =>
            new Promise<void>((_res, rej) => {
              seen = opts;
              opts.signal?.addEventListener('abort', () =>
                rej(new DOMException('Upload cancelled', 'AbortError')),
              );
            }),
        ),
      },
    });
    renderApp('/meetings', api);
    await waitForRouteData(api.meetings.list, { heading: 'Meetings' });
    await screen.findByText('Weekly sync');
    await userEvent.upload(
      screen.getByTestId('upload-input'),
      new File(['a'], 'a.mp4', { type: 'video/mp4' }),
    );
    await userEvent.click(screen.getByLabelText(/was told it is recorded/));
    await userEvent.click(screen.getByRole('button', { name: 'Start upload' }));
    const bar = await screen.findByRole('progressbar', { name: 'Upload progress' });
    await waitFor(() => expect(seen.onProgress).toBeDefined());
    act(() => seen.onProgress?.(0.42));
    expect(bar).toHaveAttribute('aria-valuenow', '42');
    await userEvent.click(screen.getByRole('button', { name: 'Cancel upload' }));
    expect(await screen.findByText('Upload cancelled')).toBeInTheDocument();
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });

  it('rejects non audio/video files before requesting an upload url', async () => {
    const { api } = renderApp('/meetings');
    await waitForRouteData(api.meetings.list, { heading: 'Meetings' });
    await screen.findByText('Weekly sync');
    const input = screen.getByTestId('upload-input');
    await userEvent.upload(input, new File(['x'], 'evil.html', { type: 'text/html' }), {
      applyAccept: false,
    });
    expect(
      await screen.findByText('Only audio or video files can be uploaded.'),
    ).toBeInTheDocument();
    expect(api.storage.createUpload).not.toHaveBeenCalled();
  });

  it('shows an error when the PUT fails', async () => {
    const api = createMockApi({
      storage: { putToPresignedUrl: vi.fn().mockRejectedValue(new ApiError(403, 'UNKNOWN', 'x')) },
    });
    renderApp('/meetings', api);
    await waitForRouteData(api.meetings.list, { heading: 'Meetings' });
    await screen.findByText('Weekly sync');
    await userEvent.upload(
      screen.getByTestId('upload-input'),
      new File(['a'], 'a.mp4', { type: 'video/mp4' }),
    );
    await userEvent.click(screen.getByLabelText(/was told it is recorded/));
    await userEvent.click(screen.getByRole('button', { name: 'Start upload' }));
    expect(await screen.findByText('Upload failed')).toBeInTheDocument();
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
