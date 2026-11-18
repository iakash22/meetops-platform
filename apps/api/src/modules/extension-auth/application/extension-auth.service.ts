import { clientIpKey } from '../../../shared/rate-limit-core.js';
import {
  EXTENSION_REFRESH_FAMILY_MAX_LIFETIME_SECONDS,
  EXTENSION_SCOPES,
  EXTENSION_TOKEN_AUDIENCE,
  EXTENSION_TOKEN_TTL_SECONDS,
  EXTENSION_TOKEN_TYPE,
  type ExtensionPairRequest,
  type ExtensionPairResponse,
  type ExtensionRefreshRequest,
  type ExtensionRefreshResponse,
  type ExtensionRevokeRequest,
  type ExtensionTokenRequest,
  type ExtensionTokenResponse,
} from '@meetops/contracts';
import type { ExtensionTokenRecord, ExtensionTokenStore } from '@meetops/session-verifier';
import { DomainError } from '../../../shared/domain-error.js';
import type { Clock, IdGenerator } from '../../../shared/ports.js';
import { safeAudit, type AuditAction, type AuditLog } from '../../auth/domain/audit.js';
import { RateLimitedError, UnauthenticatedError } from '../../auth/domain/errors.js';
import type { RateLimiter, TokenService } from '../../auth/domain/ports.js';
import type { RequestMeta } from '../../auth/application/auth.service.js';
import {
  MemoryRefreshGraceStore,
  type RefreshGraceStore,
} from '../../auth/application/refresh-grace.js';
import { publishRevocation, type RevocationPublisher } from '../../auth/application/revocations.js';
import type {
  MembershipRepository,
  OrganizationRepository,
} from '../../organizations/domain/repositories.js';
import type { ExtensionTokenRepository, TokenFamily } from '../domain/extension-token.js';

/** ADR-005 A1.1.3: pairing codes expire within 60 s. */
export const PAIRING_CODE_TTL_MS = 60_000;

const MIN = 60_000;
const HOUR = 60 * MIN;
/** ADR-005 A1.4 starting values (DevOps tunes them). */
export const EXTENSION_LIMITS = {
  pairPerUserMin: { limit: 5, windowMs: MIN },
  pairPerUserHour: { limit: 20, windowMs: HOUR },
  pairPerIp: { limit: 10, windowMs: MIN },
  tokenPerIp: { limit: 10, windowMs: MIN },
  refreshPerFamily: { limit: 10, windowMs: MIN },
  refreshPerIp: { limit: 60, windowMs: MIN },
  revokePerFamily: { limit: 10, windowMs: MIN },
  revokePerIp: { limit: 60, windowMs: MIN },
  /** A1.4 SHOULD: a refresh sooner than 60 s after the previous one in the same family is logged (never rejected). */
  refreshFrequentWindow: { limit: 1, windowMs: MIN },
} as const;

/** Structured logger for security signals. Never pass tokens, codes or hashes. */
export interface ExtensionAuthLog {
  warn(obj: Record<string, unknown>, msg: string): void;
}

export class ExtensionNotAllowedError extends DomainError {
  constructor() {
    super('FORBIDDEN', 'Extension not allowed', 403);
  }
}
export class NoActiveOrganizationError extends DomainError {
  constructor() {
    super('FORBIDDEN', 'Select an organization before pairing the extension', 403);
  }
}

export interface RevokeForUserOptions {
  /**
   * #459 follow-up: rethrow a store failure instead of swallowing it, so a caller that retries (the account-takeover
   * follow-up) sees it. Default false: logout, reset and member removal never fail on this step.
   */
  propagate?: boolean;
}

export interface ExtensionRevoker {
  /** ADR-005 A1.6: revoke a user's families (all, or in one org). Never throws unless `opts.propagate`. */
  revokeForUser(
    userId: string,
    reason: 'logout' | 'logout_all' | 'password_changed' | 'member_removed' | 'org_switch',
    organizationId?: string,
    opts?: RevokeForUserOptions,
  ): Promise<void>;
}

