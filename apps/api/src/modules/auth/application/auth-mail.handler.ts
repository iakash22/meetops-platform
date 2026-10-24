import type { UserRepository } from '../../users/domain/user.repository.js';
import type { InvitationRepository, OrganizationRepository } from '../../organizations/domain/repositories.js';
import type { TokenService } from '../domain/ports.js';
import type { OneTimeTokenRepository } from '../domain/one-time-token.js';
import type { AuthMailJob, AuthMailQueue, MailTransport } from '../domain/mail-jobs.js';
import type { Clock } from '../../../shared/ports.js';

export interface AuthMailHandlerDeps {
  users: UserRepository;
  oneTimeTokens: OneTimeTokenRepository;
  organizations: OrganizationRepository;
  invitations: InvitationRepository;
  tokens: TokenService;
  transport: MailTransport;
  clock: Clock;
  /** e.g. https://app.meetops.ai */
  webBaseUrl: string;
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
        if (!job.tokenId) return;
        const t = await this.d.oneTimeTokens.findById(job.tokenId);
        if (!t || t.usedAt || t.expiresAt <= now) return;
        const user = await this.d.users.findById(t.userId);
        if (!user) return;
        const token = this.d.tokens.generate();
        await this.d.oneTimeTokens.setTokenHash(t.id, this.d.tokens.hash(token));
        const path = job.kind === 'password_reset' ? '/reset-password' : '/verify-email';
        await this.d.transport.send({ to: user.email, template: job.kind, data: { url: this.link(path, token) } });
        return;
      }
      case 'account_exists': {
        const user = await this.d.users.findById(job.userId);
        if (!user) return;
        await this.d.transport.send({
          to: user.email,
          template: 'account_exists',
          data: { url: new URL('/forgot-password', this.d.webBaseUrl).toString() }
        });
        return;
      }
      case 'invitation': {
        const inv = await this.d.invitations.findById(job.organizationId, job.invitationId);
        if (!inv || inv.status !== 'pending' || inv.expiresAt <= now) return;
        const org = await this.d.organizations.findById(job.organizationId);
        if (!org) return;
        const token = this.d.tokens.generate();
        await this.d.invitations.setTokenHash(inv.organizationId, inv.id, this.d.tokens.hash(token));
        await this.d.transport.send({
          to: inv.email,
          template: 'invitation',
          data: { url: this.link('/invitations/accept', token), organizationName: org.name }
        });
        return;
      }
    }
  }
}

/**
 * Runs jobs in-process right after enqueue. Dev/test only. TODO(notifications #11): production
 * adapter that enqueues to @meetops/notifications and runs AuthMailJobHandler in startEmailWorker.
 */
export class InlineAuthMailQueue implements AuthMailQueue {
  readonly jobs: AuthMailJob[] = [];
  handler: AuthMailJobHandler | null = null;
  async enqueue(job: AuthMailJob) {
    this.jobs.push(job);
    await this.handler?.handle(job);
  }
}
