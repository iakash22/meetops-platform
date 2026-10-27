import pino, { type LoggerOptions, type Logger } from 'pino';
import { CENSOR, DEFAULT_REDACT_KEYS, redactDeep, type RedactLimits } from './redact.js';

export type { Logger };
export {
  CENSOR,
  CIRCULAR,
  DEFAULT_REDACT_KEYS,
  redactDeep,
  TRUNCATED,
  type RedactLimits,
} from './redact.js';

/** Fixed header paths (fast-redact runs after serializers, so it covers serialized req/res headers). */
const headerPaths = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-csrf-token"]',
  'res.headers["set-cookie"]',
  'headers.authorization',
  'headers.cookie',
  'headers["x-csrf-token"]',
];

export type CreateLoggerOptions = LoggerOptions & {
  name?: string;
  /** Extra keys to redact at any depth, e.g. contracts REDACT_KEYS. Always merged with DEFAULT_REDACT_KEYS. */
  redactKeys?: readonly string[];
  redactLimits?: RedactLimits;
};

/**
 * pino logger with two redaction layers: a depth-capped key walker on every log object and child binding
 * (`formatters.log` / `formatters.bindings`, ADR-005 A1.5), and fast-redact paths for serialized headers.
 * Caller `formatters` run after the walker; caller `redact.paths` are added to the header paths.
 */
export function createLogger(
  options: CreateLoggerOptions = {},
  destination?: pino.DestinationStream,
): Logger {
  const { redactKeys = [], redactLimits, formatters, redact, ...rest } = options;
  const keys = [...new Set([...DEFAULT_REDACT_KEYS, ...redactKeys])];
  const extraPaths = Array.isArray(redact) ? redact : (redact?.paths ?? []);
  const opts: LoggerOptions = {
    level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
    ...rest,
    redact: { paths: [...new Set([...headerPaths, ...extraPaths])], censor: CENSOR },
    formatters: {
      ...formatters,
      log: (obj) => {
        const r = redactDeep(obj, keys, redactLimits) as Record<string, unknown>;
        return formatters?.log ? formatters.log(r) : r;
      },
      bindings: (b) => {
        const r = redactDeep(b, keys, redactLimits) as pino.Bindings;
        return formatters?.bindings ? formatters.bindings(r) : r;
      },
    },
  };
  const root = destination ? pino(opts, destination) : pino(opts);
  return wrapChild(root, keys, redactLimits);
}

/**
 * pino serializes child bindings without `formatters.bindings`, so redact them before they reach pino. pino children
 * are `Object.create(parent)`, so the override is inherited and always calls pino's own `child` on the right `this`.
 */
function wrapChild(root: Logger, keys: readonly string[], limits?: RedactLimits): Logger {
  type ChildFn = (this: Logger, b: pino.Bindings, o?: pino.ChildLoggerOptions) => Logger;
  const pinoChild = Reflect.get(root, 'child') as unknown as ChildFn;
  root.child = function (this: Logger, bindings: pino.Bindings, opts?: pino.ChildLoggerOptions) {
    return pinoChild.call(this, redactDeep(bindings, keys, limits) as pino.Bindings, opts);
  } as unknown as Logger['child'];
  return root;
}

export const logger = createLogger({ name: 'meetops' });
