import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/lib/api/client';
import { validateUploadFile } from '@/features/meetings/upload-button';
import { meeting1, uploadResponse } from './fixtures/data';
import { createMockApi, renderApp, resetStores } from './fixtures/render';

describe('meetings', () => {
  beforeEach(() => resetStores());

  it('lists meetings with status and links to detail', async () => {
    const { history } = renderApp('/meetings');
    expect(await screen.findByText('Weekly sync')).toBeInTheDocument();
    expect(screen.getByText('Recording')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('link', { name: 'Weekly sync' }));
    await waitFor(() =>
      expect(history.location.pathname).toBe('/meetings/20000000-0000-4000-8000-000000000001'),
    );
  });

  it('shows the detail page with status, summary and transcript placeholders', async () => {
    const { api } = renderApp('/meetings/20000000-0000-4000-8000-000000000001');
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
    renderApp(
      '/meetings/nope',
      createMockApi({
        meetings: { get: vi.fn().mockRejectedValue(new ApiError(404, 'NOT_FOUND', 'x', 'req_7')) },
      }),
    );
    expect(await screen.findByTestId('error-state')).toHaveTextContent('req_7');
  });

  it('uploads: createUpload then PUT to the presigned url', async () => {
    const { api } = renderApp('/meetings/20000000-0000-4000-8000-000000000001');
    await screen.findByRole('heading', { name: 'Weekly sync' });
    const file = new File(['abc'], 'rec.webm', { type: 'audio/webm' });
    await userEvent.upload(screen.getByTestId('upload-input'), file);
    expect(await screen.findByText('Upload complete')).toBeInTheDocument();
    expect(api.storage.createUpload).toHaveBeenCalledWith('00000000-0000-4000-8000-000000000001', {
      filename: 'rec.webm',
      mimeType: 'audio/webm',
      sizeBytes: 3,
      meetingId: meeting1.id,
    });
    expect(api.storage.putToPresignedUrl).toHaveBeenCalledWith(uploadResponse.upload, file);
  });

  it('rejects non audio/video files before requesting an upload url', async () => {
    const { api } = renderApp('/meetings');
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
    await screen.findByText('Weekly sync');
    await userEvent.upload(
      screen.getByTestId('upload-input'),
      new File(['a'], 'a.mp4', { type: 'video/mp4' }),
    );
    expect(await screen.findByText('Upload failed')).toBeInTheDocument();
  });

  it('validateUploadFile enforces type and size', () => {
    expect(validateUploadFile(new File(['a'], 'a.mp3', { type: 'audio/mpeg' }))).toBeNull();
    expect(validateUploadFile(new File([], 'a.mp3', { type: 'audio/mpeg' }))).toMatch(/empty/);
    expect(validateUploadFile(new File(['a'], 'a.txt', { type: 'text/plain' }))).toMatch(/audio/);
  });
});
