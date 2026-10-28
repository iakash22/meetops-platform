export interface AuthMailQueueEnv {
  /** `inline` (default; dev/test) or `bullmq` (production auth mail queue, ADR-013). */
  mode: 'inline' | 'bullmq';
  /** BullMQ key prefix; undefined = BullMQ default `bull`. */
  prefix: string | undefined;
  /** Run the auth-mail consumer in this process (default true when mode is bullmq). */
  workerEnabled: boolean;
  concurrency: number;
}

const bool = (v: string | undefined, def: boolean, name: string) => {
  const s = (v ?? '').trim().toLowerCase();
  if (s === '') return def;
  if (['true', '1', 'yes', 'on'].includes(s)) return true;
  if (['false', '0', 'no', 'off'].includes(s)) return false;
  throw new Error(`${name} must be a boolean`);
};

/** Reads only the injected env record (never process.env). Invalid values throw, naming the variable only. */
export function loadAuthMailQueueEnv(
  env: Record<string, string | undefined> = {},
): AuthMailQueueEnv {
  const mode = (env.AUTH_MAIL_QUEUE ?? '').trim().toLowerCase() || 'inline';
  if (mode !== 'inline' && mode !== 'bullmq')
    throw new Error('AUTH_MAIL_QUEUE must be "inline" or "bullmq"');
  const prefix = (env.AUTH_MAIL_QUEUE_PREFIX ?? '').trim() || undefined;
  if (prefix !== undefined && !/^[A-Za-z0-9:_-]{1,64}$/.test(prefix))
    throw new Error('AUTH_MAIL_QUEUE_PREFIX has invalid characters');
  const c = (env.AUTH_MAIL_WORKER_CONCURRENCY ?? '').trim();
  if (c !== '' && !/^[0-9]{1,3}$/.test(c))
    throw new Error('AUTH_MAIL_WORKER_CONCURRENCY must be an integer');
  return {
    mode,
    prefix,
    workerEnabled: bool(env.AUTH_MAIL_WORKER_ENABLED, true, 'AUTH_MAIL_WORKER_ENABLED'),
    concurrency: c === '' ? 5 : Math.min(50, Math.max(1, Number(c))),
  };
}
