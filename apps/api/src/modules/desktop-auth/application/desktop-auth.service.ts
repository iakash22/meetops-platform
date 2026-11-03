import { createHash, timingSafeEqual } from 'node:crypto';
import {
  DESKTOP_AUTHORIZATION_CODE_TTL_SECONDS,
  DESKTOP_REFRESH_FAMILY_MAX_LIFETIME_SECONDS,
  DESKTOP_SCOPES,
  DESKTOP_TOKEN_AUDIENCE,
  DESKTOP_TOKEN_TTL_SECONDS,
  DESKTOP_TOKEN_TYPE,
  type DesktopAuthorizeRequest,
  type DesktopAuthorizeResponse,
  type DesktopRefreshRequest,
  type DesktopRefreshResponse,
  type DesktopRevokeRequest,
  type DesktopScope,
  type DesktopSwitchOrgRequest,
  type DesktopTokenRequest,
  type ExtensionScope,
} from '@meetops/contracts';
import type { ExtensionTokenRecord, ExtensionTokenStore } from '@meetops/session-verifier';
import { DomainError } from '../../../shared/domain-error.js';
import type { Clock, IdGenerator } from '../../../shared/ports.js';
import { safeAudit, type AuditAction, type AuditLog } from '../../auth/domain/audit.js';
import { RateLimitedError, UnauthenticatedError } from '../../auth/domain/errors.js';
import type { RateLimiter, TokenService } from '../../auth/domain/ports.js';
import type { RequestMeta } from '../../auth/application/auth.service.js';
import { publishRevocation, type RevocationPublisher } from '../../auth/application/revocations.js';
import type {
  MembershipRepository,
  OrganizationRepository,
} from '../../organizations/domain/repositories.js';
import type {
  ExtensionTokenRepository,
  TokenFamily,
} from '../../extension-auth/domain/extension-token.js';
import type { ExtensionRevoker } from '../../extension-auth/application/extension-auth.service.js';
import { RefreshGraceCache } from '../../auth/application/refresh-grace.js';

/**
 * Client id stored in the shared token-family shape (`TokenFamily.extensionId`). Every desktop family carries it, and
 * every desktop lookup checks it, so an extension family can never be used as a desktop one or the reverse.
 */
export const DESKTOP_CLIENT_ID = 'meetops-desktop';

const MIN = 60_000;
const HOUR = 60 * MIN;
/** Starting values mirroring EXTENSION_LIMITS (DevOps tunes them). */
export const DESKTOP_LIMITS = {
  authorizePerUserMin: { limit: 5, windowMs: MIN },
  authorizePerUserHour: { limit: 20, windowMs: HOUR },
  authorizePerIp: { limit: 10, windowMs: MIN },
  tokenPerIp: { limit: 10, windowMs: MIN },
  refreshPerFamily: { limit: 10, windowMs: MIN },
  refreshPerIp: { limit: 60, windowMs: MIN },
  revokePerFamily: { limit: 10, windowMs: MIN },
  revokePerIp: { limit: 60, windowMs: MIN },
  switchPerFamily: { limit: 10, windowMs: MIN },
  switchPerIp: { limit: 30, windowMs: MIN },
} as const;

export class DesktopNoActiveOrganizationError extends DomainError {
  constructor() {
    super('FORBIDDEN', 'Select an organization before signing in to the desktop app', 403);
  }
}

export interface DesktopAuthDeps {
  /** Separate store instance from the extension one (its own Redis prefix), so the two never share keys. */
  desktopTokens: ExtensionTokenRepository;
  tokens: TokenService;
  rateLimiter: RateLimiter;
  audit: AuditLog;
  clock: Clock;
  ids: IdGenerator;
  organizations: OrganizationRepository;
  memberships: MembershipRepository;
  revocations?: RevocationPublisher;
}

type Limit = { limit: number; windowMs: number };
type RevokeReason =
  | 'desktop_revoked'
  | 'logout'
  | 'logout_all'
  | 'password_changed'
  | 'member_removed'
  | 'org_switch';

