import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// apps/api does not export createServer from its package entry (index.ts starts
// listening), so import the builder from source. See README "Dependencies".
// TODO(architecture): QA reaches into apps/api/src; switch to the @meetops/api package entry (needs a built
// workspace and a tests -> @meetops/api dependency), then drop this disable.
// eslint-disable-next-line @typescript-eslint/no-restricted-imports
import { createServer } from '../../apps/api/src/server.js';

const externalUrl = process.env.API_BASE_URL;

type Call = (path: string) => Promise<{ status: number; body: unknown }>;

describe('API health endpoints', () => {
  let app: ReturnType<typeof createServer> | undefined;
  let call: Call;

  beforeAll(async () => {
    if (externalUrl) {
      call = async (path) => {
        const res = await fetch(new URL(path, externalUrl));
        return { status: res.status, body: await res.json() };
      };
      return;
    }
    process.env.LOG_LEVEL ??= 'silent';
    app = createServer();
    await app.ready();
    call = async (path) => {
      const res = await app!.inject({ method: 'GET', url: path });
      return { status: res.statusCode, body: res.json() };
    };
  }, 60_000);

  afterAll(async () => {
    await app?.close();
  }, 60_000);

  it('GET /health returns ok', async () => {
    const res = await call('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('GET /ready returns ready', async () => {
    const res = await call('/ready');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ready' });
  });

  it('unknown route returns 404', async () => {
    const res = await call('/__does_not_exist__');
    expect(res.status).toBe(404);
  });
});
