import { ApiError } from '../src/api/client';
import {
  createNetInfoStatus,
  isOnlineState,
  loadNetInfo,
  type NetInfoStateLike,
} from '../src/upload/netInfoStatus';
import type { ChunkSource, QueueItem, RecordingUploadApi } from '../src/upload/types';
import { createUploadQueueEngine } from '../src/upload/uploadQueueEngine';
import { startUploadScheduler } from '../src/upload/uploadScheduler';

// NetInfo mock: tests push connectivity states through `emit`.
const mockNetInfoListeners = new Set<(s: NetInfoStateLike) => void>();
const mockUnsubscribed = jest.fn();
jest.mock('@react-native-community/netinfo', () => ({
  __esModule: true,
  default: {
    addEventListener: (l: (s: NetInfoStateLike) => void) => {
      mockNetInfoListeners.add(l);
      return () => {
        mockUnsubscribed();
        mockNetInfoListeners.delete(l);
      };
    },
  },
}));
const emit = (s: NetInfoStateLike) => mockNetInfoListeners.forEach((l) => l(s));
const OFFLINE = { isConnected: false, isInternetReachable: false };
const ONLINE = { isConnected: true, isInternetReachable: true };

beforeEach(() => mockNetInfoListeners.clear());

describe('NetInfo network status', () => {
  it('maps NetInfo states: unknown reachability counts as online, confirmed unreachable as offline', () => {
    expect(isOnlineState(ONLINE)).toBe(true);
    expect(isOnlineState({ isConnected: true, isInternetReachable: null })).toBe(true);
    expect(isOnlineState({ isConnected: null })).toBe(true);
    expect(isOnlineState({ isConnected: true, isInternetReachable: false })).toBe(false);
    expect(isOnlineState(OFFLINE)).toBe(false);
  });

  it('tracks the mocked NetInfo module and notifies on changes only', () => {
    const status = createNetInfoStatus(loadNetInfo());
    const changes: boolean[] = [];
    status.onChange((o) => changes.push(o));
    expect(status.isOnline()).toBe(true);
    emit(OFFLINE);
    emit(OFFLINE);
    expect(status.isOnline()).toBe(false);
    emit({ isConnected: true, isInternetReachable: null });
    emit(ONLINE);
    expect(status.isOnline()).toBe(true);
    expect(changes).toEqual([false, true]);
    status.stop();
    expect(mockUnsubscribed).toHaveBeenCalled();
    emit(OFFLINE);
    expect(changes).toEqual([false, true]);
  });
});

function setup(failFirstChunk = false) {
  let t = 1_000_000;
  let saved: QueueItem[] = [];
  let failed = false;
  const calls: string[] = [];
  const api: RecordingUploadApi = {
    init: jest.fn(async () => {
      calls.push('init');
      return { sessionId: 's1' };
    }),
    chunkUrl: jest.fn(async (_s, body) => {
      calls.push(`url:${body.seq}`);
      if (failFirstChunk && !failed) {
        failed = true;
        throw new ApiError(503, 'PROVIDER_UNAVAILABLE', 'down');
      }
      return {
        seq: body.seq,
        upload: {
          url: 'https://s3/x',
          method: 'PUT' as const,
          headers: { 'content-length': '3' },
          expiresAt: '',
        },
        expiresAt: '',
      };
    }),
    put: jest.fn(async () => {
      calls.push('put');
    }),
    complete: jest.fn(async () => {
      calls.push('complete');
      return { status: 'processing' as const };
    }),
    abort: jest.fn(async () => undefined),
  };
  const files = new Set(['r1']);
  const chunks: ChunkSource = {
    read: async () => new Uint8Array([1, 2, 3]),
    remove: async (id) => void files.delete(id),
    exists: async (id) => files.has(id),
  };
  const network = createNetInfoStatus(loadNetInfo());
  const engine = createUploadQueueEngine({
    store: { load: async () => saved, save: async (i) => void (saved = i) },
    chunks,
    api,
    network,
    now: () => t,
  });
  const enqueue = () =>
    engine.enqueue({
      id: 'r1',
      organizationId: 'org-1',
      meetingId: 'm-1',
      mimeType: 'audio/webm',
      startedAt: '2026-10-31T10:00:00.000Z',
      durationMs: 1000,
      chunks: [{ seq: 0, sizeBytes: 3, sha256: 'a'.repeat(64) }],
      consent: {
        consentVersion: '2026-10',
        attestedAt: '2026-10-31T10:00:00.000Z',
        method: 'all_parties_notified',
      },
    });
  return { engine, network, calls, enqueue, advance: (ms: number) => (t += ms) };
}

const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

describe('upload queue with NetInfo', () => {
  it('pauses while offline without using up attempts, and resumes as soon as NetInfo says online', async () => {
    const s = setup();
    await s.enqueue();
    emit(OFFLINE);
    const appState = {
      currentState: 'active',
      addEventListener: () => ({ remove: () => undefined }),
    };
    const stop = startUploadScheduler(s.engine, appState, 60_000, s.network);
    await flush();
    expect(s.calls).toEqual([]);
    expect(await s.engine.status()).toMatchObject({ pending: 1, offline: true });
    expect((await s.engine.items())[0]).toMatchObject({ attempts: 0 });

    emit(ONLINE); // no need to wait for the 60 s tick
    await flush();
    await flush();
    expect(s.calls).toEqual(['init', 'url:0', 'put', 'complete']);
    stop();
  });

  it('coming online in the background does not upload (foreground only)', async () => {
    const s = setup();
    await s.enqueue();
    emit(OFFLINE);
    const process = jest.fn(() => Promise.resolve());
    const stop = startUploadScheduler(
      { process },
      { currentState: 'background', addEventListener: () => ({ remove: () => undefined }) },
      60_000,
      s.network,
    );
    emit(ONLINE);
    expect(process).not.toHaveBeenCalled();
    stop();
    emit(OFFLINE);
    emit(ONLINE);
    expect(process).not.toHaveBeenCalled();
  });

  it('keeps backoff: a failed upload is not retried early just because the network came back', async () => {
    const s = setup(true);
    await s.enqueue();
    await s.engine.process();
    const [item] = await s.engine.items();
    expect(item).toMatchObject({ attempts: 1, state: 'pending' });
    emit(OFFLINE);
    emit(ONLINE);
    await s.engine.process();
    expect(s.calls.filter((c) => c === 'url:0')).toHaveLength(1);
    s.advance(item!.nextAttemptAt - 1_000_000 + 1);
    await s.engine.process();
    expect(s.calls).toContain('complete');
  });
});
