import { describe, expect, it } from 'vitest';
import {
  REFRESH_GRACE_WINDOW_MS,
  RefreshGraceCache,
} from '../src/modules/auth/application/refresh-grace.js';

describe('RefreshGraceCache', () => {
  it('replays only the latest token, same device, within the window', async () => {
    const g = new RefreshGraceCache<string>();
    g.begin('f', 'h1', 'd', 0).resolve('pair1');
    expect(await g.replay('f', 'h1', 'd', REFRESH_GRACE_WINDOW_MS)).toBe('pair1');
    expect(g.replay('f', 'h1', 'd', REFRESH_GRACE_WINDOW_MS + 1)).toBeUndefined();
    expect(g.replay('f', 'h1', 'other', 1)).toBeUndefined();
    g.begin('f', 'h2', 'd', 5).resolve('pair2');
    expect(g.replay('f', 'h1', 'd', 6)).toBeUndefined();
    g.forget('f');
    expect(g.replay('f', 'h2', 'd', 6)).toBeUndefined();
  });

  it('drops a failed rotation and stays bounded', async () => {
    const g = new RefreshGraceCache<string>(10_000, 2);
    g.begin('f', 'h', 'd', 0).reject();
    expect(g.replay('f', 'h', 'd', 1)).toBeUndefined();
    g.begin('a', 'h', 'd', 0).resolve('a');
    g.begin('b', 'h', 'd', 0).resolve('b');
    g.begin('c', 'h', 'd', 0).resolve('c');
    expect(g.replay('a', 'h', 'd', 1)).toBeUndefined();
    expect(await g.replay('c', 'h', 'd', 1)).toBe('c');
  });
});
