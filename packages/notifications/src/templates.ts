import type { EmailAttachment } from './types.js';
import type { EmailTemplateId } from '@meetops/contracts';

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
  /** Set for product mails with an unsubscribe link (RFC 2369 / RFC 8058 one-click). */
  headers?: Record<string, string>;
  /** Inline CID images (renderEmail from PR #195 returns these); transports send them inline. */
  attachments?: EmailAttachment[];
}

/**
 * Product (non-transactional) mails carry a preferences link and, when the recipient can opt out, a signed
 * one-click unsubscribe link (see unsubscribe-token.ts). Shapes match PR #195's EmailVariables so the same
 * payloads render through renderEmail(name, vars) once #195 lands.
 */
export interface ProductLinks {
  preferencesUrl: string;
  unsubscribeUrl?: string | undefined;
}

export interface TemplateVariables {
  verification: { name?: string; verificationUrl: string; expiresInHours: number };
  'password-reset': { name?: string; resetUrl: string; expiresInMinutes: number };
  invitation: {
    name?: string;
    inviterName: string;
    workspaceName: string;
    inviteUrl: string;
    role?: string;
    expiresInDays?: number;
  };
  'task-assigned': Partial<ProductLinks> & {
    assigneeName: string;
    taskTitle: string;
    taskUrl: string;
    assignedBy?: string;
    dueDate?: string;
    meetingTitle?: string;
  };
  'meeting-summary': Partial<ProductLinks> & {
    recipientName: string;
    meetingTitle: string;
    meetingDate: string;
    summary: string;
    actionItems: { title: string; owner?: string; dueDate?: string }[];
    meetingUrl: string;
  };
  'member-added': ProductLinks & {
    name?: string;
    workspaceName: string;
    addedBy: string;
    role?: string;
    workspaceUrl: string;
  };
  'member-removed': ProductLinks & { name?: string; workspaceName: string; removedBy?: string };
  'tasks-ready-for-review': ProductLinks & {
    name?: string;
    meetingTitle: string;
    taskTitles: string[];
    taskCount?: number;
    reviewUrl: string;
  };
  'integration-error': ProductLinks & {
    name?: string;
    provider: string;
    workspaceName: string;
    reason?: string;
    failingSince?: string;
    settingsUrl: string;
  };
}

export type TemplateName = keyof TemplateVariables;
export type EmailTemplate<K extends TemplateName> = (vars: TemplateVariables[K]) => RenderedEmail;

export function escapeHtml(value: unknown): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Only allow http(s) links in templates to avoid javascript: URLs. */
export function safeUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.protocol === 'http:' || u.protocol === 'https:') return u.toString();
  } catch {
    /* fallthrough */
  }
  throw new Error('Template URL must be an absolute http(s) URL');
}

function layout(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head><body style="font-family:Arial,sans-serif;line-height:1.5;color:#111">${body}<p style="color:#666;font-size:12px">— MeetOps</p></body></html>`;
}

/** Footer with preferences and (optional) unsubscribe links. URLs are validated and escaped. */
function productFooter(links: Partial<ProductLinks>): { html: string; text: string } {
  const parts: [string, string][] = [];
  if (links.preferencesUrl) parts.push(['Email preferences', safeUrl(links.preferencesUrl)]);
  if (links.unsubscribeUrl) parts.push(['Unsubscribe', safeUrl(links.unsubscribeUrl)]);
  if (!parts.length) return { html: '', text: '' };
  return {
    html: `<p style="color:#666;font-size:12px">${parts.map(([l, u]) => `<a href="${escapeHtml(u)}" style="color:#666">${escapeHtml(l)}</a>`).join(' · ')}</p>`,
    text: `\n\n${parts.map(([l, u]) => `${l}: ${u}`).join('\n')}`,
  };
}

/**
 * RFC 2369 List-Unsubscribe + RFC 8058 one-click. The URL must be https, contain no whitespace/control chars
 * or angle brackets, so it cannot break out of the header (no header injection).
 */
export function listUnsubscribeHeaders(unsubscribeUrl: string): Record<string, string> {
  const url = safeUrl(unsubscribeUrl);
  // eslint-disable-next-line no-control-regex
  if (!url.startsWith('https://') || /[\s<>\u0000-\u001f\u007f]/.test(url)) {
    throw new Error('List-Unsubscribe URL must be a clean https URL');
  }
  return { 'List-Unsubscribe': `<${url}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' };
}

const hi = (name: string | undefined) => `Hi ${name ?? 'there'},`;

function button(url: string, label: string): string {
  return `<p><a href="${escapeHtml(url)}" style="display:inline-block;padding:10px 16px;background:#2563eb;color:#fff;text-decoration:none;border-radius:6px">${escapeHtml(label)}</a></p>`;
}

