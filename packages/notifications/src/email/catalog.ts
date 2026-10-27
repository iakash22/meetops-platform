import { cleanSubject, safeUrl } from './escape.js';
import {
  bulletList,
  button,
  chips,
  heading,
  itemList,
  join,
  layout,
  linkFallback,
  panel,
  paragraph,
  textLayout,
} from './layout.js';
import { BANNER_CID, bannerGif, type BannerCategory } from './banner.js';
import { logoAttachment } from './logo.js';
import { DEFAULT_EMAIL_LOCALE, emailMessages, messagesFor, type EmailMessages } from './strings.js';

/** Inline image referenced from the HTML as cid:<cid> (nodemailer `attachments` shape, base64 content). */
export interface InlineAttachment {
  filename: string;
  cid: string;
  contentType: string;
  content: string;
  encoding: 'base64';
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
  /** The logo, referenced from the HTML as cid:meetops-logo@meetops. Send it with the message. */
  attachments: InlineAttachment[];
}

const LOGO: InlineAttachment = {
  filename: logoAttachment.filename,
  cid: logoAttachment.cid,
  contentType: logoAttachment.contentType,
  content: logoAttachment.contentBase64,
  encoding: 'base64',
};

/** Common to every template. `locale` falls back to English. */
interface Base {
  locale?: string;
}
/** Non-auth (product) mail must carry a preferences link; `unsubscribeUrl` is a one-click link for this mail type. */
interface Product extends Base {
  preferencesUrl: string;
  unsubscribeUrl?: string | undefined;
}

/**
 * Variables for every product email. Names for the five contract templates (verification, password-reset,
 * invitation, task-assigned, meeting-summary) match @meetops/contracts EMAIL_TEMPLATE_IDS; the auth-mail kinds
 * (account_exists, login_lockout) match apps/api AuthMailTemplate in kebab case.
 */
export interface EmailVariables {
  verification: Base & { name?: string; verificationUrl: string; expiresInHours: number };
  'password-reset': Base & { name?: string; resetUrl: string; expiresInMinutes: number };
  invitation: Base & {
    inviterName: string;
    workspaceName: string;
    inviteUrl: string;
    role?: string;
    expiresInDays?: number;
  };
  'account-exists': Base & { name?: string; resetUrl: string };
  'login-lockout': Base & { name?: string; resetUrl: string; lockedForMinutes?: number };
  'password-changed': Base & { name?: string; changedAt: string; resetUrl: string };
  'member-added': Product & {
    name?: string;
    workspaceName: string;
    addedBy: string;
    role?: string;
    workspaceUrl: string;
  };
  'member-removed': Product & { name?: string; workspaceName: string; removedBy?: string };
  'meeting-summary': Base & {
    recipientName?: string;
    meetingTitle: string;
    meetingDate: string;
    summary: string;
    actionItems: { title: string; owner?: string; dueDate?: string }[];
    meetingUrl: string;
    /** Optional only for backward compatibility with contract callers; product senders must set it. */
    preferencesUrl?: string | undefined;
    unsubscribeUrl?: string | undefined;
  };
  'tasks-ready-for-review': Product & {
    name?: string;
    meetingTitle: string;
    taskTitles: string[];
    taskCount?: number;
    reviewUrl: string;
  };
  'task-assigned': Base & {
    assigneeName?: string;
    taskTitle: string;
    taskUrl: string;
    assignedBy?: string;
    dueDate?: string;
    meetingTitle?: string;
    preferencesUrl?: string | undefined;
    unsubscribeUrl?: string | undefined;
  };
  'integration-error': Product & {
    name?: string;
    provider: 'GitHub' | 'Jira' | (string & {});
    workspaceName: string;
    reason?: string;
    failingSince?: string;
    settingsUrl: string;
  };
}

export type EmailName = keyof EmailVariables;
/** Auth/security mail: always sent, no unsubscribe link. */
export const AUTH_EMAILS = [
  'verification',
  'password-reset',
  'invitation',
  'account-exists',
  'login-lockout',
  'password-changed',
] as const satisfies readonly EmailName[];

const MAX_LIST = 5;
const greet = (m: EmailMessages, name?: string) => (name ? m.greeting(name) : m.greetingFallback);

