/**
 * ADR-021 MFA (TOTP + recovery codes). Decisions: ADR-021 Amendment 1 (OQ-1..OQ-17).
 *
 * Security properties:
 * - TOTP verification is constant-time over the whole ±1 window (domain/totp.ts) and replay-guarded by an atomic
 *   compare-and-set on the factor's last used step (repository.advanceStep), across sessions and API instances.
 * - Every verification is rate-limited per user and per IP (fail-closed consumeGuarded) and shares the ADR-006 login
 *   lockout counter of the account (OQ-4); a correct code during a lock still fails with 429.
 * - The TOTP secret and the recovery-code HMAC key live only in a TokenCipher envelope bound to user + factor (P-3).
 * - Recovery codes are stored as HMACs and shown once (confirm / regenerate responses are no-store).
 */
import { clientIpKey } from '../../../shared/rate-limit-core.js';
import { consumeGuarded, type LimitWindow } from '../../../shared/guarded-limit.js';
import { DomainError } from '../../../shared/domain-error.js';
import type { Clock, IdGenerator } from '../../../shared/ports.js';
import type { RateLimiter, LoginLockout } from '../../auth/domain/ports.js';
import { safeAudit, type AuditEvent, type AuditLog } from '../../auth/domain/audit.js';
import {
  InvalidMfaCodeError,
  RateLimitedError,
  StepUpRequiredError,
  UnauthenticatedError,
} from '../../auth/domain/errors.js';
import { hasFreshStepUp, type Session } from '../../auth/domain/session.js';
import type {
  AuthService,
  RequestMeta,
  SessionResult,
} from '../../auth/application/auth.service.js';
import { MFA_CHALLENGE_TTL_MS, type MfaChallenge } from '../../auth/application/mfa-challenge.js';
import type { AuthMailQueue } from '../../auth/domain/mail-jobs.js';
import type { UserRepository } from '../../users/domain/user.repository.js';
import { normalizeEmail, type PublicUser } from '../../users/domain/user.js';
import type { MfaFactorRecord, MfaRepository } from '../domain/mfa.repository.js';
import { generateTotpSecret, otpauthUri, verifyTotp } from '../domain/totp.js';
import {
  generateRecoveryCodes,
  generateRecoveryKey,
  hashRecoveryCode,
  normalizeRecoveryCode,
} from '../domain/recovery-codes.js';
import {
  decodeSecretPayload,
  encodeSecretPayload,
  type MfaSecretPayload,
} from '../domain/secret-payload.js';

/** Envelope cipher for MFA secrets (TokenCipher.encryptUserSecret / decryptUserSecret). */
export interface MfaSecretCipher {
  encrypt(plaintext: string, ctx: { userId: string; factorId: string }): Promise<string>;
  decrypt(envelope: string, ctx: { userId: string; factorId: string }): Promise<string>;
  keyIdOf(envelope: string): string;
}

const MIN = 60_000;
/** OQ-2: an unconfirmed factor expires after 10 minutes. */
export const MFA_PENDING_TTL_MS = 10 * MIN;
export const MFA_LIMITS = {
  verifyPerUser: { limit: 20, windowMs: 15 * MIN },
  verifyPerIp: { limit: 60, windowMs: MIN },
  enrollPerUser: { limit: 10, windowMs: 60 * MIN },
} as const satisfies Record<string, LimitWindow>;

export interface MfaServiceDeps {
  users: UserRepository;
  mfa: MfaRepository;
  cipher: MfaSecretCipher;
  rateLimiter: RateLimiter;
  lockout: LoginLockout;
  audit: AuditLog;
  clock: Clock;
  ids: IdGenerator;
  auth: AuthService;
  mailQueue?: AuthMailQueue;
  sleep?: (ms: number) => Promise<void>;
}

/** Exactly one of the two (TypeBox enforces it at the route). */
export type SecondFactor = { totpCode: string } | { recoveryCode: string };

export interface Caller {
  user: PublicUser;
  session: Session;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export const toFactorDto = (f: MfaFactorRecord) => ({
  id: f.id,
  type: f.type,
  status: f.status,
  createdAt: f.createdAt.toISOString(),
  confirmedAt: f.confirmedAt ? f.confirmedAt.toISOString() : null,
  lastUsedAt: f.lastUsedAt ? f.lastUsedAt.toISOString() : null,
});

export class MfaService {
  constructor(private readonly d: MfaServiceDeps) {}

  private audit(e: Omit<AuditEvent, 'ip' | 'userAgent' | 'organizationId'>, meta: RequestMeta) {
    // User-level MFA events are pre-tenant (OQ-13), like login.
    return safeAudit(this.d.audit, {
      organizationId: null,
      ip: meta.ip,
      userAgent: meta.userAgent,
      ...e,
    });
  }

  private async limits(userId: string, meta: RequestMeta) {
    await consumeGuarded(this.d.rateLimiter, `mfa:verify:user:${userId}`, MFA_LIMITS.verifyPerUser);
    await consumeGuarded(
      this.d.rateLimiter,
      `mfa:verify:ip:${clientIpKey(meta.ip)}`,
      MFA_LIMITS.verifyPerIp,
    );
  }

