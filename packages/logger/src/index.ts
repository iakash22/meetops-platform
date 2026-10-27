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
  /**
   * Maps the client IP in `req` logs (e.g. ADR-014 /24-/48 truncation). Applied by the single request serializer
   * together with the URL query redaction, so one serializer does both (#290).
   */
  requestIp?: IpMapper;
};

export type IpMapper = (ip: string | null) => string | null | undefined;

/**
 * pino logger with two redaction layers: a depth-capped key walker on every log object and child binding
 * (`formatters.log` / `formatters.bindings`, ADR-005 A1.5), and fast-redact paths for serialized headers.
 * Caller `formatters` run after the walker; caller `redact.paths` are added to the header paths.
 */
export function createLogger(
  options: CreateLoggerOptions = {},
  destination?: pino.DestinationStream,
): Logger {
  const { redactKeys = [], redactLimits, requestIp, formatters, redact, ...rest } = options;
  const keys = [...new Set([...DEFAULT_REDACT_KEYS, ...redactKeys])];
  const extraPaths = Array.isArray(redact) ? redact : (redact?.paths ?? []);
  const opts: LoggerOptions = {
    level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
    ...rest,
    // Fastify request logs: sensitive query values (signed unsubscribe tokens, OAuth code/state) never reach the log
    // (PR #263 M-1, #282 M-2). Caller serializers win per key.
    serializers: { req: requestSerializer(keys, { mapIp: requestIp }), ...rest.serializers },
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
  /** App-resolved client IP (apps/api decorates it from trusted proxy headers); preferred over `ip`. */
  clientIp?: string | null;
  remoteAddress?: string;
  remotePort?: number;
  socket?: { remoteAddress?: string };
};

export interface RequestSerializerOptions {
  /** Maps the client IP (e.g. truncation). When set, `remotePort` is never logged either. */
  mapIp?: IpMapper | undefined;
}

/**
 * The single Fastify-shaped `req` serializer: sensitive query values redacted from `url` (#263 M-1, #282 M-2) and,
 * with `mapIp`, the client IP mapped (ADR-014 truncation, #290 M-1). `createLogger` installs it for every logger.
 */
export function requestSerializer(
  keys: Iterable<string> = DEFAULT_REDACT_KEYS,
  { mapIp }: RequestSerializerOptions = {},
) {
  const list = [...keys];
  const ip = (v: string | undefined) => (mapIp ? (mapIp(v ?? null) ?? undefined) : v);
  return (req: ReqLike): Record<string, unknown> => {
    const proto = Object.getPrototypeOf(req) as unknown;
    if (proto === Object.prototype || proto === null) {
      // Plain log objects (already-serialized shapes): keep every field, scrub the URL and any IP fields.
      const out: Record<string, unknown> = { ...req };
      if (typeof req.url === 'string') out.url = redactUrl(req.url, list);
      if (mapIp) {
        if ('ip' in req) out.ip = ip(req.ip);
        if ('remoteAddress' in req) out.remoteAddress = ip(req.remoteAddress);
        delete out.remotePort;
      }
      return out;
    }
    return {
      method: req.method,
      url: typeof req.url === 'string' ? redactUrl(req.url, list) : req.url,
      host: req.host ?? req.hostname,
      remoteAddress: ip(req.clientIp ?? req.ip ?? req.socket?.remoteAddress),
    };
  };
}

/** @deprecated Alias of the single request serializer with default keys (#282 L); use `createLogger`. */
export const reqSerializer = requestSerializer();

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
