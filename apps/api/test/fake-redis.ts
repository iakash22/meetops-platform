import {
  INCR_WITH_EXPIRY_LUA,
  type RedisLike,
} from '../src/modules/auth/infrastructure/rate-limit/redis.js';

/** In-process fake of the RedisLike subset, with a manual clock. PUBLISH calls are recorded. */
export const fakeRedis = (): RedisLike & {
  advance(ms: number): void;
  published: { channel: string; message: string }[];
} => {
  const published: { channel: string; message: string }[] = [];
  const store = new Map<string, { v: string; exp: number }>();
  const sets = new Map<string, Set<string>>();
  let t = 0;
  const alive = (k: string) => {
    const e = store.get(k);
    if (e && e.exp <= t) store.delete(k);
    return store.get(k);
  };
  return {
    advance: (ms) => void (t += ms),
    published,
    publish: async (channel, message) => {
      published.push({ channel, message });
      return 0;
    },
    incr: async (k) => {
      const e = alive(k) ?? { v: '0', exp: Infinity };
      e.v = String(Number(e.v) + 1);
      store.set(k, e);
      return Number(e.v);
    },
    pexpire: async (k, ms) => {
      const e = alive(k);
      if (e) e.exp = t + ms;
      return e ? 1 : 0;
    },
    pttl: async (k) => {
      const e = alive(k);
      return e ? (e.exp === Infinity ? -1 : e.exp - t) : -2;
    },
    set: async (k: string, v: string, _m: 'PX', ms: number, nx?: 'NX') => {
      if (nx === 'NX' && alive(k)) return null;
      store.set(k, { v, exp: t + ms });
      return 'OK';
    },
    get: async (k) => alive(k)?.v ?? null,
    getdel: async (k) => {
      const v = alive(k)?.v ?? null;
      store.delete(k);
      return v;
    },
    del: async (...ks) => ks.filter((k) => store.delete(k)).length,
    sadd: async (k, ...m) => {
      const s = sets.get(k) ?? new Set();
      m.forEach((x) => s.add(x));
      sets.set(k, s);
      return m.length;
    },
    smembers: async (k) => [...(sets.get(k) ?? [])],
    // Emulates INCR_WITH_EXPIRY_LUA synchronously (i.e. atomically, like Redis runs scripts).
    eval: async (script, _n, k, ms) => {
      if (script !== INCR_WITH_EXPIRY_LUA) throw new Error('unexpected script');
      const key = String(k);
      const e = alive(key) ?? { v: '0', exp: Infinity };
      e.v = String(Number(e.v) + 1);
      if (e.v === '1' || e.exp === Infinity) e.exp = t + Number(ms);
      store.set(key, e);
      return [Number(e.v), e.exp - t];
    },
  };
};
