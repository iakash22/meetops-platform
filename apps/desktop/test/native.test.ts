import { afterEach, describe, expect, it, vi } from 'vitest';

const core = vi.hoisted(() => ({ invoke: vi.fn(), isTauri: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => core);

import { getAppInfo } from '@/lib/native';

afterEach(() => {
  vi.resetAllMocks();
});

describe('getAppInfo', () => {
  it('falls back to browser info outside Tauri without invoking', async () => {
    core.isTauri.mockReturnValue(false);
    await expect(getAppInfo()).resolves.toMatchObject({ runtime: 'browser' });
    expect(core.invoke).not.toHaveBeenCalled();
  });

  it('invokes the Rust app_info command inside Tauri', async () => {
    core.isTauri.mockReturnValue(true);
    core.invoke.mockResolvedValue({
      name: 'MeetOps AI',
      version: '0.0.0',
      os: 'linux',
      arch: 'x86_64',
    });
    await expect(getAppInfo()).resolves.toEqual({
      name: 'MeetOps AI',
      version: '0.0.0',
      os: 'linux',
      arch: 'x86_64',
      runtime: 'tauri',
    });
    expect(core.invoke).toHaveBeenCalledWith('app_info');
  });
});
