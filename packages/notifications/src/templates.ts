export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

export interface TemplateVariables {
  verification: { name: string; verificationUrl: string; expiresInHours: number };
  'password-reset': { name: string; resetUrl: string; expiresInMinutes: number };
  invitation: { inviterName: string; workspaceName: string; inviteUrl: string; role?: string };
  'task-assigned': {
    assigneeName: string;
    taskTitle: string;
    taskUrl: string;
    assignedBy?: string;
    dueDate?: string;
    meetingTitle?: string;
  };
  'meeting-summary': {
    recipientName: string;
    meetingTitle: string;
    meetingDate: string;
    summary: string;
    actionItems: { title: string; owner?: string; dueDate?: string }[];
    meetingUrl: string;
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

function button(url: string, label: string): string {
  return `<p><a href="${escapeHtml(url)}" style="display:inline-block;padding:10px 16px;background:#2563eb;color:#fff;text-decoration:none;border-radius:6px">${escapeHtml(label)}</a></p>`;
}

export const templates: { [K in TemplateName]: EmailTemplate<K> } = {
  verification: (v) => {
    const url = safeUrl(v.verificationUrl);
    const subject = 'Verify your email address';
    return {
      subject,
      html: layout(subject, `<p>Hi ${escapeHtml(v.name)},</p><p>Please confirm your email address.</p>${button(url, 'Verify email')}<p>This link expires in ${escapeHtml(v.expiresInHours)} hours.</p>`),
      text: `Hi ${v.name},\n\nPlease confirm your email address:\n${url}\n\nThis link expires in ${v.expiresInHours} hours.`
    };
  },
  'password-reset': (v) => {
    const url = safeUrl(v.resetUrl);
    const subject = 'Reset your password';
    return {
      subject,
      html: layout(subject, `<p>Hi ${escapeHtml(v.name)},</p><p>We received a request to reset your password.</p>${button(url, 'Reset password')}<p>This link expires in ${escapeHtml(v.expiresInMinutes)} minutes. If you didn't request this, you can ignore this email.</p>`),
      text: `Hi ${v.name},\n\nReset your password:\n${url}\n\nThis link expires in ${v.expiresInMinutes} minutes. If you didn't request this, ignore this email.`
    };
  },
  invitation: (v) => {
    const url = safeUrl(v.inviteUrl);
    const subject = `${v.inviterName} invited you to ${v.workspaceName} on MeetOps`;
    const role = v.role ? ` as ${v.role}` : '';
    return {
      subject,
      html: layout(subject, `<p>${escapeHtml(v.inviterName)} invited you to join <strong>${escapeHtml(v.workspaceName)}</strong>${escapeHtml(role)}.</p>${button(url, 'Accept invitation')}`),
      text: `${v.inviterName} invited you to join ${v.workspaceName}${role}.\n\nAccept: ${url}`
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
      html: layout(subject, `<p>Hi ${escapeHtml(v.assigneeName)},</p><p>You have been assigned <strong>${escapeHtml(v.taskTitle)}</strong>.</p>${extra.length ? `<ul>${extra.map((e) => `<li>${escapeHtml(e)}</li>`).join('')}</ul>` : ''}${button(url, 'View task')}`),
      text: `Hi ${v.assigneeName},\n\nYou have been assigned: ${v.taskTitle}\n${extra.join('\n')}${extra.length ? '\n' : ''}\nView: ${url}`
    };
  },
  'meeting-summary': (v) => {
    const url = safeUrl(v.meetingUrl);
    const subject = `Summary: ${v.meetingTitle} (${v.meetingDate})`;
    const item = (a: TemplateVariables['meeting-summary']['actionItems'][number]) =>
      [a.title, a.owner ? `owner: ${a.owner}` : '', a.dueDate ? `due: ${a.dueDate}` : ''].filter(Boolean).join(' — ');
    const items = v.actionItems.map(item);
    return {
      subject,
      html: layout(subject, `<p>Hi ${escapeHtml(v.recipientName)},</p><h2>${escapeHtml(v.meetingTitle)}</h2><p>${escapeHtml(v.summary).replace(/\n/g, '<br>')}</p>${items.length ? `<h3>Action items</h3><ul>${items.map((i) => `<li>${escapeHtml(i)}</li>`).join('')}</ul>` : ''}${button(url, 'Open meeting')}`),
      text: `Hi ${v.recipientName},\n\n${v.meetingTitle} (${v.meetingDate})\n\n${v.summary}\n${items.length ? `\nAction items:\n${items.map((i) => `- ${i}`).join('\n')}\n` : ''}\nOpen: ${url}`
    };
  }
};

export function renderTemplate<K extends TemplateName>(name: K, vars: TemplateVariables[K]): RenderedEmail {
  const tpl = templates[name] as EmailTemplate<K> | undefined;
  if (!tpl) throw new Error(`Unknown email template: ${String(name)}`);
  const out = tpl(vars);
  // Subjects interpolate user data; strip CR/LF to prevent header injection.
  // eslint-disable-next-line no-control-regex
  return { ...out, subject: out.subject.replace(/[\r\n\u0000-\u001f\u007f]+/g, ' ').trim() };
}

export const templateNames = Object.keys(templates) as TemplateName[];