export const templates: { [K in TemplateName]: EmailTemplate<K> } = {
  verification: (v) => {
    const url = safeUrl(v.verificationUrl);
    const subject = 'Verify your email address';
    return {
      subject,
      html: layout(
        subject,
        `<p>Hi ${escapeHtml(v.name ?? 'there')},</p><p>Please confirm your email address.</p>${button(url, 'Verify email')}<p>This link expires in ${escapeHtml(v.expiresInHours)} hours.</p>`,
      ),
      text: `Hi ${v.name ?? 'there'},\n\nPlease confirm your email address:\n${url}\n\nThis link expires in ${v.expiresInHours} hours.`,
    };
  },
  'password-reset': (v) => {
    const url = safeUrl(v.resetUrl);
    const subject = 'Reset your password';
    return {
      subject,
      html: layout(
        subject,
        `<p>Hi ${escapeHtml(v.name ?? 'there')},</p><p>We received a request to reset your password.</p>${button(url, 'Reset password')}<p>This link expires in ${escapeHtml(v.expiresInMinutes)} minutes. If you didn't request this, you can ignore this email.</p>`,
      ),
      text: `Hi ${v.name ?? 'there'},\n\nReset your password:\n${url}\n\nThis link expires in ${v.expiresInMinutes} minutes. If you didn't request this, ignore this email.`,
    };
  },
  invitation: (v) => {
    const url = safeUrl(v.inviteUrl);
    const subject = `${v.inviterName} invited you to ${v.workspaceName} on MeetOps`;
    const role = v.role ? ` as ${v.role}` : '';
    const hi = v.name ? `Hi ${v.name},\n\n` : '';
    const exp = v.expiresInDays ? `This invitation expires in ${v.expiresInDays} days.` : '';
    return {
      subject,
      html: layout(
        subject,
        `${v.name ? `<p>Hi ${escapeHtml(v.name)},</p>` : ''}<p>${escapeHtml(v.inviterName)} invited you to join <strong>${escapeHtml(v.workspaceName)}</strong>${escapeHtml(role)}.</p>${button(url, 'Accept invitation')}${exp ? `<p>${escapeHtml(exp)}</p>` : ''}`,
      ),
      text: `${hi}${v.inviterName} invited you to join ${v.workspaceName}${role}.\n\nAccept: ${url}${exp ? `\n\n${exp}` : ''}`,
    };
  },
  'task-assigned': (v) => {
    const url = safeUrl(v.taskUrl);
    const subject = `New task assigned: ${v.taskTitle}`;
    const extra: string[] = [];
    if (v.assignedBy) extra.push(`Assigned by: ${v.assignedBy}`);
    if (v.meetingTitle) extra.push(`From meeting: ${v.meetingTitle}`);
    if (v.dueDate) extra.push(`Due: ${v.dueDate}`);
    return {
      subject,
      html: layout(
        subject,
        `<p>Hi ${escapeHtml(v.assigneeName)},</p><p>You have been assigned <strong>${escapeHtml(v.taskTitle)}</strong>.</p>${extra.length ? `<ul>${extra.map((e) => `<li>${escapeHtml(e)}</li>`).join('')}</ul>` : ''}${button(url, 'View task')}`,
      ),
      text: `Hi ${v.assigneeName},\n\nYou have been assigned: ${v.taskTitle}\n${extra.join('\n')}${extra.length ? '\n' : ''}\nView: ${url}`,
    };
  },
  'meeting-summary': (v) => {
    const url = safeUrl(v.meetingUrl);
    const subject = `Summary: ${v.meetingTitle} (${v.meetingDate})`;
    const item = (a: TemplateVariables['meeting-summary']['actionItems'][number]) =>
      [a.title, a.owner ? `owner: ${a.owner}` : '', a.dueDate ? `due: ${a.dueDate}` : '']
        .filter(Boolean)
        .join(' — ');
    const items = v.actionItems.map(item);
    return {
      subject,
      html: layout(
        subject,
        `<p>Hi ${escapeHtml(v.recipientName)},</p><h2>${escapeHtml(v.meetingTitle)}</h2><p>${escapeHtml(v.summary).replace(/\n/g, '<br>')}</p>${items.length ? `<h3>Action items</h3><ul>${items.map((i) => `<li>${escapeHtml(i)}</li>`).join('')}</ul>` : ''}${button(url, 'Open meeting')}`,
      ),
      text: `Hi ${v.recipientName},\n\n${v.meetingTitle} (${v.meetingDate})\n\n${v.summary}\n${items.length ? `\nAction items:\n${items.map((i) => `- ${i}`).join('\n')}\n` : ''}\nOpen: ${url}`,
    };
  },
  'member-added': (v) => {
    const url = safeUrl(v.workspaceUrl);
    const subject = `You were added to ${v.workspaceName}`;
    const role = v.role ? ` as ${v.role}` : '';
    return {
      subject,
      html: layout(
        subject,
        `<p>${escapeHtml(hi(v.name))}</p><p>${escapeHtml(v.addedBy)} added you to <strong>${escapeHtml(v.workspaceName)}</strong>${escapeHtml(role)}.</p>${button(url, 'Open workspace')}`,
      ),
      text: `${hi(v.name)}\n\n${v.addedBy} added you to ${v.workspaceName}${role}.\n\nOpen: ${url}`,
    };
  },
  'member-removed': (v) => {
    const subject = `You were removed from ${v.workspaceName}`;
    const by = v.removedBy ? ` by ${v.removedBy}` : '';
    return {
      subject,
      html: layout(
        subject,
        `<p>${escapeHtml(hi(v.name))}</p><p>You were removed from <strong>${escapeHtml(v.workspaceName)}</strong>${escapeHtml(by)}. You no longer have access to its meetings and tasks.</p>`,
      ),
      text: `${hi(v.name)}\n\nYou were removed from ${v.workspaceName}${by}. You no longer have access to its meetings and tasks.`,
    };
  },
  'tasks-ready-for-review': (v) => {
    const url = safeUrl(v.reviewUrl);
    const count = v.taskCount ?? v.taskTitles.length;
    const subject = `${count} task${count === 1 ? '' : 's'} ready for review: ${v.meetingTitle}`;
    return {
      subject,
      html: layout(
        subject,
        `<p>${escapeHtml(hi(v.name))}</p><p>${escapeHtml(count)} task${count === 1 ? '' : 's'} from <strong>${escapeHtml(v.meetingTitle)}</strong> ${count === 1 ? 'is' : 'are'} ready for your review.</p>${v.taskTitles.length ? `<ul>${v.taskTitles.map((t) => `<li>${escapeHtml(t)}</li>`).join('')}</ul>` : ''}${button(url, 'Review tasks')}`,
      ),
      text: `${hi(v.name)}\n\n${count} task${count === 1 ? '' : 's'} from ${v.meetingTitle} ready for review:\n${v.taskTitles.map((t) => `- ${t}`).join('\n')}\n\nReview: ${url}`,
    };
  },
  'integration-error': (v) => {
    const url = safeUrl(v.settingsUrl);
    const subject = `${v.provider} integration needs attention in ${v.workspaceName}`;
    const lines = [
      v.reason ? `Reason: ${v.reason}` : '',
      v.failingSince ? `Failing since: ${v.failingSince}` : '',
    ].filter(Boolean);
    return {
      subject,
      html: layout(
        subject,
        `<p>${escapeHtml(hi(v.name))}</p><p>The <strong>${escapeHtml(v.provider)}</strong> integration in <strong>${escapeHtml(v.workspaceName)}</strong> is failing.</p>${lines.length ? `<ul>${lines.map((l) => `<li>${escapeHtml(l)}</li>`).join('')}</ul>` : ''}${button(url, 'Open integration settings')}`,
      ),
      text: `${hi(v.name)}\n\nThe ${v.provider} integration in ${v.workspaceName} is failing.\n${lines.join('\n')}${lines.length ? '\n' : ''}\nSettings: ${url}`,
    };
  },
};