export interface ExtensionAuthDeps {
  extensionTokens: ExtensionTokenRepository;
  /** Allowlisted Chrome extension ids (EXTENSION_IDS, plus EXTENSION_DEV_IDS in development/test). */
  extensionIds: readonly string[];
  tokens: TokenService;
  rateLimiter: RateLimiter;
  audit: AuditLog;
  clock: Clock;
  ids: IdGenerator;
  organizations: OrganizationRepository;
  memberships: MembershipRepository;
  revocations?: RevocationPublisher;
  /** Security-signal logger (the API's redacting request logger in production). */
  log?: ExtensionAuthLog;
  /** Refresh grace window store (Redis when configured, so retries on any instance match). */
  refreshGrace?: RefreshGraceStore<ExtensionRefreshResponse>;
}

type Limit = { limit: number; windowMs: number };

/**
 * ADR-005 amendment 1: pairing, token exchange, rotating refresh with reuse detection, and revocation.
 * Tokens are opaque (TokenService: 256-bit base64url); only SHA-256 hashes are stored. Every credential
 * failure is the same 401 UNAUTHENTICATED so a caller cannot tell which check failed.
 */
export class ExtensionAuthService implements ExtensionRevoker {
  /** ~10 s grace for re-presenting the immediately previous refresh token from the same device. */
  private readonly grace: RefreshGraceStore<ExtensionRefreshResponse>;
  constructor(private readonly d: ExtensionAuthDeps) {
    this.grace =
      d.refreshGrace ??
      new MemoryRefreshGraceStore<ExtensionRefreshResponse>(() => d.clock.now().getTime());
  }

  isAllowedExtension(extensionId: string): boolean {
    return this.d.extensionIds.includes(extensionId);
  }

  /** CORS origins for the extension lifecycle routes (A1.3.6). */
  allowedOrigins(): string[] {
    return this.d.extensionIds.map((id) => `chrome-extension://${id}`);
  }

  private async limit(key: string, l: Limit, cost = 1) {
    for (let i = 0; i < cost; i++) {
      const r = await this.d.rateLimiter.consume(`ext:${key}`, l.limit, l.windowMs);
      if (!r.allowed) throw new RateLimitedError(r.retryAfterMs);
    }
  }

