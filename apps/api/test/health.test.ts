import { describe, it, expect } from 'vitest';
import { createServer } from '../src/server';

describe('GET /health', () => {
  it('returns ok', async () => {
    const app = createServer();
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toEqual({ status: 'ok' });
    await app.close();
  });
});