export function renderTemplate<K extends TemplateName>(
  name: K,
  vars: TemplateVariables[K],
): RenderedEmail {
  const tpl = templates[name] as EmailTemplate<K> | undefined;
  if (!tpl) throw new Error(`Unknown email template: ${String(name)}`);
  const out = tpl(vars);
  const links = vars as Partial<ProductLinks>;
  const footer = productFooter(links);
  const rendered: RenderedEmail = {
    // Subjects interpolate user data; strip CR/LF to prevent header injection.
    // eslint-disable-next-line no-control-regex
    subject: out.subject.replace(/[\r\n\u0000-\u001f\u007f]+/g, ' ').trim(),
    html: footer.html
      ? out.html.replace('</body></html>', `${footer.html}</body></html>`)
      : out.html,
    text: out.text + footer.text,
  };
  const headers = links.unsubscribeUrl ? listUnsubscribeHeaders(links.unsubscribeUrl) : undefined;
  return headers ? { ...rendered, headers } : rendered;
}

export const templateNames = Object.keys(templates) as TemplateName[];

/** Contract template ids; the registry must cover exactly these (checked at compile time). */
export { EMAIL_TEMPLATE_IDS } from '@meetops/contracts';
type RegistryMatchesContract = [EmailTemplateId] extends [TemplateName]
  ? [TemplateName] extends [EmailTemplateId]
    ? true
    : never
  : never;
export const REGISTRY_MATCHES_CONTRACT: RegistryMatchesContract = true;
