import { clientIpKey } from '../../../shared/rate-limit-core.js';
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
import { DuplicateEmailError } from '../../users/domain/errors.js';
import {
  normalizeEmail,
  toPublicUser,
  type PublicUser,
  type User,
} from '../../users/domain/user.js';
import { googleEmailProven, type GoogleIdentity } from './google-oidc.js';
import type { Clock, IdGenerator } from '../../../shared/ports.js';
import { DomainError } from '../../../shared/domain-error.js';
import type {
  AccountClaimStore,
  LoginLockout,
  PasswordHasher,
  RateLimiter,
  TokenService,
} from '../domain/ports.js';
import { sequentialAccountClaims } from './account-claims.js';
import type {
  TakeoverFollowUpJob,
  TakeoverFollowUpKind,
  TakeoverFollowUpQueue,
  TakeoverFollowUpRunner,
} from '../domain/takeover-follow-up.js';
import {
  isSessionActive,
  type Session,
  type SessionAuthLevel,
  type SessionPolicy,
  type SessionRepository,
} from '../domain/session.js';
import {
  InvalidCredentialsError,
  RateLimitedError,
  UnauthenticatedError,
  CredentialStoreUnavailableError,
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
  /**
   * OIDC review X1: credential takeover + session revocation in one unit. Wiring passes the Prisma store (one
   * transaction); without one, the port-based sequential fallback is used (dev/test).
   */
  accountClaims?: AccountClaimStore;
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
  /** Structured log for failures that must not fail the request (takeover follow-ups). Omitted: silent. */
  log?: { error(obj: Record<string, unknown>, msg: string): void };
  /**
   * Durable queue for takeover follow-ups that still failed after the in-request attempts (#463 review: BullMQ when
   * AUTH_MAIL_QUEUE=bullmq). Omitted (dev/test), or when an enqueue fails: the in-process `scheduleRetry` fallback.
   */
  takeoverFollowUps?: TakeoverFollowUpQueue;
  /**
   * Fallback deferred retry, used only without `takeoverFollowUps` or when enqueueing fails. Default: an unref'd timer
   * in this process (lost on restart). Tests inject a synchronous queue.
   */
  scheduleRetry?: (run: () => Promise<void>, delayMs: number) => void;
}

/** NB-R3-3: how recent a same-client successor session must be to count as the winner of a concurrent rotation. */
const ROTATION_RACE_WINDOW_MS = 30_000;
/** NB-R3-3: re-checks for the winner's session (it is inserted just after the winner's revoke). */
const ROTATION_SUCCESSOR_POLLS = 5;
const ROTATION_SUCCESSOR_POLL_MS = 100;

/** #459 NB-R3-2: in-process fallback retries of takeover follow-ups (no durable queue, or enqueue failed). */
export const TAKEOVER_FOLLOW_UP_RETRY_DELAYS_MS = [5_000, 30_000, 120_000] as const;

const defaultScheduleRetry = (run: () => Promise<void>, delayMs: number) => {
  const t = setTimeout(() => void run(), delayMs);
  t.unref?.();
};

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

export type GoogleSignInOutcome =
  /**
   * `verifyLink` (OIDC review N-7): Google did not prove the address of the account it just created, so `sub` is NOT
   * linked yet. The caller keeps it in this browser and passes it to verifyEmail(), which links it only when the
   * verification link is opened in this browser's live Google session.
   */
  | { kind: 'session'; result: SessionResult; verifyLink?: PendingGoogleLink }
  | { kind: 'unverified_local' }
  /**
   * OIDC review M-2: Google did not prove the address, but a verified local account owns it. Linking needs proof of
   * that account (its password): the caller remembers `{ userId, sub }` for a short while and passes it to login().
   */
  | { kind: 'link_required'; pending: PendingGoogleLink }
  | { kind: 'rejected' };

/** A Google subject waiting to be linked once the account's own password is entered (login()). */
type AccountCredentials = NonNullable<Awaited<ReturnType<UserRepository['readCredentials']>>>;

export interface PendingGoogleLink {
  userId: string;
  sub: string;
}

function googleEmail(email: string): string | null {
  const normalized = normalizeEmail(email);
  if (normalized.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) return null;
  return normalized;
}

function googleSub(sub: string): string | null {
  return /^[A-Za-z0-9_-]{1,255}$/.test(sub) ? sub : null;
}

