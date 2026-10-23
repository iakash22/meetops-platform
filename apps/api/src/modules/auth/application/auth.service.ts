import type { UserRepository } from '../../users/domain/user.repository.js';
import { normalizeEmail, toPublicUser, type PublicUser } from '../../users/domain/user.js';
import type { Clock, IdGenerator } from '../../../shared/ports.js';
import type { LoginLockout, PasswordHasher, RateLimiter, TokenService } from '../domain/ports.js';
import { isSessionActive, type Session, type SessionPolicy, type SessionRepository } from '../domain/session.js';
import { InvalidCredentialsError, RateLimitedError, UnauthenticatedError } from '../domain/errors.js';
import type { AuthMailer } from '../domain/mailer.js';
import { isResetTokenUsable, type PasswordResetRepository } from '../domain/password-reset.js';
import { DomainError } from '../../../shared/domain-error.js';

export interface AuthServiceDeps {
  users: UserRepository;
  sessions: SessionRepository;
  hasher: PasswordHasher;
  tokens: TokenService;
  rateLimiter: RateLimiter;
  lockout: LoginLockout;
  clock: Clock;
  ids: IdGenerator;
  sessionPolicy: SessionPolicy;
  passwordResets: PasswordResetRepository;
  mailer: AuthMailer;
  passwordResetTtlMs: number;
}

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
  resetSubmitPerIp: { limit: 10, windowMs: HOUR }
} as const;

export class AuthService {
  private dummyHash: Promise<string> | null = null;
  constructor(private readonly d: AuthServiceDeps) {}

  private async limit(key: string, l: { limit: number; windowMs: number }) {
    const r = await this.d.rateLimiter.consume(key, l.limit, l.windowMs);
    if (!r.allowed) throw new RateLimitedError(r.retryAfterMs);
  }

  /**
   * Enumeration-safe: same result whether or not the email exists. Does not start a session.
   * TODO(notifications): send verification mail / "you already have an account" mail.
   */
  async signup(input: { email: string; password: string; name?: string | undefined }, meta: RequestMeta) {
    const email = normalizeEmail(input.email);
    await this.limit(`signup:ip:${meta.ip ?? 'unknown'}`, AUTH_LIMITS.signupPerIp);
    await this.limit(`signup:email:${email}`, AUTH_LIMITS.signupPerEmail);
    const passwordHash = await this.d.hasher.hash(input.password);
    if (await this.d.users.findByEmail(email)) {
      await this.d.mailer.sendAccountExists(email);
      return { accepted: true as const };
    }
    const now = this.d.clock.now();
    try {
      await this.d.users.create({
        id: this.d.ids.next(),
        email,
        name: input.name ?? null,
        passwordHash,
        emailVerifiedAt: null,
        createdAt: now,
        updatedAt: now,
        deletedAt: null
      });
      // TODO(database): persist an email_verifications row; token is only mailed.
      await this.d.mailer.sendEmailVerification(email, this.d.tokens.generate());
    } catch {
      // Race on unique email: still respond identically.
    }
    return { accepted: true as const };
  }

  /** Rotates: any presented session is revoked and a new one is issued. */
  async login(input: { email: string; password: string }, meta: RequestMeta, currentToken?: string): Promise<SessionResult> {
    const email = normalizeEmail(input.email);
    await this.limit(`login:ip:${meta.ip ?? 'unknown'}`, AUTH_LIMITS.loginPerIp);
    const lock = await this.d.lockout.isLocked(email);
    if (lock.locked) throw new RateLimitedError(lock.retryAfterMs);

    const user = await this.d.users.findByEmail(email);
    if (!user) {
      await this.d.hasher.verify(await this.getDummyHash(), input.password);
      await this.d.lockout.recordFailure(email);
      throw new InvalidCredentialsError();
    }
    if (!(await this.d.hasher.verify(user.passwordHash, input.password))) {
      await this.d.lockout.recordFailure(email);
      throw new InvalidCredentialsError();
    }
    await this.d.lockout.reset(email);
    if (this.d.hasher.needsRehash(user.passwordHash)) {
      await this.d.users.updatePasswordHash(user.id, await this.d.hasher.hash(input.password));
    }
    if (currentToken) await this.revokeByToken(currentToken);
    return this.issueSession(user.id, toPublicUser(user), null, meta);
  }

