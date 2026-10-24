import { describe, it, expect } from 'vitest';

describe('package entry', () => {
  it('exports createServer without starting a listener', async () => {
    const mod = await import( '../src/index.js');
    const app = mod.createServer();
    await app.ready();
    expect(app.server.listening).toBe(false);
    expect((await app.inject({ method: 'GET', url: '/health' })).json()).toEqual({ status: 'ok' });
    await app.close();
  });
});
