import {
  NEW_LOCATION_LIMITS,
  buildNewLocationEvent,
  locationKey,
  newLocationReason,
  type NewLocationOutboxEvent,
} from './new-location.js';
import {
  lookupGeo,
  nullGeoIpProvider,
  type GeoFields,
  type GeoIpProvider,
} from '../../../shared/geoip/provider.js';
import type { UserRepository } from '../../users/domain/user.repository.js';
import { normalizeEmail, toPublicUser, type PublicUser } from '../../users/domain/user.js';
import type { Clock, IdGenerator } from '../../../shared/ports.js';
import { DomainError } from '../../../shared/domain-error.js';
import type { LoginLockout, PasswordHasher, RateLimiter, TokenService } from '../domain/ports.js';
import {
  isSessionActive,
  type Session,
  type SessionPolicy,
  type SessionRepository,
} from '../domain/session.js';
import {
  InvalidCredentialsError,
  RateLimitedError,
  UnauthenticatedError,
} from '../domain/errors.js';
import type { AuthMailQueue } from '../domain/mail-jobs.js';
import type { OneTimeTokenPurpose, OneTimeTokenRepository } from '../domain/one-time-token.js';
import { safeAudit, type AuditEvent, type AuditLog } from '../domain/audit.js';
import {
  publishRevocation,
  type AuthRevocationInput,
  type RevocationPublisher,
} from './revocations.js';
import type { MembershipRepository } from '../../organizations/domain/repositories.js';
import type { ExtensionRevoker } from '../../extension-auth/application/extension-auth.service.js';

export interface AuthServiceDeps {
  users: UserRepository;
  sessions: SessionRepository;
  oneTimeTokens: OneTimeTokenRepository;
  hasher: PasswordHasher;
  tokens: TokenService;
  rateLimiter: RateLimiter;
  lockout: LoginLockout;
  mailQueue: AuthMailQueue;
  audit: AuditLog;
  clock: Clock;
  ids: IdGenerator;
  sessionPolicy: SessionPolicy;
  passwordResetTtlMs: number;
  emailVerificationTtlMs: number;
  /** Progressive-delay sleeper for failed logins; inject a no-op/fake in tests. */
  sleep?: (ms: number) => Promise<void>;
  /** ADR-014 local GeoIP provider. Omitted: geo fields stay null. */
  geoIp?: GeoIpProvider;
  /** ADR-011 revocation fan-out to realtime. Omitted: nothing is published. */
  revocations?: RevocationPublisher;
  /**
   * Used at login to pick the session's default active org. Omitted: sessions start with no active org (old
   * behaviour).
   */
  memberships?: Pick<MembershipRepository, 'listByUser'>;
  /** ADR-005 A1.6: also revoke the user's extension token families. */
  extensionRevoker?: ExtensionRevoker;
  /**
   * ADR-013 / mobile PR #262: revoking a session (or all of them) deletes the user's push devices, in the session's
   * active organization or, without one, in every organization the user belongs to.
   */
  pushDeviceRevoker?: PushDeviceRevoker;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface RequestMeta {
  ip: string | null;
  userAgent: string | null;
}

export interface SessionResult {
  user: PublicUser;
  session: Session;
  /** Raw token, returned once for the cookie. Never log it. */
  token: string;
}

const HOUR = 60 * 60 * 1000;
const MIN = 60 * 1000;
export const AUTH_LIMITS = {
  loginPerIp: { limit: 20, windowMs: MIN },
  signupPerIp: { limit: 5, windowMs: HOUR },
  signupPerEmail: { limit: 3, windowMs: HOUR },
  resetRequestPerIp: { limit: 5, windowMs: HOUR },
  resetRequestPerEmail: { limit: 3, windowMs: HOUR },
  resetSubmitPerIp: { limit: 10, windowMs: HOUR },
  verifySubmitPerIp: { limit: 10, windowMs: HOUR },
  resendPerIp: { limit: 5, windowMs: HOUR },
  resendPerEmail: { limit: 3, windowMs: HOUR },
} as const;

export const invalidResetError = () =>
  new DomainError('BAD_REQUEST', 'Reset link is invalid or has expired', 400);
export const invalidVerificationError = () =>
  new DomainError('BAD_REQUEST', 'Verification link is invalid or has expired', 400);

export interface PushDeviceRevoker {
  revokeForUser(userId: string, organizationId?: string | null): Promise<void>;
}

export class AuthService {
  private dummyHash: Promise<string> | null = null;
  constructor(private readonly d: AuthServiceDeps) {}

