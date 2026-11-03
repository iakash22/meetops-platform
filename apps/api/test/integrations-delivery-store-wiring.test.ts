import { afterEach, describe, expect, it } from 'vitest';
import { createHmac, generateKeyPairSync, randomUUID } from 'node:crypto';
import {
  InMemoryDeliveryStore,
  RedisDeliveryStore,
  recordDelivery,
  type DeliveryStore,
} from '@meetops/integrations';
import type { ModuleDeps } from '../src/modules/index.js';
import { selectIntegrationsRuntime } from '../src/modules/integrations/index.js';
import { InMemoryIntegrations } from '../src/modules/integrations/in-memory.repository.js';
import {
  deliveryRedisFromEval,
  devIntegrationsRuntime,
} from '../src/modules/integrations/runtime.js';
import { buildApp, type App } from './helpers.js';

/** Minimal EVAL-only Redis fake covering the scripts the delivery store and its adapter send. */
function fakeEvalRedis() {
  const kv = new Map<string, string>();
  return {
    kv,
    async eval(script: string, _n: number, ...args: (string | number)[]): Promise<unknown> {
      const [key, a1, a2] = args.map(String) as [string, string?, string?];
      if (script.includes('string.sub')) {
        const v = kv.get(key);
        return v === undefined ? 'absent' : v.startsWith('pending:') ? 'pending' : 'recorded';
      }
      if (script.includes("'EXISTS'")) return kv.has(key) ? 1 : 0;
      if (script.includes("'DEL'")) {
        if (kv.get(key) === a1) return kv.delete(key) ? 1 : 0;
        return 0;
      }
      if (script.includes("'GET'")) {
        if (kv.get(key) !== a1) return 0;
        kv.set(key, '1');
        return 1;
      }
      if (script.includes("'NX'")) {
        if (kv.has(key)) return null;
        kv.set(key, a1!);
        void a2;
        return 'OK';
      }
      throw new Error('unexpected script');
    },
  };
}

const devRt = () => devIntegrationsRuntime({ apiOrigin: 'http://api.test' });

/** `undefined` must mean a truly unset NODE_ENV (the default parameter reads process.env.NODE_ENV). */
function withNodeEnv<T>(nodeEnv: string | undefined, fn: () => T): T {
  const prev = process.env.NODE_ENV;
  if (nodeEnv === undefined) delete process.env.NODE_ENV;
  try {
    return fn();
  } finally {
    process.env.NODE_ENV = prev;
  }
}

describe('webhook delivery store wiring (release blocker)', () => {
  it.each([undefined, 'production', 'Production', 'prod', 'staging'])(
    'NODE_ENV=%s without Redis refuses the in-memory store at startup',
    (nodeEnv) => {
      const rt = devRt();
      expect(rt.deliveryStore).toBeInstanceOf(InMemoryDeliveryStore);
      expect(() =>
        withNodeEnv(nodeEnv, () =>
          selectIntegrationsRuntime({ integrationsRuntime: rt } as never, nodeEnv, {}),
        ),
      ).toThrow(/shared webhook delivery store/);
    },
  );

  it.each([undefined, 'production', 'Production', 'prod', 'staging'])(
    'NODE_ENV=%s with the API Redis client wires RedisDeliveryStore',
    (nodeEnv) => {
      const redis = fakeEvalRedis();
      const rt = devRt();
      const out = withNodeEnv(nodeEnv, () =>
        selectIntegrationsRuntime(
          { integrationsRuntime: rt, redis } as unknown as ModuleDeps,
          nodeEnv,
          {},
        ),
      );
      expect(out?.deliveryStore).toBeInstanceOf(RedisDeliveryStore);
      expect(out?.deliveryStore.shared).toBe(true);
    },
  );

  it('a RedisDeliveryStore is kept; a look-alike with shared: true is not; dev/test keep in-memory', () => {
    const redisStore = new RedisDeliveryStore(deliveryRedisFromEval(fakeEvalRedis()));
    expect(
      selectIntegrationsRuntime(
        { integrationsRuntime: { ...devRt(), deliveryStore: redisStore } } as never,
        'staging',
        {},
      )?.deliveryStore,
    ).toBe(redisStore);
    const lookAlike: DeliveryStore = { markIfNew: async () => true, shared: true };
    expect(() =>
      selectIntegrationsRuntime(
        { integrationsRuntime: { ...devRt(), deliveryStore: lookAlike } } as never,
        'staging',
        {},
      ),
    ).toThrow(/shared webhook delivery store/);
    for (const env of ['development', 'test'])
      expect(
        selectIntegrationsRuntime({ integrationsRuntime: devRt() } as never, env, {})
          ?.deliveryStore,
      ).toBeInstanceOf(InMemoryDeliveryStore);
  });

  it('the EVAL adapter supports claim, 429 release and commit through RedisDeliveryStore', async () => {
    const redis = fakeEvalRedis();
    const store = new RedisDeliveryStore(deliveryRedisFromEval(redis), { keyPrefix: 'w:' });
    const limited = async () => {
      throw new Error('429');
    };
    await expect(recordDelivery(store, 'd', 60, limited)).rejects.toThrow('429');
    expect(redis.kv.has('w:d')).toBe(false);
    expect(await recordDelivery(store, 'd', 60, async () => {})).toBe(true);
    expect(redis.kv.get('w:d')).toBe('1');
    expect(await recordDelivery(store, 'd', 60, async () => {})).toBe(false);
  });
});

