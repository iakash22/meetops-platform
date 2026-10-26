/**
 * Localisable email copy. Every user-visible string lives here; templates never hard-code copy.
 * Add a locale by adding an entry to `emailMessages` with the same shape (TypeScript enforces completeness).
 * Values are plain text: the renderer HTML-escapes them, so translations must not contain markup.
 */
export interface EmailMessages {
  brand: string;
  greeting: (name: string) => string;
  greetingFallback: string;
  buttonFallback: string;
  footerAuth: string;
  footerProduct: string;
  managePreferences: string;
  unsubscribe: string;
  verification: {
    subject: string;
    preheader: string;
    body: string;
    cta: string;
    expires: (h: number) => string;
    ignore: string;
  };
  passwordReset: {
    subject: string;
    preheader: string;
    body: string;
    cta: string;
    expires: (m: number) => string;
    ignore: string;
  };
  invitation: {
    subject: (inviter: string, org: string) => string;
    preheader: (org: string) => string;
    body: (inviter: string, org: string) => string;
    role: (role: string) => string;
    cta: string;
    expires: (d: number) => string;
  };
  accountExists: { subject: string; preheader: string; body: string; cta: string; ignore: string };
  lockout: {
    subject: string;
    preheader: string;
    body: (minutes?: number) => string;
    cta: string;
    notYou: string;
  };
  passwordChanged: {
    subject: string;
    preheader: string;
    body: (when: string) => string;
    cta: string;
    notYou: string;
  };
  memberAdded: {
    subject: (org: string) => string;
    preheader: (org: string) => string;
    body: (by: string, org: string) => string;
    role: (role: string) => string;
    cta: string;
  };
  memberRemoved: {
    subject: (org: string) => string;
    preheader: (org: string) => string;
    body: (org: string) => string;
    byLine: (by: string) => string;
    contact: string;
  };
  meetingProcessed: {
    subject: (title: string) => string;
    preheader: (title: string) => string;
    intro: string;
    summaryHeading: string;
    actionItemsHeading: string;
    owner: (o: string) => string;
    due: (d: string) => string;
    cta: string;
    when: (date: string) => string;
  };
  tasksReady: {
    subject: (n: number, title: string) => string;
    preheader: (n: number) => string;
    body: (n: number, title: string) => string;
    more: (n: number) => string;
    cta: string;
  };
  taskAssigned: {
    subject: (title: string) => string;
    preheader: (title: string) => string;
    body: string;
    by: (n: string) => string;
    meeting: (t: string) => string;
    due: (d: string) => string;
    cta: string;
  };
  integrationError: {
    subject: (p: string) => string;
    preheader: (p: string) => string;
    body: (p: string, org: string) => string;
    reason: (r: string) => string;
    since: (s: string) => string;
    cta: string;
  };
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

export const en: EmailMessages = {
  brand: 'MeetOps',
  greeting: (name) => `Hi ${name},`,
  greetingFallback: 'Hi there,',
  buttonFallback: "If the button doesn't work, copy and paste this link into your browser:",
  footerAuth:
    "You're receiving this security email because of activity on your MeetOps account. It can't be turned off.",
  footerProduct: "You're receiving this because of your MeetOps notification settings.",
  managePreferences: 'Manage email preferences',
  unsubscribe: 'Unsubscribe',
  verification: {
    subject: 'Verify your email address',
    preheader: 'Confirm your email to finish setting up MeetOps.',
    body: 'Confirm this is your email address to finish setting up your MeetOps account.',
    cta: 'Verify email',
    expires: (h) => `This link expires in ${h} ${plural(h, 'hour', 'hours')}.`,
    ignore: "If you didn't create a MeetOps account, you can ignore this email.",
  },
  passwordReset: {
    subject: 'Reset your password',
    preheader: 'Use this link to choose a new MeetOps password.',
    body: 'We received a request to reset the password for your MeetOps account.',
    cta: 'Reset password',
    expires: (m) =>
      `This link expires in ${m} ${plural(m, 'minute', 'minutes')} and can be used once.`,
    ignore: "If you didn't ask for this, you can ignore this email. Your password won't change.",
  },
  invitation: {
    subject: (inviter, org) => `${inviter} invited you to ${org} on MeetOps`,
    preheader: (org) => `Join ${org} on MeetOps.`,
    body: (inviter, org) => `${inviter} invited you to join ${org} on MeetOps.`,
    role: (role) => `You'll join as ${role}.`,
    cta: 'Accept invitation',
    expires: (d) => `This invitation expires in ${d} ${plural(d, 'day', 'days')}.`,
  },
  accountExists: {
    subject: 'You already have a MeetOps account',
    preheader: 'Someone tried to sign up with this email address.',
    body: 'Someone tried to sign up with this email address, but it already has a MeetOps account. If that was you, sign in or reset your password.',
    cta: 'Reset password',
    ignore: "If it wasn't you, no action is needed. Nobody can sign in without your password.",
  },
  lockout: {
    subject: 'Sign-in temporarily locked',
    preheader: 'We paused sign-in after several failed attempts.',
    body: (m) =>
      m
        ? `We locked sign-in to your account for ${m} ${plural(m, 'minute', 'minutes')} after several failed attempts.`
        : 'We locked sign-in to your account for a short time after several failed attempts.',
    cta: 'Reset password',
    notYou: "If this wasn't you, reset your password now.",
  },
  passwordChanged: {
    subject: 'Your MeetOps password was changed',
    preheader: 'Your password was just changed.',
    body: (when) =>
      `The password for your MeetOps account was changed on ${when}. Other sessions have been signed out.`,
    cta: 'Reset password',
    notYou: "If you didn't change it, reset your password now and contact your workspace admin.",
  },
  memberAdded: {
    subject: (org) => `You've been added to ${org}`,
    preheader: (org) => `You now have access to ${org} on MeetOps.`,
    body: (by, org) => `${by} added you to ${org} on MeetOps.`,
    role: (role) => `Your role: ${role}.`,
    cta: 'Open workspace',
  },
  memberRemoved: {
    subject: (org) => `You've been removed from ${org}`,
    preheader: (org) => `You no longer have access to ${org}.`,
    body: (org) =>
      `You no longer have access to ${org} on MeetOps, and your sessions for it have been signed out.`,
    byLine: (by) => `Removed by ${by}.`,
    contact: 'If you think this is a mistake, contact a workspace admin.',
  },
  meetingProcessed: {
    subject: (t) => `Summary ready: ${t}`,
    preheader: (t) => `The summary and action items for ${t} are ready.`,
    intro: 'Your meeting has been processed. Here is the summary.',
    summaryHeading: 'Summary',
    actionItemsHeading: 'Action items',
    owner: (o) => `Owner: ${o}`,
    due: (d) => `Due: ${d}`,
    cta: 'Open meeting',
    when: (date) => date,
  },
  tasksReady: {
    subject: (n, t) => `${n} ${plural(n, 'task', 'tasks')} ready for review: ${t}`,
    preheader: (n) =>
      `${n} extracted ${plural(n, 'task is', 'tasks are')} waiting for your approval.`,
    body: (n, t) =>
      `We extracted ${n} ${plural(n, 'task', 'tasks')} from ${t}. Review them before they're sent to GitHub or Jira.`,
    more: (n) => `…and ${n} more`,
    cta: 'Review tasks',
  },
  taskAssigned: {
    subject: (t) => `New task assigned: ${t}`,
    preheader: (t) => `You've been assigned "${t}".`,
    body: "You've been assigned a task:",
    by: (n) => `Assigned by ${n}`,
    meeting: (t) => `From meeting: ${t}`,
    due: (d) => `Due ${d}`,
    cta: 'View task',
  },
  integrationError: {
    subject: (p) => `Action needed: ${p} connection error`,
    preheader: (p) => `MeetOps can't reach ${p}. Reconnect to keep tasks syncing.`,
    body: (p, org) =>
      `MeetOps can't reach ${p} for ${org}. Approved tasks won't sync until the connection is fixed.`,
    reason: (r) => `Reason: ${r}`,
    since: (s) => `Failing since ${s}`,
    cta: 'Fix connection',
  },
};

export const emailMessages = { en } as const satisfies Record<string, EmailMessages>;
export type EmailLocale = keyof typeof emailMessages;
export const DEFAULT_EMAIL_LOCALE: EmailLocale = 'en';

/** Unknown or missing locales fall back to English. */
export function messagesFor(locale?: string): EmailMessages {
  return (
    (locale && (emailMessages as Record<string, EmailMessages>)[locale]) ||
    emailMessages[DEFAULT_EMAIL_LOCALE]
  );
}