  private async limit(key: string, l: { limit: number; windowMs: number }) {
    const r = await this.d.rateLimiter.consume(key, l.limit, l.windowMs);
    if (!r.allowed) throw new RateLimitedError(r.retryAfterMs);
  }

  /** Call only after the revocation has been written. */
  private publish(input: AuthRevocationInput) {
    return publishRevocation(this.d.revocations, input);
  }

  private publishSessionRevoked(
    s: Session,
    reason: 'logout' | 'org_switch' | 'role_changed' | 'member_removed',
  ) {
    return this.publish({
      kind: 'session',
      sessionId: s.id,
      userId: s.userId,
      organizationId: s.activeOrganizationId,
      reason,
    });
  }

  private audit(
    e: Omit<AuditEvent, 'ip' | 'userAgent' | 'organizationId'> & { organizationId?: string | null },
    meta?: RequestMeta,
  ) {
    const ip = meta?.ip ?? null;
    return safeAudit(this.d.audit, {
      organizationId: null,
      ip,
      userAgent: meta?.userAgent ?? null,
      geo: this.geo(ip),
      ...e,
    });
  }

  /** ADR-014: local lookup, never throws; private/unknown IPs give all-null fields. */
  private geo(ip: string | null): GeoFields {
    return lookupGeo(this.d.geoIp ?? nullGeoIpProvider, ip);
  }

  /** Creates a token row with an unguessable placeholder hash; the mail worker mints the real token. */
  private async createOneTimeToken(userId: string, purpose: OneTimeTokenPurpose, ttlMs: number) {
    const now = this.d.clock.now();
    return this.d.oneTimeTokens.create({
      id: this.d.ids.next(),
      userId,
      purpose,
      tokenHash: this.d.tokens.hash(this.d.tokens.generate()),
      expiresAt: new Date(now.getTime() + ttlMs),
      usedAt: null,
      createdAt: now,
    });
  }

  /** Enumeration-safe: same 202 whether or not the email exists. Does not start a session. */
  async signup(
    input: { email: string; password: string; name?: string | undefined },
    meta: RequestMeta,
  ) {
    const email = normalizeEmail(input.email);
    await this.limit(`signup:ip:${meta.ip ?? 'unknown'}`, AUTH_LIMITS.signupPerIp);
    await this.limit(`signup:email:${email}`, AUTH_LIMITS.signupPerEmail);
    const passwordHash = await this.d.hasher.hash(input.password);
    const existing = await this.d.users.findByEmail(email);
    if (existing) {
      await this.d.mailQueue.enqueue({ kind: 'account_exists', userId: existing.id });
      return { accepted: true as const };
    }
    const now = this.d.clock.now();
    try {
      const user = await this.d.users.create({
        id: this.d.ids.next(),
        email,
        name: input.name ?? null,
        passwordHash,
        emailVerifiedAt: null,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      });
      const t = await this.createOneTimeToken(
        user.id,
        'email_verification',
        this.d.emailVerificationTtlMs,
      );
      await this.d.mailQueue.enqueue({ kind: 'email_verification', tokenId: t.id });
      await this.audit(
        {
          actorId: user.id,
          action: 'auth.signup',
          targetType: 'user',
          targetId: user.id,
          metadata: {},
        },
        meta,
      );
    } catch {
      // Race on unique email: still respond identically.
    }
    return { accepted: true as const };
  }

  /** Rotates: any presented session is revoked and a new one is issued. */
  async login(
    input: { email: string; password: string },
    meta: RequestMeta,
    currentToken?: string,
  ): Promise<SessionResult> {
    const email = normalizeEmail(input.email);
    await this.limit(`login:ip:${meta.ip ?? 'unknown'}`, AUTH_LIMITS.loginPerIp);
    const lock = await this.d.lockout.isLocked(email);
    if (lock.locked) throw new RateLimitedError(lock.retryAfterMs);

    const user = await this.d.users.findByEmail(email);
    const ok = user
      ? await this.d.hasher.verify(user.passwordHash, input.password)
      : (await this.d.hasher.verify(await this.getDummyHash(), input.password), false);
    if (!user || !ok) {
      // Keyed by normalized email whether or not the account exists (enumeration-safe).
      const { lockedForMs, delayMs } = await this.d.lockout.recordFailure(email);
      const base = {
        actorId: user?.id ?? null,
        targetType: 'user' as const,
        targetId: user?.id ?? null,
      };
      await this.audit(
        { ...base, action: 'auth.login.failure', metadata: { knownUser: !!user } },
        meta,
      );
      if (lockedForMs) {
        await this.audit({ ...base, action: 'auth.lockout', metadata: { lockedForMs } }, meta);
        // Lockout notice (spec §5). Enqueued for unknown emails too (userId null, dropped by the
        // worker) so the response path and timing are identical whether or not the account exists.
        await this.d.mailQueue.enqueue({ kind: 'login_lockout', userId: user?.id ?? null });
      }
      if (delayMs) await (this.d.sleep ?? realSleep)(delayMs);
      throw new InvalidCredentialsError();
    }
    await this.d.lockout.reset(email);
    if (this.d.hasher.needsRehash(user.passwordHash)) {
      await this.d.users.updatePasswordHash(user.id, await this.d.hasher.hash(input.password));
    }
    if (currentToken) {
      const old = await this.revokeByToken(currentToken);
      if (old) await this.publishSessionRevoked(old, 'logout');
    }
    const r = await this.issueSession(
      user.id,
      toPublicUser(user),
      await this.defaultOrganizationId(user.id),
      meta,
      { newLocationAlert: true },
    );
    await this.audit(
      {
        actorId: user.id,
        action: 'auth.login.success',
        targetType: 'session',
        targetId: r.session.id,
        metadata: {},
      },
      meta,
    );
    return r;
  }