function googleName(name: string | null): string | null {
  if (!name) return null;
  let cleaned = '';
  for (let i = 0; i < name.length; i++) {
    const code = name.charCodeAt(i);
    if (code > 0x1f && code !== 0x7f) cleaned += name[i];
  }
  cleaned = cleaned.trim().slice(0, 200);
  return cleaned.length > 0 ? cleaned : null;
}

const HOUR = 60 * 60 * 1000;
const MIN = 60 * 1000;
export const AUTH_LIMITS = {
  loginPerIp: { limit: 20, windowMs: MIN },
  googlePerIp: { limit: 20, windowMs: MIN },
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
/** Retries an idempotent follow-up step; false when every attempt failed. */
async function retryIdempotent(step: () => Promise<unknown>, attempts = 3): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    try {
      await step();
      return true;
    } catch {
      /* try again */
    }
  }
  return false;
}

export const invalidVerificationError = () =>
  new DomainError('BAD_REQUEST', 'Verification link is invalid or has expired', 400);

export interface PushDeviceRevoker {
  revokeForUser(userId: string, organizationId?: string | null): Promise<void>;
}

export class AuthService implements TakeoverFollowUpRunner {
  private dummyHash: Promise<string> | null = null;
  private readonly claims: AccountClaimStore;
  constructor(private readonly d: AuthServiceDeps) {
    this.claims = d.accountClaims ?? sequentialAccountClaims(d.users, d.sessions);
  }

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
    await this.limit(`signup:ip:${clientIpKey(meta.ip)}`, AUTH_LIMITS.signupPerIp);
    await this.limit(`signup:email:${email}`, AUTH_LIMITS.signupPerEmail);
    const passwordHash = await this.d.hasher.hash(input.password);
    const existing = await this.d.users.findByEmail(email);
    // N-1 residual: `binding` marks this browser as the one that chose the password (see verifyEmail). A taken email
    // gets a random value of the same shape, so the response stays enumeration-safe.
    if (existing) {
      await this.d.mailQueue.enqueue({ kind: 'account_exists', userId: existing.id });
      return { accepted: true as const, binding: this.d.ids.next() };
    }
    const now = this.d.clock.now();
    let binding = this.d.ids.next();
    try {
      const user = await this.d.users.create({
        id: binding,
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
      // Race on unique email: still respond identically (and bind to nothing real).
      binding = this.d.ids.next();
    }
    return { accepted: true as const, binding };
  }

  /** Rotates: any presented session is revoked and a new one is issued. */
  async login(
    input: { email: string; password: string },
    meta: RequestMeta,
    currentToken?: string,
    pendingGoogleLink?: PendingGoogleLink | null,
  ): Promise<SessionResult> {
    const email = normalizeEmail(input.email);
    await this.limit(`login:ip:${clientIpKey(meta.ip)}`, AUTH_LIMITS.loginPerIp);
    const lock = await this.d.lockout.isLocked(email);
    if (lock.locked) throw new RateLimitedError(lock.retryAfterMs);

    const user = await this.d.users.findByEmail(email);
    // X4-mem: the hash this login checks, captured before the (slow) check. Everything after compares against this
    // value, never a re-read field of `user`, so a store that hands out live objects cannot hide a concurrent change.
    const checkedHash = user?.passwordHash ?? '';
    // Google-only accounts store no password. Verify a dummy hash so that case is not faster than
    // an unknown email.
    const ok = checkedHash
      ? await this.d.hasher.verify(checkedHash, input.password)
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
    let verifiedHash = checkedHash;
    if (this.d.hasher.needsRehash(checkedHash)) {
      const rehashed = await this.d.hasher.hash(input.password);
      // Compare-and-set: never write a hash back over a password a takeover just removed (X4).
      if (await this.d.users.replacePasswordHash(user.id, checkedHash, rehashed))
        verifiedHash = rehashed;
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
    // X4: a takeover (mailbox owner or Google) may have removed this password while it was being checked. The session
    // now exists, so either the takeover already committed (seen here) or it commits later and its transaction
    // revokes this row. Generic 401 either way.
    if (!(await this.stillHolds(r.session, meta, (c) => c.passwordHash === verifiedHash)))
      throw new InvalidCredentialsError();
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
    // M-2: the password just proved this account, so a Google subject parked by the callback may be linked now.
    if (pendingGoogleLink && pendingGoogleLink.userId === user.id && user.emailVerifiedAt) {
      await this.linkAfterPassword(user, pendingGoogleLink.sub, r.session, meta);
    }
    return r;
  }

  private async linkAfterPassword(user: User, rawSub: string, keep: Session, meta: RequestMeta) {
    const sub = googleSub(rawSub);
    if (!sub || user.googleSub) return;
    if (!(await this.d.users.linkGoogleSub(user.id, sub))) {
      await this.auditGoogleFailure(user.id, meta, 'conflict');
      return;
    }
    await this.revokeOtherSessions(user.id, keep.id);
    await this.afterGoogleLinked(user.id, meta, 'password', keep.id);
  }

  /**
   * OIDC review N-3: charged once per flow, when /auth/google/start mints the state cookie. A request without a client
   * IP is refused (clientIpKey: 503) rather than pooled into one shared `unknown` bucket.
   */
  async enforceGoogleRateLimit(ip: string | null) {
    await this.limit(`google:ip:${clientIpKey(ip)}`, AUTH_LIMITS.googlePerIp);
  }

  /**
   * N-3 / N-6: a sealed state may complete one callback. Keyed by a hash of the (unguessable) state, so replaying a
   * captured callback inside the cookie's 10 minutes is refused without any server-side session store.
   */
  async consumeGoogleFlow(stateHash: string, ttlMs: number) {
    const r = await this.d.rateLimiter.consume(`google:flow:${stateHash}`, 1, ttlMs);
    if (!r.allowed) throw new RateLimitedError(r.retryAfterMs);
  }

  /**
   * Sign-in or sign-up from a verified Google ID token.
   *
   * "Proven" (googleEmailProven, OIDC review M-2 / N-2) means Google is the mail host: gmail.com / googlemail.com, or
   * a Workspace `hd` equal to the email's domain. `email_verified` alone is not enough.
   *
   * Linking rules:
   * - Match `sub` first. Email is not the identity.
   * - An account already bound to another Google subject is never relinked.
   * - Proven email, verified local account: link, sign out every other session, send an "account linked" notice.
   * - Proven email, unverified local account (N-1 pre-registration takeover): whoever set that password never proved
   *   the mailbox, so the password is dropped and every session, extension token, push token and one-time token of
   *   the account is revoked before linking.
   * - Unproven email, verified local account: no auto-link; `link_required` (prove the account with its password).
   * - Unproven email, unverified local account: refuse (`unverified_local`).
   * - No match: create the account with no password; verified only when the email is proven, otherwise unverified
   *   with a verification mail (so invitations and org creation stay gated, D2).
   * - A Google email that is not `email_verified` never reaches this method.
   */
  async completeGoogleSignIn(
    identity: GoogleIdentity,
    meta: RequestMeta,
    currentToken?: string,
  ): Promise<GoogleSignInOutcome> {
    const email = googleEmail(identity.email);
    const sub = googleSub(identity.sub);
    if (!identity.emailVerified || !email || !sub) {
      await this.auditGoogleFailure(null, meta, 'rejected');
      return { kind: 'rejected' };
    }
    const proven = googleEmailProven({ ...identity, email });

    const bySub = await this.d.users.findByGoogleSub(sub);
    if (bySub) {
      if (proven && !bySub.emailVerifiedAt && bySub.email === email) {
        await this.d.users.markEmailVerified(bySub.id, this.d.clock.now());
      }
      return this.finishGoogleLogin(bySub, meta, currentToken, (c) => c.googleSub === sub);
    }

    const byEmail = await this.d.users.findByEmail(email);
    if (byEmail) return this.linkOrRefuse(byEmail, sub, proven, meta, currentToken);

    const now = this.d.clock.now();
    try {
      const user = await this.d.users.create({
        id: this.d.ids.next(),
        email,
        name: googleName(identity.name),
        passwordHash: '',
        emailVerifiedAt: proven ? now : null,
        // N-7: only a proven address is linked at creation. An unproven subject waits for the verification link to be
        // opened in this browser's Google session (verifyLink), so a stale holder of a consumer Google account on a
        // company address never gets a link that survives the real mailbox owner's verification or reset.
        googleSub: proven ? sub : null,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      });
      await this.audit(
        {
          actorId: user.id,
          action: 'auth.signup',
          targetType: 'user',
          targetId: user.id,
          metadata: { provider: 'google', emailProven: proven },
        },
        meta,
      );
      if (!proven) {
        const t = await this.createOneTimeToken(
          user.id,
          'email_verification',
          this.d.emailVerificationTtlMs,
        );
        await this.d.mailQueue.enqueue({ kind: 'email_verification', tokenId: t.id });
        // Unproven and unlinked: the session is valid only while the address is still unproven (X4: the mailbox
        // owner may verify from elsewhere in the meantime and take the account over).
        const outcome = await this.finishGoogleLogin(
          user,
          meta,
          currentToken,
          (c) => !c.googleSub && !c.emailVerifiedAt,
        );
        return outcome.kind === 'session'
          ? { ...outcome, verifyLink: { userId: user.id, sub } }
          : outcome;
      }
      return this.finishGoogleLogin(user, meta, currentToken, (c) => c.googleSub === sub);
    } catch (e) {
      if (!(e instanceof DuplicateEmailError)) throw e;
      const winner =
        (await this.d.users.findByGoogleSub(sub)) ?? (await this.d.users.findByEmail(email));
      if (!winner) {
        await this.auditGoogleFailure(null, meta, 'rejected');
        return { kind: 'rejected' };
      }
      if (winner.googleSub === sub)
        return this.finishGoogleLogin(winner, meta, currentToken, (c) => c.googleSub === sub);
      return this.linkOrRefuse(winner, sub, proven, meta, currentToken);
    }
  }

  private async linkOrRefuse(
    user: User,
    sub: string,
    proven: boolean,
    meta: RequestMeta,
    currentToken?: string,
  ): Promise<GoogleSignInOutcome> {
    if (user.googleSub) {
      // bySub already missed, so this account belongs to a different Google subject.
      await this.auditGoogleFailure(user.id, meta, 'conflict');
      return { kind: 'rejected' };
    }
    if (!proven) {
      if (!user.emailVerifiedAt) {
        await this.auditGoogleFailure(user.id, meta, 'unverified_local');
        return { kind: 'unverified_local' };
      }
      await this.auditGoogleFailure(user.id, meta, 'link_required');
      return { kind: 'link_required', pending: { userId: user.id, sub } };
    }

    const takeover = !user.emailVerifiedAt;
    const hadPassword = !!user.passwordHash;
    const now = this.d.clock.now();
    // X1: for a takeover, the claim and the revocation of every session commit together (AccountClaimStore), so a
    // failure leaves the account unverified and unlinked and the next sign-in redoes the whole takeover.
    const linked = takeover
      ? await this.claims.claimForGoogle(user.id, sub, now)
      : await this.d.users.linkGoogleSub(user.id, sub);
    if (!linked) {
      // A concurrent callback for the same subject may have won; it did the revocation and sends the notice.
      const again = await this.d.users.findByGoogleSub(sub);
      if (!again || again.id !== user.id) {
        await this.auditGoogleFailure(user.id, meta, 'conflict');
        return { kind: 'rejected' };
      }
    } else if (takeover) {
      await this.afterCredentialTakeover(user.id);
    } else {
      await this.revokeOtherSessions(user.id, null);
    }
    const fresh = (await this.d.users.findById(user.id)) ?? user;
    const outcome = await this.finishGoogleLogin(
      fresh,
      meta,
      currentToken,
      (c) => c.googleSub === sub,
    );
    if (linked) {
      await this.afterGoogleLinked(
        user.id,
        meta,
        takeover ? 'google_proven_unverified_local' : 'google_proven',
        outcome.kind === 'session' ? outcome.result.session.id : null,
        takeover && hadPassword,
      );
    }
    return outcome;
  }

  /** M-2 / N-4: a distinct audit event and a security notice for every new link. */
  private async afterGoogleLinked(
    userId: string,
    meta: RequestMeta,
    method: 'password' | 'google_proven' | 'google_proven_unverified_local' | 'google_verify_link',
    sessionId: string | null,
    passwordRemoved = false,
  ) {
    const now = this.d.clock.now();
    await this.audit(
      {
        actorId: userId,
        action: 'auth.google.linked',
        targetType: 'user',
        targetId: userId,
        metadata: { provider: 'google', method, sessionId, passwordRemoved },
      },
      meta,
    );
    await this.d.mailQueue.enqueue({
      kind: 'account_linked',
      userId,
      provider: 'google',
      linkedAt: now.toISOString(),
      ...(passwordRemoved ? { passwordRemoved: true } : {}),
    });
  }

  /** N-1: revoke every session except `keepId` (null: all of them) and tell realtime about each. */
  private async revokeOtherSessions(userId: string, keepId: string | null) {
    const now = this.d.clock.now();
    for (const s of await this.d.sessions.listActiveForUser(userId, now)) {
      if (s.id === keepId) continue;
      await this.d.sessions.revoke(s.id, now);
      await this.publishSessionRevoked(s, 'logout');
    }
  }

  /**
   * N-1: the rest of a takeover, after AccountClaimStore already changed the credentials and revoked every session in
   * one unit: tell realtime, revoke extension/desktop token families and push devices, and void outstanding reset and
   * verification links. (A never-verified account cannot have joined an organisation (D2), so it has no families or
   * push devices of its own; these calls are defence in depth and idempotent.)
   *
   * Never throws (#459 NB-R3-2): the claim has committed, so the request reports its real outcome. Each step is retried
   * in place and every step runs; a step that still fails is logged (`auth.takeover.follow_up_failed`) and, for the
   * revocations, retried later: one durable job per user and kind (`takeoverFollowUps`, BullMQ), or the in-process
   * fallback (TAKEOVER_FOLLOW_UP_RETRY_DELAYS_MS) without a queue or when enqueueing fails. One-time-link invalidation is
   * not retried later: it would also void the set-password link sent after it. Returns the names of the steps that failed in-request.
   */
  private async afterCredentialTakeover(userId: string): Promise<string[]> {
    const now = this.d.clock.now();
    const revocations: TakeoverFollowUpKind[] = ['realtime', 'extension_tokens', 'push_devices'];
    const links: [string, () => Promise<unknown>][] = [
      ['reset_links', () => this.d.oneTimeTokens.invalidateForUser(userId, 'password_reset', now)],
      [
        'verification_links',
        () => this.d.oneTimeTokens.invalidateForUser(userId, 'email_verification', now),
      ],
    ];
    const failed: string[] = [];
    const pending: TakeoverFollowUpKind[] = [];
    for (const kind of revocations) {
      if (await retryIdempotent(() => this.runTakeoverFollowUp({ userId, kind }))) continue;
      failed.push(kind);
      pending.push(kind);
    }
    for (const [name, step] of links) if (!(await retryIdempotent(step))) failed.push(name);
    if (failed.length) {
      this.d.log?.error(
        { event: 'auth.takeover.follow_up_failed', userId, steps: failed },
        'account takeover follow-up failed after commit; revocations will be retried',
      );
      await this.deferFollowUps(userId, pending);
    }
    return failed;
  }

  /**
   * One takeover follow-up (in-request, and the durable queue's worker). Every kind is idempotent: a second realtime
   * kick, family revocation or push-device delete of the same user is a no-op. Errors propagate (retries).
   */
  async runTakeoverFollowUp(job: TakeoverFollowUpJob): Promise<void> {
    const { userId } = job;
    switch (job.kind) {
      case 'realtime':
        await this.publish({ kind: 'user', userId, reason: 'password_changed' });
        return;
      case 'extension_tokens':
        await this.d.extensionRevoker?.revokeForUser(userId, 'password_changed', undefined, {
          propagate: true,
        });
        return;
      case 'push_devices':
        await this.d.pushDeviceRevoker?.revokeForUser(userId);
        return;
    }
  }

  /**
   * Hands still-failing revocations to the durable queue (one job per user and kind). Never throws: the claim has
   * committed, so the request keeps its 204. Kinds that cannot be enqueued (or every kind, without a queue) fall back
   * to the in-process retry chain.
   */
  private async deferFollowUps(userId: string, kinds: TakeoverFollowUpKind[]) {
    if (!kinds.length) return;
    const queue = this.d.takeoverFollowUps;
    let local = kinds;
    if (queue) {
      local = [];
      for (const kind of kinds) {
        try {
          await queue.enqueue({ userId, kind });
        } catch (err) {
          local.push(kind);
          this.d.log?.error(
            {
              event: 'auth.takeover.follow_up_enqueue_failed',
              userId,
              steps: [kind],
              err: err instanceof Error ? err.name : typeof err,
            },
            'could not enqueue account takeover follow-up; retrying in process',
          );
        }
      }
    }
    this.retryLater(
      userId,
      local.map((kind) => [kind, () => this.runTakeoverFollowUp({ userId, kind })]),
      0,
    );
  }

  private retryLater(userId: string, steps: [string, () => Promise<unknown>][], attempt: number) {
    const delay = TAKEOVER_FOLLOW_UP_RETRY_DELAYS_MS[attempt];
    if (!steps.length) return;
    if (delay === undefined) {
      this.d.log?.error(
        { event: 'auth.takeover.follow_up_abandoned', userId, steps: steps.map((s) => s[0]) },
        'account takeover follow-up still failing after deferred retries',
      );
      return;
    }
    (this.d.scheduleRetry ?? defaultScheduleRetry)(async () => {
      const still: [string, () => Promise<unknown>][] = [];
      for (const step of steps) if (!(await retryIdempotent(step[1], 1))) still.push(step);
      this.retryLater(userId, still, attempt + 1);
    }, delay);
  }

  private async finishGoogleLogin(
    user: User,
    meta: RequestMeta,
    currentToken: string | undefined,
    holds: (c: AccountCredentials) => boolean,
  ): Promise<GoogleSignInOutcome> {
    if (currentToken) {
      const old = await this.revokeByToken(currentToken);
      if (old) await this.publishSessionRevoked(old, 'logout');
    }
    const result = await this.issueSession(
      user.id,
      toPublicUser(user),
      await this.defaultOrganizationId(user.id),
      meta,
      { newLocationAlert: true, authLevel: 'google' },
    );
    // X4: same rule as password login, for the subject this sign-in relied on.
    if (!(await this.stillHolds(result.session, meta, holds))) return { kind: 'rejected' };
    await this.audit(
      {
        actorId: user.id,
        action: 'auth.login.success',
        targetType: 'session',
        targetId: result.session.id,
        metadata: { provider: 'google' },
      },
      meta,
    );
    return { kind: 'session', result };
  }

  /**
   * OIDC review X4: re-read the account's credentials AFTER the new session row exists (Prisma: FOR SHARE, so an
   * in-flight takeover transaction is waited for). If the credential this sign-in relied on is gone, revoke the new
   * session. Together with the takeover transaction revoking every session row it can see, no interleaving leaves a
   * session from the old credential alive.
   */
  private async stillHolds(
    session: Session,
    meta: RequestMeta,
    holds: (c: AccountCredentials) => boolean,
  ): Promise<boolean> {
    const c = await this.d.users.readCredentials(session.userId);
    if (c && holds(c)) return true;
    await this.d.sessions.revoke(session.id, this.d.clock.now());
    await this.publishSessionRevoked(session, 'logout');
    await this.audit(
      {
        actorId: session.userId,
        action: 'auth.login.failure',
        targetType: 'user',
        targetId: session.userId,
        metadata: { reason: 'credentials_changed' },
      },
      meta,
    );
    return false;
  }

  private auditGoogleFailure(userId: string | null, meta: RequestMeta, reason: string) {
    return this.audit(
      {
        actorId: userId,
        action: 'auth.login.failure',
        targetType: 'user',
        targetId: userId,
        metadata: { provider: 'google', reason },
      },
      meta,
    );
  }

  /**
   * Enumeration-safe with timing parity: both paths generate + hash a token and enqueue
   * exactly one job (tokenId null for unknown emails; the worker drops it).
   */
  async requestPasswordReset(rawEmail: string, meta: RequestMeta) {
    const email = normalizeEmail(rawEmail);
    await this.limit(`reset:ip:${clientIpKey(meta.ip)}`, AUTH_LIMITS.resetRequestPerIp);
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
    await this.limit(`reset:submit:ip:${clientIpKey(meta.ip)}`, AUTH_LIMITS.resetSubmitPerIp);
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
    // N-7 / B-1: the reset link reached the mailbox, which proves the address. A still-unverified account becomes
    // verified here and loses any Google subject linked before the address was proven (the new password stays).
    const verifiedByReset = await this.d.users.claimUnverifiedForMailbox(t.userId, now, {
      clearPassword: false,
    });
    if (verifiedByReset)
      await this.d.oneTimeTokens.invalidateForUser(t.userId, 'email_verification', now);
    const user = await this.d.users.findById(t.userId);
    if (user) await this.d.lockout.reset(user.email);
    await this.audit(
      {
        actorId: t.userId,
        action: 'auth.password_reset.complete',
        targetType: 'user',
        targetId: t.userId,
        metadata: verifiedByReset ? { emailVerified: true } : {},
      },
      meta,
    );
  }

  /**
   * Verifying proves the mailbox. Who chose the account's password (or Google identity) is a separate question:
   * - From a live session of the account, or from the browser that registered it (`signupBinding`, set at signup):
   *   the verifier is that same person. Mark verified, sign out every other session, keep the password. In the
   *   account's own Google session, a pending unproven Google subject (`googleVerifyLink`, N-7) is linked now.
   * - From anywhere else (OIDC review N-1 residual, Architecture B-1): the mailbox owner is not known to be whoever
   *   registered the address, so the mailbox owner wins. In one unit (AccountClaimStore, X1): mark verified, remove the
   *   password and any Google subject, revoke every session; then revoke the rest and email a set-password link
   *   through the reset flow.
   * Already-verified accounts only get the other sessions signed out (the presented one survives when it is theirs).
   */
  async verifyEmail(
    token: string,
    meta: RequestMeta,
    opts: {
      currentToken?: string | undefined;
      signupBinding?: string | null | undefined;
      googleVerifyLink?: PendingGoogleLink | null | undefined;
    } = {},
  ): Promise<{
    proof: 'session' | 'signup_browser' | 'mailbox' | 'already_verified';
    /** True only when this verification removed a password the account actually had (mailbox takeover). */
    passwordRemoved: boolean;
  }> {
    await this.limit(`verify:ip:${clientIpKey(meta.ip)}`, AUTH_LIMITS.verifySubmitPerIp);
    const now = this.d.clock.now();
    const t = await this.d.oneTimeTokens.consume(
      'email_verification',
      this.d.tokens.hash(token),
      now,
    );
    if (!t) throw invalidVerificationError();
    const user = await this.d.users.findById(t.userId);
    if (!user) throw invalidVerificationError();
    const current = opts.currentToken
      ? await this.d.sessions.findByTokenHash(this.d.tokens.hash(opts.currentToken))
      : null;
    const own =
      current && current.userId === user.id && isSessionActive(current, now, this.d.sessionPolicy)
        ? current
        : null;

    let proof: 'session' | 'signup_browser' | 'mailbox' | 'already_verified';
    let metadata: Record<string, unknown> = {};
    let passwordRemoved = false;
    if (user.emailVerifiedAt) {
      proof = 'already_verified';
      await this.d.oneTimeTokens.invalidateForUser(user.id, 'email_verification', now);
      await this.revokeOtherSessions(user.id, own?.id ?? null);
    } else if (own || opts.signupBinding === user.id) {
      proof = own ? 'session' : 'signup_browser';
      await this.d.users.markEmailVerified(user.id, now);
      await this.d.oneTimeTokens.invalidateForUser(user.id, 'email_verification', now);
      await this.revokeOtherSessions(user.id, own?.id ?? null);
      const link = opts.googleVerifyLink;
      if (
        own &&
        own.authLevel === 'google' &&
        link?.userId === user.id &&
        !user.googleSub &&
        googleSub(link.sub) &&
        (await this.d.users.linkGoogleSub(user.id, link.sub))
      ) {
        metadata = { googleLinked: true };
        await this.afterGoogleLinked(user.id, meta, 'google_verify_link', own.id);
      }
    } else {
      proof = 'mailbox';
      const before = { passwordRemoved: !!user.passwordHash, googleUnlinked: !!user.googleSub };
      let claimed: boolean;
      try {
        claimed = await this.claims.claimForMailbox(user.id, now);
      } catch {
        // Nothing committed (one transaction): 503, the user can retry with a new link.
        throw new CredentialStoreUnavailableError();
      }
      if (!claimed) {
        // A concurrent verify or reset got there first; it did the takeover.
        if ((await this.d.users.findById(user.id))?.emailVerifiedAt)
          return { proof: 'already_verified', passwordRemoved: false };
        throw invalidVerificationError();
      }
      // Committed: from here on the request reports the takeover (NB-R3-2); follow-up failures are logged and retried.
      const failedSteps = await this.afterCredentialTakeover(user.id);
      metadata = failedSteps.length ? { ...before, followUpFailed: failedSteps } : before;
      passwordRemoved = before.passwordRemoved;
      // Set-password link: the regular reset flow (single-use token, reset mail).
      const reset = await this.createOneTimeToken(
        user.id,
        'password_reset',
        this.d.passwordResetTtlMs,
      );
      await this.d.mailQueue.enqueue({ kind: 'password_reset', tokenId: reset.id });
    }
    await this.audit(
      {
        actorId: user.id,
        action: 'auth.email.verify',
        targetType: 'user',
        targetId: user.id,
        metadata: { proof, ...metadata },
      },
      meta,
    );
    return { proof, passwordRemoved };
  }

  /** Enumeration-safe: always resolves the same; only unverified accounts get a new link. */
  async resendVerification(rawEmail: string, meta: RequestMeta) {
    const email = normalizeEmail(rawEmail);
    await this.limit(`resend:ip:${clientIpKey(meta.ip)}`, AUTH_LIMITS.resendPerIp);
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
  ): Promise<SessionResult | null> {
    // X4: snapshot the credentials first, and refuse when someone else (a takeover) already revoked the old session;
    // the new session is then re-checked against the snapshot like a fresh sign-in.
    const before = await this.d.users.readCredentials(session.userId);
    if (!before) throw new UnauthenticatedError();
    if (!(await this.d.sessions.revoke(session.id, this.d.clock.now()))) {
      // NB-R3-3: a concurrent rotation of this same session by the same client (a double-submitted POST /orgs) already
      // won. Null tells the route to keep the cookie the winner set; no new session is minted for the loser.
      if (await this.supersededByOwnRotation(session, meta)) return null;
      throw new UnauthenticatedError();
    }
    await this.publishSessionRevoked(session, reason);
    const r = await this.issueSession(session.userId, user, activeOrganizationId, meta, {
      authLevel: session.authLevel ?? 'password',
    });
    const same = (c: AccountCredentials) =>
      c.passwordHash === before.passwordHash &&
      c.googleSub === before.googleSub &&
      c.emailVerifiedAt?.getTime() === before.emailVerifiedAt?.getTime();
    if (!(await this.stillHolds(r.session, meta, same))) throw new UnauthenticatedError();
    return r;
  }

  /**
   * NB-R3-3: true when a live session of the same user, client (IP + user agent) and auth level was created since
   * `session` was last validated, within ROTATION_RACE_WINDOW_MS. The winner's active organization is kept (a double
   * submit of POST /orgs creates two orgs; the browser stays in the winner's). Nothing is minted for the loser, and a
   * takeover, logout or logout-all revokes the successor too, so this never hides a real revocation.
   */
  private async supersededByOwnRotation(session: Session, meta: RequestMeta): Promise<boolean> {
    // The winner revokes first and inserts its session right after, so give it a moment (only on this rare path).
    for (let attempt = 0; ; attempt++) {
      if (await this.hasRotationSuccessor(session, meta)) return true;
      if (attempt >= ROTATION_SUCCESSOR_POLLS) return false;
      await (this.d.sleep ?? realSleep)(ROTATION_SUCCESSOR_POLL_MS);
    }
  }

  private async hasRotationSuccessor(session: Session, meta: RequestMeta): Promise<boolean> {
    const now = this.d.clock.now();
    const live = await this.d.sessions.listActiveForUser(session.userId, now);
    return live.some(
      (s) =>
        s.id !== session.id &&
        s.ip === meta.ip &&
        s.userAgent === meta.userAgent &&
        (s.authLevel ?? 'password') === (session.authLevel ?? 'password') &&
        s.createdAt.getTime() >= session.lastSeenAt.getTime() &&
        now.getTime() - s.createdAt.getTime() <= ROTATION_RACE_WINDOW_MS,
    );
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
    opts: { newLocationAlert?: boolean; authLevel?: SessionAuthLevel } = {},
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
      authLevel: opts.authLevel ?? 'password',
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
