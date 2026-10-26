import { describe, expect, it, vi } from 'vitest';
import { createMockApi } from './fixtures/render';

describe('createMockApi', () => {
  it('uses a passed-in request mock', async () => {
    const request = vi.fn().mockResolvedValue({ ok: 1 });
    const api = createMockApi({ request });
    await expect(api.request('GET', '/x')).resolves.toEqual({ ok: 1 });
    expect(request).toHaveBeenCalledWith('GET', '/x');
  });

  it('defaults request to a resolved mock', async () => {
    await expect(createMockApi().request('GET', '/x')).resolves.toBeUndefined();
  });
});