  /** Enumeration-safe: always resolves the same way. */
  async requestPasswordReset(rawEmail: string, meta: RequestMeta) {
    const email = normalizeEmail(rawEmail);
    await this.limit(`reset:ip:${meta.ip ?? 'unknown'}`, AUTH_LIMITS.resetRequestPerIp);
    await this.limit(`reset:email:${email}`, AUTH_LIMITS.resetRequestPerEmail);
    const user = await this.d.users.findByEmail(email);
    if (!user) return { accepted: true as const };
    const token = this.d.tokens.generate();
    const now = this.d.clock.now();
    await this.d.passwordResets.create({
      id: this.d.ids.next(),
      userId: user.id,
      tokenHash: this.d.tokens.hash(token),
      expiresAt: new Date(now.getTime() + this.d.passwordResetTtlMs),
      usedAt: null,
      createdAt: now
    });
    await this.d.mailer.sendPasswordReset(email, token);
    return { accepted: true as const };
  }

  /** Single-use token; on success revokes all of the user's sessions. */
  async resetPassword(input: { token: string; password: string }, meta: RequestMeta) {
    await this.limit(`reset:submit:ip:${meta.ip ?? 'unknown'}`, AUTH_LIMITS.resetSubmitPerIp);
    const t = await this.d.passwordResets.findByTokenHash(this.d.tokens.hash(input.token));
    const now = this.d.clock.now();
    if (!t || !isResetTokenUsable(t, now)) {
      throw new DomainError('BAD_REQUEST', 'Reset link is invalid or has expired', 400);
    }
    await this.d.passwordResets.markUsed(t.id, now);
    await this.d.users.updatePasswordHash(t.userId, await this.d.hasher.hash(input.password));
    await this.d.sessions.revokeAllForUser(t.userId, now);
    await this.d.lockout.reset((await this.d.users.findById(t.userId))?.email ?? '');
  }

  async logout(token: string | undefined): Promise<void> {
    if (token) await this.revokeByToken(token);
  }

  /** Resolve the session (idle + absolute timeouts) and slide last_seen_at. */
  async authenticate(token: string | undefined): Promise<{ user: PublicUser; session: Session }> {
    if (!token) throw new UnauthenticatedError();
    const session = await this.d.sessions.findByTokenHash(this.d.tokens.hash(token));
    const now = this.d.clock.now();
    if (!session || !isSessionActive(session, now, this.d.sessionPolicy)) throw new UnauthenticatedError();
    const user = await this.d.users.findById(session.userId);
    if (!user) throw new UnauthenticatedError();
    await this.d.sessions.touch(session.id, now);
    return { user: toPublicUser(user), session: { ...session, lastSeenAt: now } };
  }

  /** Privilege change (org switch/create): revoke the old session, issue a new one. */
  async rotate(session: Session, user: PublicUser, activeOrganizationId: string | null, meta: RequestMeta) {
    await this.d.sessions.revoke(session.id, this.d.clock.now());
    return this.issueSession(session.userId, user, activeOrganizationId, meta);
  }

  private async revokeByToken(token: string) {
    const session = await this.d.sessions.findByTokenHash(this.d.tokens.hash(token));
    if (session && session.revokedAt === null) await this.d.sessions.revoke(session.id, this.d.clock.now());
  }

  private getDummyHash() {
    this.dummyHash ??= this.d.hasher.hash('dummy-password-for-timing-equalization');
    return this.dummyHash;
  }

  private async issueSession(
    userId: string,
    user: PublicUser,
    activeOrganizationId: string | null,
    meta: RequestMeta
  ): Promise<SessionResult> {
    const token = this.d.tokens.generate();
    const now = this.d.clock.now();
    const session = await this.d.sessions.create({
      id: this.d.ids.next(),
      userId,
      tokenHash: this.d.tokens.hash(token),
      activeOrganizationId,
      createdAt: now,
      lastSeenAt: now,
      expiresAt: new Date(now.getTime() + this.d.sessionPolicy.absoluteTimeoutMs),
      revokedAt: null,
      ip: meta.ip,
      userAgent: meta.userAgent
    });
    return { user, session, token };
  }
}
