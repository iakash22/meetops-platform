import type { UserRepository } from '../../users/domain/user.repository.js';
import type {
  InvitationRepository,
  OrganizationRepository,
} from '../../organizations/domain/repositories.js';
import type { TokenService } from '../domain/ports.js';
import type { OneTimeTokenRepository } from '../domain/one-time-token.js';
import type { AuthMailJob, AuthMailQueue, MailTransport } from '../domain/mail-jobs.js';
import type { Clock } from '../../../shared/ports.js';

/** Minimal logger port (Fastify/pino compatible). Only ids, kinds and error classes are logged. */
export interface MailLog {
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

export interface AuthMailHandlerDeps {
  /** Receives a warning when a job is dropped because its token row or user is gone. */
  log?: MailLog;
  users: UserRepository;
  oneTimeTokens: OneTimeTokenRepository;
  organizations: OrganizationRepository;
  invitations: InvitationRepository;
  tokens: TokenService;
  transport: MailTransport;
  clock: Clock;
  /** e.g. https://app.meetops.ai */
  webBaseUrl: string;
  /** Shown in the lockout mail; must match the login lockout policy. Default 15. */
  lockoutMinutes?: number;
  /** IANA zone used for password_changed until users carry a time-zone preference. Default UTC. */
  defaultTimeZone?: string;
}

/** Recipient display name, only when set (templates fall back to "there"). */
function withName(
  data: Record<string, string>,
  name: string | null | undefined,
): Record<string, string> {
  const n = name?.trim();
  return n ? { ...data, name: n } : data;
}

/**
 * Worker-side handler: resolves recipients from ids, mints the token (storing only its hash,
 * which invalidates any earlier link for the same row) and hands a rendered message to the
 * transport. Jobs for unknown/used/expired rows are dropped silently.
 */
export class AuthMailJobHandler {
  constructor(private readonly d: AuthMailHandlerDeps) {}

  private link(path: string, token: string) {
    const u = new URL(path, this.d.webBaseUrl);
    u.searchParams.set('token', token);
    return u.toString();
  }

  async handle(job: AuthMailJob): Promise<void> {
    const now = this.d.clock.now();
    switch (job.kind) {
      case 'email_verification':
      case 'password_reset': {
        if (!job.tokenId) {
          this.d.log?.warn({ kind: job.kind }, 'auth mail dropped: job has no token id');
          return;
        }
        const t = await this.d.oneTimeTokens.findById(job.tokenId);
        if (!t || t.usedAt || t.expiresAt <= now) {
          this.d.log?.warn(
            {
              kind: job.kind,
              tokenId: job.tokenId,
              reason: !t ? 'missing' : t.usedAt ? 'used' : 'expired',
            },
            'auth mail dropped: token not usable',
          );
          return;
        }
        const user = await this.d.users.findById(t.userId);
        if (!user) {
          this.d.log?.warn(
            { kind: job.kind, tokenId: job.tokenId },
            'auth mail dropped: user not found',
          );
          return;
        }
        const token = this.d.tokens.generate();
        await this.d.oneTimeTokens.setTokenHash(t.id, this.d.tokens.hash(token));
        const path = job.kind === 'password_reset' ? '/reset-password' : '/verify-email';
        await this.d.transport.send({
          to: user.email,
          template: job.kind,
          data: withName({ url: this.link(path, token) }, user.name),
        });
        return;
      }
      case 'account_exists': {
        const user = await this.d.users.findById(job.userId);
        if (!user) return;
        await this.d.transport.send({
          to: user.email,
          template: 'account_exists',
          data: withName(
            { url: new URL('/forgot-password', this.d.webBaseUrl).toString() },
            user.name,
          ),
        });
        return;
      }
      case 'login_lockout': {
        // Minimal template: tells the owner sign-in is paused and links to password reset.
        if (!job.userId) return;
        const user = await this.d.users.findById(job.userId);
        if (!user) return;
        await this.d.transport.send({
          to: user.email,
          template: 'login_lockout',
          data: withName(
            {
              url: new URL('/forgot-password', this.d.webBaseUrl).toString(),
              lockedForMinutes: String(this.d.lockoutMinutes ?? 15),
            },
            user.name,
          ),
        });
        return;
      }
      case 'password_changed': {
        const user = await this.d.users.findById(job.userId);
        if (!user) return;
        await this.d.transport.send({
          to: user.email,
          template: 'password_changed',
          data: withName(
            {
              url: new URL('/forgot-password', this.d.webBaseUrl).toString(),
              changedAt: job.changedAt,
              timeZone: this.d.defaultTimeZone ?? 'UTC',
            },
            user.name,
          ),
        });
        return;
      }
      case 'invitation': {
        const inv = await this.d.invitations.findById(job.organizationId, job.invitationId);
        if (!inv || inv.status !== 'pending' || inv.expiresAt <= now) return;
        const org = await this.d.organizations.findById(job.organizationId);
        if (!org) return;
        const token = this.d.tokens.generate();
        await this.d.invitations.setTokenHash(
          inv.organizationId,
          inv.id,
          this.d.tokens.hash(token),
        );
        const inviter = inv.invitedById ? await this.d.users.findById(inv.invitedById) : null;
        const days = Math.max(1, Math.ceil((inv.expiresAt.getTime() - now.getTime()) / 86_400_000));
        const data: Record<string, string> = {
          url: this.link('/invitations/accept', token),
          organizationName: org.name,
          role: inv.role,
          expiresInDays: String(days),
        };
        const inviterName = inviter?.name?.trim() || inviter?.email;
        if (inviterName) data.inviterName = inviterName;
        await this.d.transport.send({ to: inv.email, template: 'invitation', data });
        return;
      }
    }
  }
}

/**
 * Runs jobs in-process right after enqueue. Dev/test default. Production uses BullMqAuthMailQueue
 * (AUTH_MAIL_QUEUE=bullmq, infrastructure/mail-queue), whose consumer runs this same handler.
 */
export class InlineAuthMailQueue implements AuthMailQueue {
  readonly jobs: AuthMailJob[] = [];
  handler: AuthMailJobHandler | null = null;
  log: MailLog | null = null;
  /**
   * Never throws: a delivery failure (SMTP/Resend down, bad credentials, rejected recipient) must
   * not turn signup, resend or invites into a 500 or change their response. The error is logged
   * by class/code/status only (no message, which can echo addresses, links or provider bodies).
   */
  async enqueue(job: AuthMailJob) {
    this.jobs.push(job);
    try {
      await this.handler?.handle(job);
    } catch (err) {
      this.log?.error({ kind: job.kind, err: safeMailError(err) }, 'auth mail delivery failed');
    }
  }
}

/** Loggable summary of a delivery error without its message or payload. */
export function safeMailError(err: unknown): Record<string, unknown> {
  if (!(err instanceof Error)) return { type: typeof err };
  const e = err as Error & {
    code?: unknown;
    status?: unknown;
    responseCode?: unknown;
    retryable?: unknown;
  };
  const out: Record<string, unknown> = { type: e.name };
  if (typeof e.code === 'string' && /^[\w.-]{1,64}$/.test(e.code)) out.code = e.code;
  if (typeof e.status === 'number') out.status = e.status;
  if (typeof e.responseCode === 'number') out.responseCode = e.responseCode;
  if (typeof e.retryable === 'boolean') out.retryable = e.retryable;
  return out;
}