interface Parts {
  subject: string;
  /** Rendered on the hero banner: chip label and main heading (live text). */
  eyebrow: string;
  title: string;
  preheader: string;
  body: Parameters<typeof join>;
  text: (string | false | 0 | undefined)[];
  preferencesUrl?: string | undefined;
  unsubscribeUrl?: string | undefined;
}

const CATEGORY: Record<EmailName, BannerCategory> = {
  verification: 'security',
  'password-reset': 'security',
  'account-exists': 'security',
  'login-lockout': 'security',
  'password-changed': 'security',
  invitation: 'workspace',
  'member-added': 'workspace',
  'member-removed': 'workspace',
  'meeting-summary': 'meeting',
  'tasks-ready-for-review': 'tasks',
  'task-assigned': 'tasks',
  'integration-error': 'integration',
};

const BANNER: InlineAttachment = {
  filename: 'meetops-banner.gif',
  cid: BANNER_CID,
  contentType: 'image/gif',
  content: bannerGif,
  encoding: 'base64',
};

function build(
  locale: string | undefined,
  p: Parts,
  m: EmailMessages,
  category: BannerCategory,
): RenderedEmail {
  const subject = cleanSubject(p.subject);
  return {
    subject,
    html: layout({
      lang: locale && locale in emailMessages ? locale : DEFAULT_EMAIL_LOCALE,
      subject,
      preheader: p.preheader,
      body: join(...p.body),
      m,
      preferencesUrl: p.preferencesUrl,
      unsubscribeUrl: p.unsubscribeUrl,
      banner: {
        category,
        alt: m.bannerAlt(m.bannerLabel[category]),
        eyebrow: p.eyebrow,
        title: p.title,
      },
    }),
    text: textLayout({
      m,
      lines: p.text,
      preferencesUrl: p.preferencesUrl,
      unsubscribeUrl: p.unsubscribeUrl,
    }),
    attachments: [{ ...LOGO }, { ...BANNER }],
  };
}

type Renderer<K extends EmailName> = (v: EmailVariables[K], m: EmailMessages) => Parts;