  private audit(
    e: {
      organizationId: string;
      actorId: string;
      action: AuditAction;
      deviceId: string;
      extensionId: string;
      familyId?: string;
    },
    meta: RequestMeta,
  ) {
    return safeAudit(this.d.audit, {
      organizationId: e.organizationId,
      actorId: e.actorId,
      action: e.action,
      targetType: 'extension_device',
      targetId: e.deviceId,
      metadata: { extensionId: e.extensionId, familyId: e.familyId ?? null },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
  }

  /**
   * ADR-005 A1.4 SHOULD: log a refresh that comes less than 60 s after the previous one for the same family. Uses the
   * shared rate limiter as a 1-per-60 s marker (Redis-backed, so it works across API instances). Best effort: it never
   * blocks or fails the refresh.
   */
  private async noteFrequentRefresh(f: TokenFamily, meta: RequestMeta) {
    if (!this.d.log) return;
    const w = EXTENSION_LIMITS.refreshFrequentWindow;
    try {
      const r = await this.d.rateLimiter.consume(`ext:refresh:freq:${f.id}`, w.limit, w.windowMs);
      if (r.allowed) return;
      this.d.log.warn(
        {
          event: 'extension.token.refresh_frequent',
          familyId: f.id,
          organizationId: f.organizationId,
          userId: f.userId,
          extensionId: f.extensionId,
          deviceId: f.deviceId,
          ip: meta.ip ?? null,
          windowSeconds: w.windowMs / 1000,
        },
        'extension refresh sooner than 60s for the same token family',
      );
    } catch {
      // Logging signal only.
    }
  }

  private async liveMember(organizationId: string, userId: string) {
    const m = await this.d.memberships.find(organizationId, userId);
    return !!m && m.deletedAt === null;
  }

  /** POST /auth/extension/pair (cookie + CSRF, checked by the route). */
  async pair(
    caller: { userId: string; activeOrganizationId: string | null },
    body: ExtensionPairRequest,
    meta: RequestMeta,
  ): Promise<ExtensionPairResponse> {
    await this.limit(`pair:user:${caller.userId}`, EXTENSION_LIMITS.pairPerUserMin);
    await this.limit(`pair:user:h:${caller.userId}`, EXTENSION_LIMITS.pairPerUserHour);
    await this.limit(`pair:ip:${clientIpKey(meta.ip)}`, EXTENSION_LIMITS.pairPerIp);
    if (!this.isAllowedExtension(body.extensionId)) throw new ExtensionNotAllowedError();
    const organizationId = caller.activeOrganizationId;
    if (!organizationId) throw new NoActiveOrganizationError();
    const org = await this.d.organizations.findById(organizationId);
    if (!org || !(await this.liveMember(organizationId, caller.userId)))
      throw new NoActiveOrganizationError();
    const pairingCode = this.d.tokens.generate();
    const expiresAt = new Date(this.d.clock.now().getTime() + PAIRING_CODE_TTL_MS);
    await this.d.extensionTokens.savePairing({
      codeHash: this.d.tokens.hash(pairingCode),
      nonce: body.nonce,
      extensionId: body.extensionId,
      deviceId: body.deviceId,
      deviceLabel: body.deviceLabel ?? null,
      userId: caller.userId,
      organizationId,
      expiresAt,
    });
    await this.audit(
      {
        organizationId,
        actorId: caller.userId,
        action: 'extension.pair',
        deviceId: body.deviceId,
        extensionId: body.extensionId,
      },
      meta,
    );
    return {
      pairingCode,
      expiresAt: expiresAt.toISOString(),
      organizationId,
      organizationName: org.name,
    };
  }

  /** POST /auth/extension-token: atomically consumes the pairing code and starts a refresh family. */
  async exchange(body: ExtensionTokenRequest, meta: RequestMeta): Promise<ExtensionTokenResponse> {
    const ipKey = `token:ip:${clientIpKey(meta.ip)}`;
    await this.limit(ipKey, EXTENSION_LIMITS.tokenPerIp);
    const now = this.d.clock.now();
    const p = await this.d.extensionTokens.consumePairing(this.d.tokens.hash(body.pairingCode));
    const ok =
      !!p &&
      p.expiresAt > now &&
      p.nonce === body.nonce &&
      p.extensionId === body.extensionId &&
      p.deviceId === body.deviceId &&
      this.isAllowedExtension(body.extensionId);
    if (!ok || !(await this.liveMember(p.organizationId, p.userId))) {
      // A1.4: a failed nonce or code check counts double.
      await this.limit(ipKey, EXTENSION_LIMITS.tokenPerIp);
      throw new UnauthenticatedError();
    }
    const family: TokenFamily = {
      id: this.d.ids.next(),
      userId: p.userId,
      organizationId: p.organizationId,
      extensionId: p.extensionId,
      deviceId: p.deviceId,
      deviceLabel: p.deviceLabel,
      scopes: [...EXTENSION_SCOPES],
      createdAt: now,
      maxExpiresAt: new Date(now.getTime() + EXTENSION_REFRESH_FAMILY_MAX_LIFETIME_SECONDS * 1000),
      revokedAt: null,
    };
    await this.d.extensionTokens.createFamily(family);
    const pair = await this.issue(family);
    await this.audit(
      {
        organizationId: family.organizationId,
        actorId: family.userId,
        action: 'extension.token.issue',
        deviceId: family.deviceId,
        extensionId: family.extensionId,
        familyId: family.id,
      },
      meta,
    );
    return { ...pair, nonce: body.nonce };
  }

  /** POST /auth/extension/refresh: rotates; a replayed refresh token revokes the whole family (A1.2.3). */
  async refresh(
    body: ExtensionRefreshRequest,
    meta: RequestMeta,
  ): Promise<ExtensionRefreshResponse> {
    await this.limit(`refresh:ip:${clientIpKey(meta.ip)}`, EXTENSION_LIMITS.refreshPerIp);
    // An EMPTY allowlist is a misconfiguration (e.g. EXTENSION_IDS unset or typo'd in a deploy): refuse the refresh
    // BEFORE consumeRefresh, so the token is not burned and the family is not touched. Fixing the config then lets
    // the same refresh token rotate normally, with no false reuse_detected and no revoke.
    if (this.d.extensionIds.length === 0) {
      console.warn(
        'extension refresh refused: extension allowlist is empty; token and families left intact',
        {
          event: 'extension_allowlist_empty',
        },
      );
      throw new UnauthenticatedError();
    }
    const tokenHash = this.d.tokens.hash(body.refreshToken);
    const r = await this.d.extensionTokens.consumeRefresh(tokenHash);
    if (r.status === 'unknown') throw new UnauthenticatedError();
    const f = await this.d.extensionTokens.findFamily(r.familyId);
    if (!f) throw new UnauthenticatedError();
    // An extension id removed from the allowlist (EXTENSION_IDS) can no longer refresh: revoke its family.
    // Checked BEFORE the grace-window replay so a revoked extension cannot replay a just-rotated pair.
    // (The empty-allowlist misconfiguration is refused above, before the token is consumed.)
    if (!this.isAllowedExtension(f.extensionId)) {
      if (!f.revokedAt) {
        await this.revokeFamily(f, 'extension_revoked');
        await this.audit(
          {
            organizationId: f.organizationId,
            actorId: f.userId,
            action: 'extension.token.delisted',
            deviceId: f.deviceId,
            extensionId: f.extensionId,
            familyId: f.id,
          },
          meta,
        );
      }
      throw new UnauthenticatedError();
    }
    if (
      r.status === 'reused' &&
      !f.revokedAt &&
      f.extensionId === body.extensionId &&
      f.deviceId === body.deviceId
    ) {
      // Grace window: the same device re-sent the token it just rotated; hand back the same new pair.
      const again = await this.grace.replay(f.id, tokenHash, body.deviceId, body.refreshToken);
      if (again) return again;
      if (again === null) throw new UnauthenticatedError();
    }
    if (
      r.status === 'reused' ||
      f.extensionId !== body.extensionId ||
      f.deviceId !== body.deviceId
    ) {
      if (!f.revokedAt) {
        await this.revokeFamily(f, 'extension_revoked');
        await this.audit(
          {
            organizationId: f.organizationId,
            actorId: f.userId,
            action: 'extension.token.reuse_detected',
            deviceId: f.deviceId,
            extensionId: f.extensionId,
            familyId: f.id,
          },
          meta,
        );
      }
      throw new UnauthenticatedError();
    }
    const pending = await this.grace.begin(f.id, tokenHash, f.deviceId, body.refreshToken);
    try {
      const pair = await this.rotate(f, meta);
      await pending.resolve(pair);
      return pair;
    } catch (err) {
      await pending.reject();
      throw err;
    }
  }

  private async rotate(f: TokenFamily, meta: RequestMeta): Promise<ExtensionRefreshResponse> {
    await this.limit(`refresh:fam:${f.id}`, EXTENSION_LIMITS.refreshPerFamily);
    await this.noteFrequentRefresh(f, meta);
    const now = this.d.clock.now();
    if (f.revokedAt || f.maxExpiresAt <= now) throw new UnauthenticatedError();
    if (!(await this.liveMember(f.organizationId, f.userId))) {
      await this.revokeFamily(f, 'member_removed');
      throw new UnauthenticatedError();
    }
    const pair = await this.issue(f);
    await this.audit(
      {
        organizationId: f.organizationId,
        actorId: f.userId,
        action: 'extension.token.refresh',
        deviceId: f.deviceId,
        extensionId: f.extensionId,
        familyId: f.id,
      },
      meta,
    );
    return pair;
  }

  /** POST /auth/extension/revoke: revokes the device's family. Idempotent for a known token of this device. */
  async revoke(body: ExtensionRevokeRequest, meta: RequestMeta): Promise<{ revoked: true }> {
    await this.limit(`revoke:ip:${clientIpKey(meta.ip)}`, EXTENSION_LIMITS.revokePerIp);
    const r = await this.d.extensionTokens.peekRefresh(this.d.tokens.hash(body.refreshToken));
    if (r.status === 'unknown') throw new UnauthenticatedError();
    const f = await this.d.extensionTokens.findFamily(r.familyId);
    if (!f || f.extensionId !== body.extensionId || f.deviceId !== body.deviceId)
      throw new UnauthenticatedError();
    await this.limit(`revoke:fam:${f.id}`, EXTENSION_LIMITS.revokePerFamily);
    if (!f.revokedAt) {
      await this.revokeFamily(f, 'extension_revoked');
      await this.audit(
        {
          organizationId: f.organizationId,
          actorId: f.userId,
          action: 'extension.revoke',
          deviceId: f.deviceId,
          extensionId: f.extensionId,
          familyId: f.id,
        },
        meta,
      );
    }
    return { revoked: true };
  }

  async revokeForUser(
    userId: string,
    reason: 'logout' | 'logout_all' | 'password_changed' | 'member_removed' | 'org_switch',
    organizationId?: string,
    opts: RevokeForUserOptions = {},
  ): Promise<void> {
    try {
      for (const f of await this.d.extensionTokens.listFamilies(
        userId,
        this.d.clock.now(),
        organizationId,
      ))
        await this.revokeFamily(f, reason);
    } catch (e) {
      // The user-facing revocation (session, membership) already happened; never fail it here, unless asked.
      if (opts.propagate) throw e;
    }
  }

  private async revokeFamily(
    f: TokenFamily,
    reason:
      | 'extension_revoked'
      | 'logout'
      | 'logout_all'
      | 'password_changed'
      | 'member_removed'
      | 'org_switch',
  ) {
    await this.grace.forget(f.id);
    await this.d.extensionTokens.revokeFamily(f.id, this.d.clock.now());
    await publishRevocation(this.d.revocations, {
      kind: 'session',
      sessionId: f.id,
      userId: f.userId,
      organizationId: f.organizationId,
      reason,
    });
  }

  private async issue(f: TokenFamily): Promise<ExtensionRefreshResponse> {
    const now = this.d.clock.now();
    const expiresAt = new Date(
      Math.min(now.getTime() + EXTENSION_TOKEN_TTL_SECONDS * 1000, f.maxExpiresAt.getTime()),
    );
    const expiresIn = Math.floor((expiresAt.getTime() - now.getTime()) / 1000);
    if (expiresIn < 1) throw new UnauthenticatedError();
    const accessToken = this.d.tokens.generate();
    const refreshToken = this.d.tokens.generate();
    await this.d.extensionTokens.saveAccess(this.d.tokens.hash(accessToken), {
      familyId: f.id,
      userId: f.userId,
      organizationId: f.organizationId,
      scopes: f.scopes,
      expiresAt,
    });
    await this.d.extensionTokens.saveRefresh(
      this.d.tokens.hash(refreshToken),
      f.id,
      f.maxExpiresAt,
    );
    return {
      accessToken,
      refreshToken,
      tokenType: EXTENSION_TOKEN_TYPE,
      audience: EXTENSION_TOKEN_AUDIENCE,
      expiresAt: expiresAt.toISOString(),
      expiresIn,
      refreshExpiresAt: f.maxExpiresAt.toISOString(),
      organizationId: f.organizationId,
      scopes: [...f.scopes],
    };
  }

  /**
   * @meetops/session-verifier ExtensionTokenStore, consulted on every bearer verify. The family's revocation
   * (Redis marker, then Postgres as the authority via DurableExtensionTokenRepository) applies to every access
   * token in it at once, so a revoked token stops working immediately rather than at its expiry. The family
   * must also still belong to the token's user and org, be for an allowlisted extension id, and be inside its
   * absolute lifetime. Lookup errors
   * fail closed (null), never open.
   */
  verifierStore(): ExtensionTokenStore {
    return {
      findByTokenHash: async (tokenHash): Promise<ExtensionTokenRecord | null> => {
        try {
          const a = await this.d.extensionTokens.findAccess(tokenHash);
          if (!a) return null;
          const f = await this.d.extensionTokens.findFamily(a.familyId);
          if (!f || f.userId !== a.userId || f.organizationId !== a.organizationId) return null;
          // Access tokens of an extension id no longer on the allowlist stop working immediately.
          if (!this.isAllowedExtension(f.extensionId)) return null;
          const now = this.d.clock.now();
          return {
            familyId: a.familyId,
            userId: a.userId,
            organizationId: a.organizationId,
            audience: EXTENSION_TOKEN_AUDIENCE,
            scopes: a.scopes,
            expiresAt: f.maxExpiresAt < a.expiresAt ? f.maxExpiresAt : a.expiresAt,
            revokedAt: f.revokedAt ?? (f.maxExpiresAt <= now ? f.maxExpiresAt : null),
          };
        } catch {
          return null;
        }
      },
    };
  }
}
