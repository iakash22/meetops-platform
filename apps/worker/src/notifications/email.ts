import {
  createEmailService,
  createNewLocationEmailSender,
  type EmailNotificationSender,
  type EmailService,
} from '@meetops/notifications';
import { createPrismaUserEmailLookup } from './index.js';

type WarnLog = { warn(o: object, m: string): void };

/**
 * Email channel for the notifications worker (ADR-014 new-location alert). Off unless WEB_BASE_URL is set and the
 * shared EMAIL_* config (EMAIL_PROVIDER, ...) loads; a bad config disables the channel with a warning (error name
 * only), it never falls back to another provider.
 */
export function createNotificationEmailSender(
  env: NodeJS.ProcessEnv,
  log: WarnLog,
  deps: {
    emailService?: () => EmailService;
    userEmail?: (userId: string) => Promise<string | undefined>;
  } = {},
): EmailNotificationSender | undefined {
  const webBaseUrl = env.WEB_BASE_URL?.trim();
  if (!webBaseUrl) {
    log.warn({}, 'WEB_BASE_URL not set: notification emails are skipped');
    return undefined;
  }
  try {
    return createNewLocationEmailSender({
      email: (deps.emailService ?? (() => createEmailService()))(),
      userEmail: deps.userEmail ?? createPrismaUserEmailLookup(),
      webBaseUrl,
    });
  } catch (err) {
    log.warn(
      { errName: err instanceof Error ? err.name : 'unknown' },
      'notification email channel disabled (email config or WEB_BASE_URL invalid)',
    );
    return undefined;
  }
}