/** RFC 7636 S256: base64url(SHA-256(verifier)), compared in constant time. */
export function pkceS256Matches(verifier: string, challenge: string): boolean {
  const a = Buffer.from(createHash('sha256').update(verifier, 'ascii').digest('base64url'));
  const b = Buffer.from(challenge);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * ADR-012 (Proposed; amendment PR #192 awaiting sign-off) desktop sign-in: authorization code + PKCE S256 with a
 * loopback redirect, opaque `desktop` tokens, rotating refresh with reuse detection, revocation and org switch.
 * Only hashes are stored. The authorization code reuses the extension pairing record shape: `nonce` holds the PKCE
 * challenge and `extensionId` the exact redirect URI; consume is atomic (GETDEL) so the code is single-use, and it is
 * consumed on every attempt, including a mismatch. Every credential failure is the same 401.
 */
export class DesktopAuthService implements ExtensionRevoker {
  /** ~10 s grace for re-presenting the immediately previous refresh token from the same device. */
  private readonly grace = new RefreshGraceCache<DesktopRefreshResponse>();
  constructor(private readonly d: DesktopAuthDeps) {}

  private async limit(key: string, l: Limit, cost = 1) {
    for (let i = 0; i < cost; i++) {
      const r = await this.d.rateLimiter.consume(`desk:${key}`, l.limit, l.windowMs);
      if (!r.allowed) throw new RateLimitedError(r.retryAfterMs);
    }
  }

  private audit(
    e: {
      organizationId: string;
      actorId: string;
      action: AuditAction;
      deviceId: string;
      familyId?: string;
    },
    meta: RequestMeta,
  ) {
    return safeAudit(this.d.audit, {
      organizationId: e.organizationId,
      actorId: e.actorId,
      action: e.action,
      targetType: 'desktop_device',
      targetId: e.deviceId,
      metadata: { familyId: e.familyId ?? null },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
  }

  private async liveMember(organizationId: string, userId: string) {
    const m = await this.d.memberships.find(organizationId, userId);
    return !!m && m.deletedAt === null;
  }

  /** POST /auth/desktop/authorize (cookie + CSRF, checked by the route). */
  async authorize(
    caller: { userId: string; activeOrganizationId: string | null },
    body: DesktopAuthorizeRequest,
    meta: RequestMeta,
  ): Promise<DesktopAuthorizeResponse> {
    await this.limit(`auth:user:${caller.userId}`, DESKTOP_LIMITS.authorizePerUserMin);
    await this.limit(`auth:user:h:${caller.userId}`, DESKTOP_LIMITS.authorizePerUserHour);
    await this.limit(`auth:ip:${meta.ip ?? 'unknown'}`, DESKTOP_LIMITS.authorizePerIp);
    const organizationId = caller.activeOrganizationId;
    if (!organizationId) throw new DesktopNoActiveOrganizationError();
    const org = await this.d.organizations.findById(organizationId);
    if (!org || !(await this.liveMember(organizationId, caller.userId)))
      throw new DesktopNoActiveOrganizationError();
    const authorizationCode = this.d.tokens.generate();
    const expiresAt = new Date(
      this.d.clock.now().getTime() + DESKTOP_AUTHORIZATION_CODE_TTL_SECONDS * 1000,
    );
    await this.d.desktopTokens.savePairing({
      codeHash: this.d.tokens.hash(authorizationCode),
      nonce: body.codeChallenge,
      extensionId: body.redirectUri,
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
        action: 'desktop.authorize',
        deviceId: body.deviceId,
      },
      meta,
    );
    return {
      authorizationCode,
      expiresAt: expiresAt.toISOString(),
      organizationId,
      organizationName: org.name,
    };
  }

  /** POST /auth/desktop/token: consumes the code, checks PKCE, redirect URI and device, starts a family. */
  async exchange(body: DesktopTokenRequest, meta: RequestMeta): Promise<DesktopRefreshResponse> {
    const ipKey = `token:ip:${meta.ip ?? 'unknown'}`;
    await this.limit(ipKey, DESKTOP_LIMITS.tokenPerIp);
    const now = this.d.clock.now();
    const p = await this.d.desktopTokens.consumePairing(this.d.tokens.hash(body.authorizationCode));
    const ok =
      !!p &&
      p.expiresAt > now &&
      p.extensionId === body.redirectUri &&
      p.deviceId === body.deviceId &&
      pkceS256Matches(body.codeVerifier, p.nonce);
    if (!ok || !(await this.liveMember(p.organizationId, p.userId))) {
      // A failed code or verifier check counts double (as ADR-005 A1.4).
      await this.limit(ipKey, DESKTOP_LIMITS.tokenPerIp);
      throw new UnauthenticatedError();
    }
    const family = this.newFamily(
      p.userId,
      p.organizationId,
      p.deviceId,
      p.deviceLabel,
      now,
      new Date(now.getTime() + DESKTOP_REFRESH_FAMILY_MAX_LIFETIME_SECONDS * 1000),
    );
    await this.d.desktopTokens.createFamily(family);
    const pair = await this.issue(family);
    await this.audit(
      {
        organizationId: family.organizationId,
        actorId: family.userId,
        action: 'desktop.token.issue',
        deviceId: family.deviceId,
        familyId: family.id,
      },
      meta,
    );
    return pair;
  }

  private newFamily(
    userId: string,
    organizationId: string,
    deviceId: string,
    deviceLabel: string | null,
    now: Date,
    maxExpiresAt: Date,
  ): TokenFamily {
    return {
      id: this.d.ids.next(),
      userId,
      organizationId,
      extensionId: DESKTOP_CLIENT_ID,
      deviceId,
      deviceLabel,
      // The shared family shape is typed with extension scopes; desktop scopes are stored as-is.
      scopes: [...DESKTOP_SCOPES] as unknown as ExtensionScope[],
      createdAt: now,
      maxExpiresAt,
      revokedAt: null,
    };
  }

  /**
   * Consumes a refresh token for this device. Reuse, or a token from another device or client, revokes the family
   * (desktop_revoked) and fails 401.
   */
  private async consume(
    refreshToken: string,
    deviceId: string,
    meta: RequestMeta,
  ): Promise<TokenFamily>;
  private async consume(
    refreshToken: string,
    deviceId: string,
    meta: RequestMeta,
    allowGrace: true,
  ): Promise<TokenFamily | { replay: DesktopRefreshResponse }>;
  private async consume(
    refreshToken: string,
    deviceId: string,
    meta: RequestMeta,
    allowGrace = false,
  ): Promise<TokenFamily | { replay: DesktopRefreshResponse }> {
    const tokenHash = this.d.tokens.hash(refreshToken);
    const r = await this.d.desktopTokens.consumeRefresh(tokenHash);
    if (r.status === 'unknown') throw new UnauthenticatedError();
    const f = await this.d.desktopTokens.findFamily(r.familyId);
    if (!f || f.extensionId !== DESKTOP_CLIENT_ID) throw new UnauthenticatedError();
    if (allowGrace && r.status === 'reused' && !f.revokedAt && f.deviceId === deviceId) {
      // Grace window: the same device re-sent the token it just rotated; hand back the same new pair.
      const again = this.grace.replay(f.id, tokenHash, deviceId, this.d.clock.now().getTime());
      if (again) {
        try {
          return { replay: await again };
        } catch {
          throw new UnauthenticatedError();
        }
      }
    }
    if (r.status === 'reused' || f.deviceId !== deviceId) {
      if (!f.revokedAt) {
        await this.revokeFamily(f, 'desktop_revoked');
        await this.audit(
          {
            organizationId: f.organizationId,
            actorId: f.userId,
            action: 'desktop.token.reuse_detected',
            deviceId: f.deviceId,
            familyId: f.id,
          },
          meta,
        );
      }
      throw new UnauthenticatedError();
    }
    if (f.revokedAt || f.maxExpiresAt <= this.d.clock.now()) throw new UnauthenticatedError();
    return f;
  }

  /** POST /auth/desktop/refresh. */
  async refresh(body: DesktopRefreshRequest, meta: RequestMeta): Promise<DesktopRefreshResponse> {
    await this.limit(`refresh:ip:${meta.ip ?? 'unknown'}`, DESKTOP_LIMITS.refreshPerIp);
    const consumed = await this.consume(body.refreshToken, body.deviceId, meta, true);
    if ('replay' in consumed) return consumed.replay;
    const f = consumed;
    const pending = this.grace.begin(
      f.id,
      this.d.tokens.hash(body.refreshToken),
      f.deviceId,
      this.d.clock.now().getTime(),
    );
    try {
      const pair = await this.rotate(f, meta);
      pending.resolve(pair);
      return pair;
    } catch (err) {
      pending.reject();
      throw err;
    }
  }

  private async rotate(f: TokenFamily, meta: RequestMeta): Promise<DesktopRefreshResponse> {
    await this.limit(`refresh:fam:${f.id}`, DESKTOP_LIMITS.refreshPerFamily);
    if (!(await this.liveMember(f.organizationId, f.userId))) {
      await this.revokeFamily(f, 'member_removed');
      throw new UnauthenticatedError();
    }
    const pair = await this.issue(f);
    await this.audit(
      {
        organizationId: f.organizationId,
        actorId: f.userId,
        action: 'desktop.token.refresh',
        deviceId: f.deviceId,
        familyId: f.id,
      },
      meta,
    );
    return pair;
  }

  /** POST /auth/desktop/revoke: idempotent for a known token of this device; works after access expiry. */
  async revoke(body: DesktopRevokeRequest, meta: RequestMeta): Promise<{ revoked: true }> {
    await this.limit(`revoke:ip:${meta.ip ?? 'unknown'}`, DESKTOP_LIMITS.revokePerIp);
    const r = await this.d.desktopTokens.peekRefresh(this.d.tokens.hash(body.refreshToken));
    if (r.status === 'unknown') throw new UnauthenticatedError();
    const f = await this.d.desktopTokens.findFamily(r.familyId);
    if (!f || f.extensionId !== DESKTOP_CLIENT_ID || f.deviceId !== body.deviceId)
      throw new UnauthenticatedError();
    await this.limit(`revoke:fam:${f.id}`, DESKTOP_LIMITS.revokePerFamily);
    if (!f.revokedAt) {
      await this.revokeFamily(f, 'desktop_revoked');
      await this.audit(
        {
          organizationId: f.organizationId,
          actorId: f.userId,
          action: 'desktop.revoke',
          deviceId: f.deviceId,
          familyId: f.id,
        },
        meta,
      );
    }
    return { revoked: true };
  }

  /**
   * POST /auth/desktop/switch-org: consumes the refresh token, requires a live membership in the target org (else 404,
   * ADR-004), revokes the old family (org_switch) and starts a new one. The new family keeps the old absolute expiry,
   * so switching never extends the 30-day lifetime.
   */
  async switchOrg(
    body: DesktopSwitchOrgRequest,
    meta: RequestMeta,
  ): Promise<DesktopRefreshResponse> {
    await this.limit(`switch:ip:${meta.ip ?? 'unknown'}`, DESKTOP_LIMITS.switchPerIp);
    // Check the target first without consuming, so a 404 leaves the caller's refresh token usable.
    const peek = await this.d.desktopTokens.peekRefresh(this.d.tokens.hash(body.refreshToken));
    if (peek.status === 'ok') {
      const pf = await this.d.desktopTokens.findFamily(peek.familyId);
      if (pf && pf.extensionId === DESKTOP_CLIENT_ID && pf.deviceId === body.deviceId) {
        const org = await this.d.organizations.findById(body.organizationId);
        if (!org || !(await this.liveMember(body.organizationId, pf.userId)))
          throw new DomainError('NOT_FOUND', 'Not found', 404);
      }
    }
    const f = await this.consume(body.refreshToken, body.deviceId, meta);
    await this.limit(`switch:fam:${f.id}`, DESKTOP_LIMITS.switchPerFamily);
    if (!(await this.liveMember(f.organizationId, f.userId))) {
      await this.revokeFamily(f, 'member_removed');
      throw new UnauthenticatedError();
    }
    if (!(await this.liveMember(body.organizationId, f.userId))) {
      await this.revokeFamily(f, 'desktop_revoked');
      throw new DomainError('NOT_FOUND', 'Not found', 404);
    }
    await this.revokeFamily(f, 'org_switch');
    const now = this.d.clock.now();
    const next = this.newFamily(
      f.userId,
      body.organizationId,
      f.deviceId,
      f.deviceLabel,
      now,
      f.maxExpiresAt,
    );
    await this.d.desktopTokens.createFamily(next);
    const pair = await this.issue(next);
    await this.audit(
      {
        organizationId: next.organizationId,
        actorId: next.userId,
        action: 'desktop.org_switch',
        deviceId: next.deviceId,
        familyId: next.id,
      },
      meta,
    );
    return pair;
  }

  async revokeForUser(
    userId: string,
    reason: 'logout' | 'logout_all' | 'password_changed' | 'member_removed' | 'org_switch',
    organizationId?: string,
  ): Promise<void> {
    try {
      for (const f of await this.d.desktopTokens.listFamilies(
        userId,
        this.d.clock.now(),
        organizationId,
      ))
        if (f.extensionId === DESKTOP_CLIENT_ID) await this.revokeFamily(f, reason);
    } catch {
      // Never fail the user-facing revocation here.
    }
  }

  private async revokeFamily(f: TokenFamily, reason: RevokeReason) {
    this.grace.forget(f.id);
    await this.d.desktopTokens.revokeFamily(f.id, this.d.clock.now());
    await publishRevocation(this.d.revocations, {
      kind: 'session',
      sessionId: f.id,
      userId: f.userId,
      organizationId: f.organizationId,
      reason,
    });
  }

  private async issue(f: TokenFamily): Promise<DesktopRefreshResponse> {
    const now = this.d.clock.now();
    const expiresAt = new Date(
      Math.min(now.getTime() + DESKTOP_TOKEN_TTL_SECONDS * 1000, f.maxExpiresAt.getTime()),
    );
    const expiresIn = Math.floor((expiresAt.getTime() - now.getTime()) / 1000);
    if (expiresIn < 1) throw new UnauthenticatedError();
    const accessToken = this.d.tokens.generate();
    const refreshToken = this.d.tokens.generate();
    await this.d.desktopTokens.saveAccess(this.d.tokens.hash(accessToken), {
      familyId: f.id,
      userId: f.userId,
      organizationId: f.organizationId,
      scopes: f.scopes,
      expiresAt,
    });
    await this.d.desktopTokens.saveRefresh(this.d.tokens.hash(refreshToken), f.id, f.maxExpiresAt);
    return {
      accessToken,
      refreshToken,
      tokenType: DESKTOP_TOKEN_TYPE,
      audience: DESKTOP_TOKEN_AUDIENCE,
      expiresAt: expiresAt.toISOString(),
      expiresIn,
      refreshExpiresAt: f.maxExpiresAt.toISOString(),
      organizationId: f.organizationId,
      scopes: [...f.scopes] as unknown as DesktopScope[],
    };
  }

  /** Bearer store for @meetops/session-verifier with audience `desktop`. Lookup errors fail closed (null). */
  verifierStore(): ExtensionTokenStore {
    return {
      findByTokenHash: async (tokenHash): Promise<ExtensionTokenRecord | null> => {
        try {
          const a = await this.d.desktopTokens.findAccess(tokenHash);
          if (!a) return null;
          const f = await this.d.desktopTokens.findFamily(a.familyId);
          if (
            !f ||
            f.extensionId !== DESKTOP_CLIENT_ID ||
            f.userId !== a.userId ||
            f.organizationId !== a.organizationId
          )
            return null;
          const now = this.d.clock.now();
          return {
            familyId: a.familyId,
            userId: a.userId,
            organizationId: a.organizationId,
            audience: DESKTOP_TOKEN_AUDIENCE,
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

/** Looks a bearer hash up in each store in order (hashes of random 256-bit tokens never collide). */
export function combineBearerStores(...stores: ExtensionTokenStore[]): ExtensionTokenStore {
  return {
    findByTokenHash: async (h) => {
      for (const s of stores) {
        const r = await s.findByTokenHash(h);
        if (r) return r;
      }
      return null;
    },
  };
}

/** Fans a user revocation out to every revoker (extension and desktop). */
export function combineRevokers(...rs: ExtensionRevoker[]): ExtensionRevoker {
  return {
    async revokeForUser(userId, reason, organizationId) {
      for (const r of rs) await r.revokeForUser(userId, reason, organizationId);
    },
  };
}