  /**
   * Enumeration-safe with timing parity: both paths generate + hash a token and enqueue
   * exactly one job (tokenId null for unknown emails; the worker drops it).
   */
  async requestPasswordReset(rawEmail: string, meta: RequestMeta) {
    const email = normalizeEmail(rawEmail);
    await this.limit(`reset:ip:${meta.ip ?? 'unknown'}`, AUTH_LIMITS.resetRequestPerIp);
    await this.limit(`reset:email:${email}`, AUTH_LIMITS.resetRequestPerEmail);
    const user = await this.d.users.findByEmail(email);
    if (!user) {
      this.d.tokens.hash(this.d.tokens.generate());
      await this.d.mailQueue.enqueue({ kind: 'password_reset', tokenId: null });
      return { accepted: true as const };
    }
    const t = await this.createOneTimeToken(user.id, 'password_reset', this.d.passwordResetTtlMs);
    await this.d.mailQueue.enqueue({ kind: 'password_reset', tokenId: t.id });
    await this.audit(
      {
        actorId: null,
        action: 'auth.password_reset.request',
        targetType: 'user',
        targetId: user.id,
        metadata: {},
      },
      meta,
    );
    return { accepted: true as const };
  }

  /** Atomic single use; on success revokes all sessions and any other outstanding reset tokens. */
  async resetPassword(input: { token: string; password: string }, meta: RequestMeta) {
    await this.limit(`reset:submit:ip:${meta.ip ?? 'unknown'}`, AUTH_LIMITS.resetSubmitPerIp);
    const now = this.d.clock.now();
    const t = await this.d.oneTimeTokens.consume(
      'password_reset',
      this.d.tokens.hash(input.token),
      now,
    );
    if (!t) throw invalidResetError();
    await this.d.users.updatePasswordHash(t.userId, await this.d.hasher.hash(input.password));
    await this.d.sessions.revokeAllForUser(t.userId, now);
    await this.publish({ kind: 'user', userId: t.userId, reason: 'password_changed' });
    await this.d.extensionRevoker?.revokeForUser(t.userId, 'password_changed');
    await this.d.pushDeviceRevoker?.revokeForUser(t.userId);
    await this.d.mailQueue.enqueue({
      kind: 'password_changed',
      userId: t.userId,
      changedAt: now.toISOString(),
    });
    await this.d.oneTimeTokens.invalidateForUser(t.userId, 'password_reset', now);
    const user = await this.d.users.findById(t.userId);
    if (user) await this.d.lockout.reset(user.email);
    await this.audit(
      {
        actorId: t.userId,
        action: 'auth.password_reset.complete',
        targetType: 'user',
        targetId: t.userId,
        metadata: {},
      },
      meta,
    );
  }

  async verifyEmail(token: string, meta: RequestMeta) {
    await this.limit(`verify:ip:${meta.ip ?? 'unknown'}`, AUTH_LIMITS.verifySubmitPerIp);
    const now = this.d.clock.now();
    const t = await this.d.oneTimeTokens.consume(
      'email_verification',
      this.d.tokens.hash(token),
      now,
    );
    if (!t) throw invalidVerificationError();
    await this.d.users.markEmailVerified(t.userId, now);
    await this.d.oneTimeTokens.invalidateForUser(t.userId, 'email_verification', now);
    await this.audit(
      {
        actorId: t.userId,
        action: 'auth.email.verify',
        targetType: 'user',
        targetId: t.userId,
        metadata: {},
      },
      meta,
    );
  }