describe('delivery in progress', () => {
  let app: App | undefined;
  afterEach(async () => app?.close());

  it.each(['in-memory', 'redis'] as const)(
    '%s store: a pending duplicate is 409 DELIVERY_IN_PROGRESS with Retry-After; a recorded one REPLAYED_DELIVERY',
    async (kind) => {
      const SECRET = 'gh-app-webhook-secret';
      const pem = generateKeyPairSync('rsa', { modulusLength: 2048 })
        .privateKey.export({ type: 'pkcs8', format: 'pem' })
        .toString();
      const store: DeliveryStore & { claim(id: string, ttl: number): Promise<string | null> } =
        kind === 'redis'
          ? new RedisDeliveryStore(deliveryRedisFromEval(fakeEvalRedis()))
          : new InMemoryDeliveryStore({ nodeEnv: 'test' });
      const repo = new InMemoryIntegrations();
      repo.add(
        {
          id: randomUUID(),
          organizationId: randomUUID(),
          provider: 'github',
          status: 'active',
          displayName: 'acme',
          externalAccountId: '99',
          connectedById: randomUUID(),
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        { accessToken: 'a', refreshToken: null, webhookSecret: 'unused' },
      );
      app = await buildApp({
        integrations: repo,
        integrationsRuntime: devIntegrationsRuntime({
          apiOrigin: 'http://api.test',
          deliveryStore: store,
          github: {
            appSlug: 'meetops-test',
            appId: '123',
            clientId: 'Iv1.abc',
            privateKey: async () => pem,
            clientSecret: async () => 'x',
            webhookSecret: async () => SECRET,
          },
        }),
      } as Partial<ModuleDeps>);
      const body = JSON.stringify({
        action: 'opened',
        issue: { number: 1 },
        installation: { id: 99 },
      });
      const delivery = randomUUID();
      const send = () =>
        app!.inject({
          method: 'POST',
          url: '/webhooks/github',
          payload: body,
          headers: {
            'content-type': 'application/json',
            'x-github-event': 'issues',
            'x-github-delivery': delivery,
            'x-hub-signature-256': `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`,
          },
        });
      const token = await store.claim(delivery, 30); // another request holds the claim
      expect(token).toBeTruthy();
      const r = await send();
      expect(r.statusCode).toBe(409);
      expect(r.json()).toMatchObject({
        error: { code: 'CONFLICT', reason: 'DELIVERY_IN_PROGRESS' },
      });
      expect(Number(r.headers['retry-after'])).toBeGreaterThan(0);
      await store.commit!(delivery, token as string, 60);
      const replay = await send();
      expect(replay.statusCode).toBe(409);
      expect(replay.json()).toMatchObject({
        error: { code: 'CONFLICT', reason: 'REPLAYED_DELIVERY' },
      });
    },
  );
});