const renderers: { [K in EmailName]: Renderer<K> } = {
  verification: (v, m) => {
    const url = safeUrl(v.verificationUrl);
    const c = m.verification;
    return {
      subject: c.subject,
      preheader: c.preheader,
      eyebrow: m.eyebrow.account,
      title: c.subject,
      body: [
        paragraph(greet(m, v.name)),
        paragraph(c.body),
        button(url, c.cta),
        paragraph(c.expires(v.expiresInHours), { muted: true }),
        linkFallback(url, m),
        paragraph(c.ignore, { muted: true, small: true }),
      ],
      text: [greet(m, v.name), c.body, `${c.cta}: ${url}`, c.expires(v.expiresInHours), c.ignore],
    };
  },
  'password-reset': (v, m) => {
    const url = safeUrl(v.resetUrl);
    const c = m.passwordReset;
    return {
      subject: c.subject,
      preheader: c.preheader,
      eyebrow: m.eyebrow.security,
      title: c.subject,
      body: [
        paragraph(greet(m, v.name)),
        paragraph(c.body),
        button(url, c.cta),
        paragraph(c.expires(v.expiresInMinutes), { muted: true }),
        linkFallback(url, m),
        paragraph(c.ignore, { muted: true, small: true }),
      ],
      text: [greet(m, v.name), c.body, `${c.cta}: ${url}`, c.expires(v.expiresInMinutes), c.ignore],
    };
  },
  invitation: (v, m) => {
    const url = safeUrl(v.inviteUrl);
    const c = m.invitation;
    const role = v.role ? c.role(v.role) : undefined;
    const exp = v.expiresInDays ? c.expires(v.expiresInDays) : undefined;
    return {
      subject: c.subject(v.inviterName, v.workspaceName),
      preheader: c.preheader(v.workspaceName),
      eyebrow: m.eyebrow.workspace,
      title: c.preheader(v.workspaceName),
      body: [
        paragraph(c.body(v.inviterName, v.workspaceName)),
        chips([v.role && c.role(v.role)], 'primary'),
        button(url, c.cta),
        exp && paragraph(exp, { muted: true }),
        linkFallback(url, m),
      ],
      text: [c.body(v.inviterName, v.workspaceName), role, `${c.cta}: ${url}`, exp],
    };
  },
  'account-exists': (v, m) => {
    const url = safeUrl(v.resetUrl);
    const c = m.accountExists;
    return {
      subject: c.subject,
      preheader: c.preheader,
      eyebrow: m.eyebrow.security,
      title: c.subject,
      body: [
        paragraph(greet(m, v.name)),
        paragraph(c.body),
        button(url, c.cta),
        linkFallback(url, m),
        paragraph(c.ignore, { muted: true, small: true }),
      ],
      text: [greet(m, v.name), c.body, `${c.cta}: ${url}`, c.ignore],
    };
  },
  'login-lockout': (v, m) => {
    const url = safeUrl(v.resetUrl);
    const c = m.lockout;
    return {
      subject: c.subject,
      preheader: c.preheader,
      eyebrow: m.eyebrow.security,
      title: c.subject,
      body: [
        paragraph(greet(m, v.name)),
        panel([c.body(v.lockedForMinutes)], 'destructive'),
        paragraph(c.notYou),
        button(url, c.cta),
        linkFallback(url, m),
      ],
      text: [greet(m, v.name), c.body(v.lockedForMinutes), c.notYou, `${c.cta}: ${url}`],
    };
  },
  'password-changed': (v, m) => {
    const url = safeUrl(v.resetUrl);
    const c = m.passwordChanged;
    return {
      subject: c.subject,
      preheader: c.preheader,
      eyebrow: m.eyebrow.security,
      title: c.subject,
      body: [
        paragraph(greet(m, v.name)),
        paragraph(c.body(v.changedAt)),
        panel([c.notYou], 'destructive'),
        button(url, c.cta),
        linkFallback(url, m),
      ],
      text: [greet(m, v.name), c.body(v.changedAt), c.notYou, `${c.cta}: ${url}`],
    };
  },
  'member-added': (v, m) => {
    const url = safeUrl(v.workspaceUrl);
    const c = m.memberAdded;
    const role = v.role ? c.role(v.role) : undefined;
    return {
      subject: c.subject(v.workspaceName),
      preheader: c.preheader(v.workspaceName),
      eyebrow: m.eyebrow.workspace,
      title: c.subject(v.workspaceName),
      body: [
        paragraph(greet(m, v.name)),
        paragraph(c.body(v.addedBy, v.workspaceName)),
        chips([v.role && c.role(v.role)], 'primary'),
        button(url, c.cta),
        linkFallback(url, m),
      ],
      text: [greet(m, v.name), c.body(v.addedBy, v.workspaceName), role, `${c.cta}: ${url}`],
      preferencesUrl: v.preferencesUrl,
      unsubscribeUrl: v.unsubscribeUrl,
    };
  },
  'member-removed': (v, m) => {
    const c = m.memberRemoved;
    const by = v.removedBy ? c.byLine(v.removedBy) : undefined;
    return {
      subject: c.subject(v.workspaceName),
      preheader: c.preheader(v.workspaceName),
      eyebrow: m.eyebrow.workspace,
      title: c.subject(v.workspaceName),
      body: [
        paragraph(greet(m, v.name)),
        paragraph(c.body(v.workspaceName)),
        by && paragraph(by, { muted: true }),
        paragraph(c.contact, { muted: true }),
      ],
      text: [greet(m, v.name), c.body(v.workspaceName), by, c.contact],
      preferencesUrl: v.preferencesUrl,
      unsubscribeUrl: v.unsubscribeUrl,
    };
  },
  'meeting-summary': (v, m) => {
    const url = safeUrl(v.meetingUrl);
    const c = m.meetingProcessed;
    const items = v.actionItems.map((a) =>
      [a.title, a.owner && c.owner(a.owner), a.dueDate && c.due(a.dueDate)]
        .filter(Boolean)
        .join(' — '),
    );
    return {
      subject: c.subject(v.meetingTitle),
      preheader: c.preheader(v.meetingTitle),
      eyebrow: m.eyebrow.meeting,
      title: v.meetingTitle,
      body: [
        chips([
          c.when(v.meetingDate),
          v.actionItems.length > 0 && m.meetingChips.actionItems(v.actionItems.length),
        ]),
        paragraph(greet(m, v.recipientName)),
        paragraph(c.intro),
        heading(c.summaryHeading),
        panel([v.summary]),
        items.length > 0 && heading(c.actionItemsHeading),
        itemList(
          v.actionItems.map((a) => ({
            title: a.title,
            meta: [a.owner && c.owner(a.owner), a.dueDate && c.due(a.dueDate)],
          })),
        ),
        button(url, c.cta),
        linkFallback(url, m),
      ],
      text: [
        greet(m, v.recipientName),
        `${v.meetingTitle} (${v.meetingDate})`,
        `${c.summaryHeading}:\n${v.summary}`,
        items.length > 0 && `${c.actionItemsHeading}:\n${items.map((i) => `- ${i}`).join('\n')}`,
        `${c.cta}: ${url}`,
      ],
      preferencesUrl: v.preferencesUrl,
      unsubscribeUrl: v.unsubscribeUrl,
    };
  },
  'tasks-ready-for-review': (v, m) => {
    const url = safeUrl(v.reviewUrl);
    const c = m.tasksReady;
    const n = v.taskCount ?? v.taskTitles.length;
    const shown = v.taskTitles.slice(0, MAX_LIST);
    const rest = n - shown.length;
    const list = rest > 0 ? [...shown, c.more(rest)] : shown;
    return {
      subject: c.subject(n, v.meetingTitle),
      preheader: c.preheader(n),
      eyebrow: m.eyebrow.tasks,
      title: c.subject(n, v.meetingTitle),
      body: [
        paragraph(greet(m, v.name)),
        paragraph(c.body(n, v.meetingTitle)),
        bulletList(list),
        button(url, c.cta),
        linkFallback(url, m),
      ],
      text: [
        greet(m, v.name),
        c.body(n, v.meetingTitle),
        list.map((i) => `- ${i}`).join('\n'),
        `${c.cta}: ${url}`,
      ],
      preferencesUrl: v.preferencesUrl,
      unsubscribeUrl: v.unsubscribeUrl,
    };
  },
  'task-assigned': (v, m) => {
    const url = safeUrl(v.taskUrl);
    const c = m.taskAssigned;
    const details = [
      v.assignedBy && c.by(v.assignedBy),
      v.meetingTitle && c.meeting(v.meetingTitle),
      v.dueDate && c.due(v.dueDate),
    ].filter((x): x is string => !!x);
    return {
      subject: c.subject(v.taskTitle),
      preheader: c.preheader(v.taskTitle),
      eyebrow: m.eyebrow.tasks,
      title: c.subject(v.taskTitle),
      body: [
        paragraph(greet(m, v.assigneeName)),
        paragraph(c.body),
        panel([v.taskTitle, ...details], 'primary', { titleFirst: true }),
        button(url, c.cta),
        linkFallback(url, m),
      ],
      text: [
        greet(m, v.assigneeName),
        `${c.body} ${v.taskTitle}`,
        details.join('\n') || undefined,
        `${c.cta}: ${url}`,
      ],
      preferencesUrl: v.preferencesUrl,
      unsubscribeUrl: v.unsubscribeUrl,
    };
  },
  'integration-error': (v, m) => {
    const url = safeUrl(v.settingsUrl);
    const c = m.integrationError;
    const details = [
      v.reason && c.reason(v.reason),
      v.failingSince && c.since(v.failingSince),
    ].filter((x): x is string => !!x);
    return {
      subject: c.subject(v.provider),
      preheader: c.preheader(v.provider),
      eyebrow: m.eyebrow.integration,
      title: c.subject(v.provider),
      body: [
        paragraph(greet(m, v.name)),
        paragraph(c.body(v.provider, v.workspaceName)),
        details.length > 0 && panel(details, 'destructive'),
        button(url, c.cta),
        linkFallback(url, m),
      ],
      text: [
        greet(m, v.name),
        c.body(v.provider, v.workspaceName),
        details.join('\n') || undefined,
        `${c.cta}: ${url}`,
      ],
      preferencesUrl: v.preferencesUrl,
      unsubscribeUrl: v.unsubscribeUrl,
    };
  },
};

export const emailNames = Object.keys(renderers) as EmailName[];

/** Render any MeetOps email. All user data is HTML-escaped; URLs must be absolute http(s). */
export function renderEmail<K extends EmailName>(name: K, vars: EmailVariables[K]): RenderedEmail {
  const r = renderers[name] as Renderer<K> | undefined;
  if (!r) throw new Error(`Unknown email template: ${String(name)}`);
  const m = messagesFor(vars.locale);
  return build(vars.locale, r(vars, m), m, CATEGORY[name]);
}
