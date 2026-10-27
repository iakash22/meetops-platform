import pino, { type LoggerOptions, type Logger } from 'pino';
import {
  CENSOR,
  DEFAULT_REDACT_KEYS,
  redactDeep,
  redactUrl,
  scrubText,
  type RedactLimits,
} from './redact.js';

export type { Logger };
export {
  CENSOR,
  CIRCULAR,
  CONDITIONAL_REDACT_KEYS,
  DEFAULT_REDACT_KEYS,
  redactDeep,
  redactUrl,
  reqSerializer,
  scrubText,
  SENSITIVE_QUERY_PARAMS,
  SENSITIVE_QUERY_KEYS,
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
    // Fastify request logs: sensitive query values (signed unsubscribe tokens, OAuth code/state) never reach the log
    // (PR #263 M-1, #282 M-2). Caller serializers win per key.
    serializers: { req: requestSerializer(keys), ...rest.serializers },
    redact: { paths: [...new Set([...headerPaths, ...extraPaths])], censor: CENSOR },
    hooks: {
      ...rest.hooks,
      // #282 M-1: scrub PEM blocks / GitHub tokens from the message string (formatters.log never sees it).
      logMethod(args, method, level) {
        const scrubbed = args.map((a) => (typeof a === 'string' ? scrubText(a) : a)) as typeof args;
        return rest.hooks?.logMethod
          ? rest.hooks.logMethod.call(this, scrubbed, method, level)
          : method.apply(this, scrubbed);
      },
    },
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

type ReqLike = {
  method?: string;
  url?: string;
  host?: string;
  hostname?: string;
  ip?: string;
  socket?: { remoteAddress?: string };
};

/** Fastify-shaped `req` serializer with sensitive query values redacted. */
export function requestSerializer(keys: Iterable<string> = DEFAULT_REDACT_KEYS) {
  const list = [...keys];
  return (req: ReqLike) => {
    const proto = Object.getPrototypeOf(req) as unknown;
    if (proto === Object.prototype || proto === null) {
      // Plain log objects (already-serialized shapes): keep every field, only scrub the URL.
      return typeof req.url === 'string' ? { ...req, url: redactUrl(req.url, list) } : req;
    }
    return fastifyShape(req, list);
  };
}

function fastifyShape(req: ReqLike, list: string[]) {
  return {
    method: req.method,
    url: typeof req.url === 'string' ? redactUrl(req.url, list) : req.url,
    host: req.host ?? req.hostname,
    remoteAddress: req.ip ?? req.socket?.remoteAddress,
  };
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
