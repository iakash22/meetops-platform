import { truncateIp } from './ip.js';

interface SerializableRequest {
  method?: string;
  url?: string;
  hostname?: string;
  host?: string;
  ip?: string;
  clientIp?: string | null;
}

/**
 * ADR-014: request logs never carry a full client IP. Replaces Fastify's default req serializer
 * (method/url/host/remoteAddress/remotePort) with one that logs the address truncated to /24 (v4) or /48 (v6),
 * and drops remotePort.
 *
 * TODO(#282): once @meetops/logger `reqSerializer` (URL query redaction) is on the base, compose:
 * `{ ...reqSerializer(req), remoteAddress: truncateIp(...) }` and drop remotePort.
 */
export function truncatingReqSerializer(req: SerializableRequest) {
  return {
    method: req.method,
    url: req.url,
    host: req.host ?? req.hostname,
    remoteAddress: truncateIp(req.clientIp ?? req.ip ?? null),
  };
}