  /** Enumeration-safe: always resolves the same; only unverified accounts get a new link. */
  async resendVerification(rawEmail: string, meta: RequestMeta) {
    const email = normalizeEmail(rawEmail);
    await this.limit(`resend:ip:${meta.ip ?? 'unknown'}`, AUTH_LIMITS.resendPerIp);
    await this.limit(`resend:email:${email}`, AUTH_LIMITS.resendPerEmail);
    const user = await this.d.users.findByEmail(email);
    if (!user || user.emailVerifiedAt) return { accepted: true as const };
    const now = this.d.clock.now();
    await this.d.oneTimeTokens.invalidateForUser(user.id, 'email_verification', now);
    const t = await this.createOneTimeToken(
      user.id,
      'email_verification',
      this.d.emailVerificationTtlMs,
    );
    await this.d.mailQueue.enqueue({ kind: 'email_verification', tokenId: t.id });
    await this.audit(
      {
        actorId: null,
        action: 'auth.email.verification_resend',
        targetType: 'user',
        targetId: user.id,
        metadata: {},
      },
      meta,
    );
    return { accepted: true as const };
  }

  async logout(token: string | undefined, meta: RequestMeta): Promise<void> {
    if (!token) return;
    const s = await this.revokeByToken(token);
    if (s) await this.publishSessionRevoked(s, 'logout');
    if (s) await this.d.extensionRevoker?.revokeForUser(s.userId, 'logout');
    if (s) await this.d.pushDeviceRevoker?.revokeForUser(s.userId, s.activeOrganizationId);
    if (s)
      await this.audit(
        {
          actorId: s.userId,
          action: 'auth.logout',
          targetType: 'session',
          targetId: s.id,
          metadata: {},
        },
        meta,
      );
  }

  async logoutAll(userId: string, meta: RequestMeta) {
    await this.d.sessions.revokeAllForUser(userId, this.d.clock.now());
    await this.publish({ kind: 'user', userId, reason: 'logout_all' });
    await this.d.extensionRevoker?.revokeForUser(userId, 'logout_all');
    await this.d.pushDeviceRevoker?.revokeForUser(userId);
    await this.audit(
      {
        actorId: userId,
        action: 'auth.logout_all',
        targetType: 'user',
        targetId: userId,
        metadata: {},
      },
      meta,
    );
  }

  async listSessions(userId: string) {
    return this.d.sessions.listActiveForUser(userId, this.d.clock.now());
  }

  /** Revoke one of the caller's own sessions. Unknown or someone else's → 404. */
  async revokeSession(userId: string, sessionId: string, meta: RequestMeta) {
    const s = await this.d.sessions.findById(sessionId);
    if (!s || s.userId !== userId || s.revokedAt)
      throw new DomainError('NOT_FOUND', 'Session not found', 404);
    await this.d.sessions.revoke(s.id, this.d.clock.now());
    await this.publishSessionRevoked(s, 'logout');
    await this.d.pushDeviceRevoker?.revokeForUser(userId, s.activeOrganizationId);
    await this.audit(
      {
        actorId: userId,
        action: 'auth.session.revoke',
        targetType: 'session',
        targetId: s.id,
        metadata: {},
      },
      meta,
    );
  }

  /** Used on privilege changes of another user (role change / removal). */
  async revokeAllSessionsFor(userId: string) {
    await this.d.sessions.revokeAllForUser(userId, this.d.clock.now());
  }

  /** Resolve the session (idle + absolute timeouts) and slide last_seen_at. */
  async authenticate(
    token: string | undefined,
    meta?: RequestMeta,
  ): Promise<{ user: PublicUser; session: Session }> {
    if (!token) throw new UnauthenticatedError();
    const session = await this.d.sessions.findByTokenHash(this.d.tokens.hash(token));
    const now = this.d.clock.now();
    if (!session || !isSessionActive(session, now, this.d.sessionPolicy))
      throw new UnauthenticatedError();
    const user = await this.d.users.findById(session.userId);
    if (!user) throw new UnauthenticatedError();
    await this.d.sessions.touch(session.id, now);
    // ADR-014: look up again only when the client IP changed (not on every request).
    if (meta?.ip && meta.ip !== session.ip && this.d.sessions.updateIp) {
      const geo = this.geo(meta.ip);
      await this.d.sessions.updateIp(session.id, meta.ip, geo);
      return {
        user: toPublicUser(user),
        session: { ...session, lastSeenAt: now, ip: meta.ip, geo },
      };
    }
    return { user: toPublicUser(user), session: { ...session, lastSeenAt: now } };
  }

