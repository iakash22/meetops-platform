import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import {
  CONSENT_CHECK_FAILED_MESSAGE,
  PAIRING_CHECK_FAILED_MESSAGE,
  PAIRING_REQUIRED_MESSAGE,
  handleBackgroundMessage,
  type BackgroundDeps,
} from '../src/lib/background-handler.js';
import { loadState } from '../src/lib/recorder-state.js';
import {
  QUOTA_CHECK_FAILED_MESSAGE,
  QUOTA_FULL_START_MESSAGE,
  QUOTA_LOW_MESSAGE,
} from '../src/lib/storage-quota.js';
import { makeDeps } from './helpers/bg-deps.js';

const MID = '6f1c2b8e-3d4a-4e5f-9a6b-7c8d9e0f1a2b';
const GRANT = { meetingId: MID, method: 'all_parties_consented' as const };
const popup = { fromSelf: true, fromOffscreen: false, fromPopup: true };
const bg = <T extends object>(m: T) => ({ target: 'background', ...m });
const MB = 1024 * 1024;

async function start(deps: BackgroundDeps, streamId = 's') {
  await handleBackgroundMessage(deps, bg({ type: 'ACK_CONSENT', tabId: 3, ...GRANT }), popup);
  return handleBackgroundMessage(
    deps,
    bg({ type: 'START_RECORDING', meetingId: MID, tabId: 3, streamId }),
    popup,
  );
}

describe('Start fails closed', () => {
  it('refuses when not paired, with a clear message', async () => {
    const { deps } = makeDeps();
    const r = await start({ ...deps, checkPairing: async () => false });
    expect(r).toEqual({ ok: false, error: PAIRING_REQUIRED_MESSAGE });
    expect(deps.ensureOffscreen).not.toHaveBeenCalled();
  });

  it('refuses when the pairing check throws', async () => {
    const { deps } = makeDeps();
    const r = await start({
      ...deps,
      checkPairing: () => Promise.reject(new Error('storage.session unavailable')),
    });
    expect(r).toEqual({ ok: false, error: PAIRING_CHECK_FAILED_MESSAGE });
    expect(deps.ensureOffscreen).not.toHaveBeenCalled();
  });

  it('treats a non-true pairing result as unpaired', async () => {
    const { deps } = makeDeps();
    const r = await start({
      ...deps,
      checkPairing: (async () => 'yes') as unknown as () => Promise<boolean>,
    });
    expect(r).toEqual({ ok: false, error: PAIRING_REQUIRED_MESSAGE });
  });

  it('refuses when reading consent throws (never treated as consent)', async () => {
    const { deps } = makeDeps();
    await handleBackgroundMessage(deps, bg({ type: 'ACK_CONSENT', tabId: 3, ...GRANT }), popup);
    const get = deps.kv.get.bind(deps.kv);
    vi.spyOn(deps.kv, 'get').mockImplementation(async (k: string) => {
      if (k.startsWith('consent:')) throw new Error('read failed');
      return get(k);
    });
    const r = await handleBackgroundMessage(
      deps,
      bg({ type: 'START_RECORDING', meetingId: MID, tabId: 3, streamId: 's' }),
      popup,
    );
    expect(r).toEqual({ ok: false, error: CONSENT_CHECK_FAILED_MESSAGE });
    expect(deps.ensureOffscreen).not.toHaveBeenCalled();
  });

  it('starts when paired with consent', async () => {
    const { deps } = makeDeps();
    const r = await start({ ...deps, checkPairing: async () => true });
    expect(r.ok).toBe(true);
    expect(deps.ensureOffscreen).toHaveBeenCalled();
  });
});

describe('Start storage quota', () => {
  it('refuses when the browser quota has less than one local chunk free', async () => {
    const { deps } = makeDeps();
    const r = await start({
      ...deps,
      storageQuota: async () => ({ usage: 100 * MB - 1 * MB, quota: 100 * MB }),
    });
    expect(r).toEqual({ ok: false, error: QUOTA_FULL_START_MESSAGE });
    expect(deps.ensureOffscreen).not.toHaveBeenCalled();
  });

  it('refuses when the quota estimate errors', async () => {
    const { deps } = makeDeps();
    const r = await start({ ...deps, storageQuota: () => Promise.reject(new Error('x')) });
    expect(r).toEqual({ ok: false, error: QUOTA_CHECK_FAILED_MESSAGE });
  });

  it('refuses when the quota is unknown (0 of 0), failing closed', async () => {
    const { deps } = makeDeps();
    const r = await start({ ...deps, storageQuota: async () => ({ usage: 0, quota: 0 }) });
    expect(r).toEqual({ ok: false, error: QUOTA_CHECK_FAILED_MESSAGE });
  });

  it('starts but warns the user when quota is low', async () => {
    const { deps } = makeDeps();
    const d = { ...deps, storageQuota: async () => ({ usage: 950 * MB, quota: 1000 * MB }) };
    const r = await start(d);
    expect(r.ok).toBe(true);
    expect((await loadState(deps.kv)).storageWarning).toBe(QUOTA_LOW_MESSAGE);
  });
});