  private async openPayload(f: MfaFactorRecord): Promise<MfaSecretPayload> {
    return decodeSecretPayload(
      await this.d.cipher.decrypt(f.secretEnc, { userId: f.userId, factorId: f.id }),
    );
  }

  async status(userId: string) {
    const now = this.d.clock.now();
    const factors = (await this.d.mfa.listFactors(userId)).filter(
      (f) => f.status === 'active' || (f.pendingExpiresAt !== null && f.pendingExpiresAt > now),
    );
    const active = factors.find((f) => f.status === 'active');
    return {
      enabled: !!active,
      factors: factors.map(toFactorDto),
      recoveryCodesRemaining: active
        ? await this.d.mfa.countUnusedRecoveryCodes(userId, active.id)
        : 0,
    };
  }

  /**
   * Start TOTP enrolment. ENR-08: the email must be verified (N-1 pre-hijack defence). With an active factor this is a
   * replacement and needs a fresh step-up (ENR-06, OQ-10); the old factor keeps working until the new one is confirmed.
   */
  async enroll(caller: Caller, meta: RequestMeta) {
    const { user, session } = caller;
    if (!user.emailVerifiedAt)
      throw new DomainError('FORBIDDEN', 'Verify your email address before turning on MFA', 403);
    const now = this.d.clock.now();
    if ((await this.d.mfa.findActiveTotp(user.id)) && !hasFreshStepUp(session, now))
      throw new StepUpRequiredError();
    await consumeGuarded(
      this.d.rateLimiter,
      `mfa:enroll:user:${user.id}`,
      MFA_LIMITS.enrollPerUser,
    );
    const secret = generateTotpSecret();
    const id = this.d.ids.next();
    const secretEnc = await this.d.cipher.encrypt(
      encodeSecretPayload({ s: secret, r: generateRecoveryKey() }),
      { userId: user.id, factorId: id },
    );
    const expiresAt = new Date(now.getTime() + MFA_PENDING_TTL_MS);
    await this.d.mfa.createPending({
      id,
      userId: user.id,
      type: 'totp',
      status: 'pending',
      secretEnc,
      secretKeyId: this.d.cipher.keyIdOf(secretEnc),
      lastUsedStep: null,
      pendingExpiresAt: expiresAt,
      confirmedAt: null,
      lastUsedAt: null,
      createdAt: now,
    });
    await this.audit(
      {
        actorId: user.id,
        action: 'auth.mfa.enroll',
        targetType: 'mfa_factor',
        targetId: id,
        metadata: { type: 'totp' },
      },
      meta,
    );
    return {
      factorId: id,
      secret,
      otpauthUri: otpauthUri(secret, user.email),
      expiresAt: expiresAt.toISOString(),
    };
  }

  /**
   * Confirm the pending factor with a code from the app. Activates it (replacing an old one in the same unit), turns
   * MFA on for the account, returns the recovery codes ONCE, elevates this session to `mfa` (rotated id, no step-up
   * stamp: the first sensitive action still asks for a step-up) and signs out every other session.
   */
  async confirm(caller: Caller, factorId: string, totpCode: string, meta: RequestMeta) {
    const { user, session } = caller;
    await this.limits(user.id, meta);
    await this.assertNotLocked(user.email);
    const now = this.d.clock.now();
    const f = await this.d.mfa.findFactor(user.id, factorId);
    // ENR-07: someone else's (or an unknown) factor id is a 404, never a hint.
    if (!f || f.status !== 'pending') throw new DomainError('NOT_FOUND', 'Factor not found', 404);
    const replacing = await this.d.mfa.findActiveTotp(user.id);
    if (replacing && !hasFreshStepUp(session, now)) throw new StepUpRequiredError();
    const payload = await this.openPayload(f);
    const step =
      f.pendingExpiresAt && f.pendingExpiresAt > now
        ? verifyTotp({
            secretB32: payload.s,
            code: totpCode,
            nowMs: now.getTime(),
            lastUsedStep: null,
          })
        : null;
    if (step === null) return this.fail(user, meta, 'confirm', f.id);
    const { codes, hashes } = generateRecoveryCodes(payload.r);
    const activated = await this.d.mfa.activate({
      userId: user.id,
      factorId: f.id,
      step,
      at: now,
      recoveryHashes: hashes,
    });
    if (!activated) return this.fail(user, meta, 'confirm', f.id);
    await this.audit(
      {
        actorId: user.id,
        action: 'auth.mfa.confirm',
        targetType: 'mfa_factor',
        targetId: f.id,
        metadata: { type: 'totp', replaced: !!replacing },
      },
      meta,
    );
    const elevated = await this.d.auth.elevate(session, user, meta, { stepUp: false });
    await this.d.auth.afterMfaChange(user.id, elevated.session.id, 'enabled');
    const active = await this.d.mfa.findFactor(user.id, f.id);
    return { factor: toFactorDto(active ?? f), recoveryCodes: codes, session: elevated };
  }