  /**
   * Privilege change (org switch/create, own role change or leave): revoke the old session, issue a
   * new one, and tell realtime the old session is gone.
   */
  async rotate(
    session: Session,
    user: PublicUser,
    activeOrganizationId: string | null,
    meta: RequestMeta,
    reason: 'org_switch' | 'role_changed' | 'member_removed' = 'org_switch',
  ) {
    await this.d.sessions.revoke(session.id, this.d.clock.now());
    await this.publishSessionRevoked(session, reason);
    return this.issueSession(session.userId, user, activeOrganizationId, meta);
  }

  private async revokeByToken(token: string) {
    const session = await this.d.sessions.findByTokenHash(this.d.tokens.hash(token));
    if (session && session.revokedAt === null) {
      await this.d.sessions.revoke(session.id, this.d.clock.now());
      return session;
    }
    return null;
  }

  private getDummyHash() {
    this.dummyHash ??= this.d.hasher.hash('dummy-password-for-timing-equalization');
    return this.dummyHash;
  }

  /**
   * Default active org for a new session: the last-used org if that membership is still live, else the user's first
   * live membership (oldest createdAt, then organizationId, so the choice is deterministic), else null.
   */
  private async defaultOrganizationId(userId: string): Promise<string | null> {
    if (!this.d.memberships) return null;
    const live = (await this.d.memberships.listByUser(userId)).filter((m) => m.deletedAt === null);
    if (live.length === 0) return null;
    const last = await this.d.sessions.findLastActiveOrganizationId(userId);
    if (last && live.some((m) => m.organizationId === last)) return last;
    live.sort(
      (a, b) =>
        a.createdAt.getTime() - b.createdAt.getTime() ||
        a.organizationId.localeCompare(b.organizationId),
    );
    return live[0]!.organizationId;
  }

  private async issueSession(
    userId: string,
    user: PublicUser,
    activeOrganizationId: string | null,
    meta: RequestMeta,
    opts: { newLocationAlert?: boolean } = {},
  ): Promise<SessionResult> {
    const token = this.d.tokens.generate();
    const now = this.d.clock.now();
    const geo = this.geo(meta.ip);
    const draft: Session = {
      id: this.d.ids.next(),
      userId,
      tokenHash: this.d.tokens.hash(token),
      activeOrganizationId,
      createdAt: now,
      lastSeenAt: now,
      expiresAt: new Date(now.getTime() + this.d.sessionPolicy.absoluteTimeoutMs),
      revokedAt: null,
      ip: meta.ip,
      userAgent: meta.userAgent,
      geo,
    };
    const event = opts.newLocationAlert
      ? await this.newLocationEvent(userId, draft, activeOrganizationId)
      : null;
    const session =
      event && this.d.sessions.createWithOutbox
        ? await this.d.sessions.createWithOutbox(draft, event)
        : await this.d.sessions.create(draft);
    return { user, session, token };
  }

  /**
   * ADR-014: `auth.new_location_signin` when this sign-in's country (or region) was never seen in the user's earlier
   * sessions. Needs an active organization (outbox and notifications are org-scoped, ADR-013). Deduped per
   * (country, region) and rate-limited per user; a limiter or history failure never blocks sign-in.
   */
  private async newLocationEvent(
    userId: string,
    s: Session,
    organizationId: string | null,
  ): Promise<NewLocationOutboxEvent | null> {
    const geo = s.geo;
    if (!organizationId || !geo?.geoCountryCode || !this.d.sessions.knownLocations) return null;
    try {
      const reason = newLocationReason(geo, await this.d.sessions.knownLocations(userId));
      if (!reason) return null;
      const where = locationKey(geo.geoCountryCode, geo.geoRegion);
      const L = NEW_LOCATION_LIMITS;
      // Per-user cap first (#292 L-3): a capped user must not burn this location's 24 h slot.
      const perUser = await this.d.rateLimiter.consume(
        `newloc:${userId}`,
        L.perUser.limit,
        L.perUser.windowMs,
      );
      if (!perUser.allowed) return null;
      const perLocation = await this.d.rateLimiter.consume(
        `newloc:${userId}:${where}`,
        L.perLocation.limit,
        L.perLocation.windowMs,
      );
      if (!perLocation.allowed) return null;
      return buildNewLocationEvent({ organizationId, userId, sessionId: s.id, geo, reason });
    } catch {
      return null;
    }
  }
}
