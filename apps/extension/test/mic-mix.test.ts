import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MIC_CONSTRAINTS,
  MIC_UNAVAILABLE_MESSAGE,
  acquireMicStream,
  connectCaptureGraph,
  isTabCaptureConstraints,
  requestMicPermission,
  type MixAudioContext,
} from '../src/lib/mic-mix.js';

function fakeStream(id: string, tracks: { stop: () => void }[] = []): MediaStream {
  return { id, getTracks: () => tracks } as unknown as MediaStream;
}

function fakeCtx() {
  const connections: Array<[string, string]> = [];
  const nameOf = (dest: unknown) =>
    dest && typeof dest === 'object' && 'name' in dest
      ? String((dest as { name: string }).name)
      : 'unknown';
  const node = (name: string) => ({
    name,
    connect(dest: unknown) {
      connections.push([name, nameOf(dest)]);
    },
  });
  const mixStream = fakeStream('mix');
  const ctx: MixAudioContext & { connections: typeof connections; mixStream: MediaStream } = {
    connections,
    mixStream,
    destination: { name: 'speakers' } as unknown as MixAudioContext['destination'],
    createMediaStreamSource(stream: MediaStream) {
      return node((stream as { id: string }).id);
    },
    createMediaStreamDestination() {
      return { name: 'mix', stream: mixStream, connect() {} };
    },
  };
  return ctx;
}

describe('requestMicPermission (popup only)', () => {
  it('grants, uses echo/noise/gain constraints, and stops the preview tracks', async () => {
    const stop = vi.fn();
    const getUserMedia = vi.fn(async (c: MediaStreamConstraints) => {
      expect(c).toEqual({ audio: MIC_CONSTRAINTS, video: false });
      expect(MIC_CONSTRAINTS).toEqual({
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      });
      return fakeStream('mic', [{ stop }]);
    });
    await expect(requestMicPermission(getUserMedia)).resolves.toBe('granted');
    expect(stop).toHaveBeenCalledOnce();
  });

  it('returns denied when getUserMedia rejects, and does not throw', async () => {
    const getUserMedia = vi.fn(async () => {
      throw new DOMException('Permission denied', 'NotAllowedError');
    });
    await expect(requestMicPermission(getUserMedia)).resolves.toBe('denied');
  });
});

describe('acquireMicStream (offscreen, after a popup grant)', () => {
  it('returns the stream when permission already stuck', async () => {
    const stream = fakeStream('mic');
    const getUserMedia = vi.fn(async () => stream);
    await expect(acquireMicStream(getUserMedia)).resolves.toBe(stream);
  });

  it('returns null when the mic is unavailable so recording can fall back to tab-only', async () => {
    const getUserMedia = vi.fn(async () => {
      throw new Error('NotFoundError');
    });
    await expect(acquireMicStream(getUserMedia)).resolves.toBeNull();
  });
});

describe('connectCaptureGraph', () => {
  it('loops tab audio to the speakers and records the tab+mic mix', () => {
    const ctx = fakeCtx();
    const tab = fakeStream('tab');
    const mic = fakeStream('mic');
    const graph = connectCaptureGraph(ctx, tab, mic);
    expect(graph.micMixed).toBe(true);
    expect(graph.recorded).toBe(ctx.mixStream);
    expect(ctx.connections).toEqual([
      ['tab', 'speakers'],
      ['tab', 'mix'],
      ['mic', 'mix'],
    ]);
    expect(ctx.connections).not.toContainEqual(['mic', 'speakers']);
  });

  it('records tab-only when the mic is missing, still looping the tab to the speakers', () => {
    const ctx = fakeCtx();
    const tab = fakeStream('tab');
    const graph = connectCaptureGraph(ctx, tab, null);
    expect(graph.micMixed).toBe(false);
    expect(ctx.connections).toEqual([
      ['tab', 'speakers'],
      ['tab', 'mix'],
    ]);
  });

  it('stops tab and mic input tracks on teardown', () => {
    const tabStop = vi.fn();
    const micStop = vi.fn();
    const ctx = fakeCtx();
    const graph = connectCaptureGraph(
      ctx,
      fakeStream('tab', [{ stop: tabStop }]),
      fakeStream('mic', [{ stop: micStop }]),
    );
    graph.stopInputTracks();
    expect(tabStop).toHaveBeenCalledOnce();
    expect(micStop).toHaveBeenCalledOnce();
  });
});

describe('offscreen must not be the first mic prompt', () => {
  it('does not import requestMicPermission from the offscreen entry', () => {
    const offscreen = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), '../entrypoints/offscreen/main.ts'),
      'utf8',
    );
    expect(offscreen).not.toMatch(/requestMicPermission/);
    expect(offscreen).toMatch(/acquireMicStream/);
    expect(offscreen).toMatch(/includeMic/);
    // Tab capture stays a chromeMediaSource: 'tab' getUserMedia; mic is added only when includeMic is set.
    expect(offscreen).toMatch(/chromeMediaSource: 'tab'/);
  });

  it('recognises tab-capture constraints so tests can tell them apart from a mic prompt', () => {
    expect(
      isTabCaptureConstraints({
        audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: 'id' } },
        video: false,
      } as unknown as MediaStreamConstraints),
    ).toBe(true);
    expect(isTabCaptureConstraints({ audio: MIC_CONSTRAINTS, video: false })).toBe(false);
    expect(isTabCaptureConstraints({ audio: true })).toBe(false);
  });

  it('documents the visible fallback copy', () => {
    expect(MIC_UNAVAILABLE_MESSAGE).toBe("Your microphone isn't being recorded");
  });
});