  /**
   * OQ-17: finish a login. `challenge` came from the sealed cookie (user + attempt). The challenge is single-use: after
   * the code verifies, its attempt id is burned through the shared limiter before the session is issued.
   */
  async completeLogin(
    challenge: MfaChallenge,
    proof: SecondFactor,
    meta: RequestMeta,
    currentToken?: string,
  ): Promise<{ session: SessionResult; recoveryCodesRemaining?: number }> {
    const user = await this.d.users.findById(challenge.userId);
    if (!user || !user.mfaEnabledAt) throw new UnauthenticatedError();
    const verified = await this.verifySecondFactor(user, proof, meta, 'challenge');
    const once = await this.d.rateLimiter.consume(
      `mfa:challenge:used:${challenge.attemptId}`,
      1,
      MFA_CHALLENGE_TTL_MS,
    );
    if (!once.allowed) throw new UnauthenticatedError();
    const session = await this.d.auth.completeMfaChallenge(challenge, meta, currentToken);
    await this.audit(
      {
        actorId: user.id,
        action: 'auth.mfa.challenge.success',
        targetType: 'mfa_factor',
        targetId: verified.factorId,
        metadata: { method: verified.method, firstFactor: challenge.firstFactor },
      },
      meta,
    );
    return {
      session,
      ...(verified.recoveryCodesRemaining !== undefined
        ? { recoveryCodesRemaining: verified.recoveryCodesRemaining }
        : {}),
    };
  }

  /**
   * Shared second-factor check (challenge, step-up). Rate limits, then the shared lockout, then TOTP (replay CAS) or a
   * single-use recovery code. Failures record a lockout failure, are audited, and answer the same generic error.
   */
  async verifySecondFactor(
    user: { id: string; email: string },
    proof: SecondFactor,
    meta: RequestMeta,
    purpose: 'challenge' | 'step_up',
  ): Promise<{
    factorId: string;
    method: 'totp' | 'recovery_code';
    recoveryCodesRemaining?: number;
  }> {
    await this.limits(user.id, meta);
    await this.assertNotLocked(user.email);
    const now = this.d.clock.now();
    const f = await this.d.mfa.findActiveTotp(user.id);
    if (!f) return this.fail(user, meta, purpose, null);
    const payload = await this.openPayload(f);
    if ('totpCode' in proof) {
      const step = verifyTotp({
        secretB32: payload.s,
        code: proof.totpCode,
        nowMs: now.getTime(),
        lastUsedStep: f.lastUsedStep,
      });
      if (step === null || !(await this.d.mfa.advanceStep(user.id, f.id, step, now)))
        return this.fail(user, meta, purpose, f.id);
      return { factorId: f.id, method: 'totp' };
    }
    const normalized = normalizeRecoveryCode(proof.recoveryCode);
    // Same HMAC work for a malformed code, so wrong-format and wrong-code take the same path (ERR-02).
    const hash = hashRecoveryCode(payload.r, normalized ?? 'AAAAAAAAAA');
    if (!normalized || !(await this.d.mfa.consumeRecoveryCode(user.id, f.id, hash, now)))
      return this.fail(user, meta, purpose, f.id);
    const remaining = await this.d.mfa.countUnusedRecoveryCodes(user.id, f.id);
    await this.audit(
      {
        actorId: user.id,
        action: 'auth.mfa.recovery_code.used',
        targetType: 'mfa_factor',
        targetId: f.id,
        metadata: { purpose, remaining },
      },
      meta,
    );
    return { factorId: f.id, method: 'recovery_code', recoveryCodesRemaining: remaining };
  }

  private async assertNotLocked(email: string) {
    const lock = await this.d.lockout.isLocked(normalizeEmail(email));
    if (lock.locked) throw new RateLimitedError(lock.retryAfterMs);
  }

  /** OQ-4: one lockout budget for password and MFA failures. Always throws the generic INVALID_MFA_CODE. */
  private async fail(
    user: { id: string; email: string },
    meta: RequestMeta,
    purpose: 'challenge' | 'step_up' | 'confirm',
    factorId: string | null,
  ): Promise<never> {
    const { lockedForMs, delayMs } = await this.d.lockout.recordFailure(normalizeEmail(user.email));
    const base = { actorId: user.id, targetType: 'mfa_factor' as const, targetId: factorId };
    await this.audit(
      { ...base, action: 'auth.mfa.challenge.failure', metadata: { purpose } },
      meta,
    );
    if (lockedForMs) {
      await this.audit(
        { ...base, action: 'auth.mfa.lockout', metadata: { purpose, lockedForMs } },
        meta,
      );
      await this.d.mailQueue?.enqueue({ kind: 'login_lockout', userId: user.id });
    }
    if (delayMs) await (this.d.sleep ?? realSleep)(delayMs);
    throw new InvalidMfaCodeError();
  }
}
