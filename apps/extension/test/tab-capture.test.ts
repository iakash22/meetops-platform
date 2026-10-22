import { afterEach, describe, expect, it, vi } from 'vitest';
import { getTabStreamId } from '../src/lib/tab-capture.js';

afterEach(() => vi.unstubAllGlobals());

describe('getTabStreamId', () => {
  it('uses the promise form of tabCapture.getMediaStreamId with targetTabId', async () => {
    const getMediaStreamId = vi.fn(async () => 'stream-123');
    vi.stubGlobal('chrome', { tabCapture: { getMediaStreamId } });
    await expect(getTabStreamId(42)).resolves.toBe('stream-123');
    expect(getMediaStreamId).toHaveBeenCalledWith({ targetTabId: 42 });
    expect(getMediaStreamId.mock.calls[0]).toHaveLength(1);
  });

  it('propagates rejections and rejects empty ids', async () => {
    vi.stubGlobal('chrome', {
      tabCapture: { getMediaStreamId: vi.fn(async () => Promise.reject(new Error('no gesture'))) },
    });
    await expect(getTabStreamId(1)).rejects.toThrow('no gesture');
    vi.stubGlobal('chrome', { tabCapture: { getMediaStreamId: vi.fn(async () => '') } });
    await expect(getTabStreamId(1)).rejects.toThrow('no stream id');
  });
});
