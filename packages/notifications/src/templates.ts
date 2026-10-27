import type { EmailTemplateId } from '@meetops/contracts';
import {
  renderEmail,
  type EmailVariables,
  type RenderedEmail as CatalogRenderedEmail,
} from './email/catalog.js';

import { safeUrl as checkUrl } from './email/escape.js';

/** #195's rendered mail plus optional transport headers (List-Unsubscribe for product mails). */
export type RenderedEmail = CatalogRenderedEmail & { headers?: Record<string, string> };
export { escapeHtml, safeUrl } from './email/escape.js';

/**
 * Queue-facing registry: exactly the @meetops/contracts EMAIL_TEMPLATE_IDS. Rendering is delegated to the themed
 * catalog in ./email (renderEmail), which also covers the auth and product mails that aren't queue templates yet.
 */
export type TemplateVariables = { [K in EmailTemplateId]: EmailVariables[K] };

export type TemplateName = keyof TemplateVariables;
export type EmailTemplate<K extends TemplateName> = (vars: TemplateVariables[K]) => RenderedEmail;

export const templates: { [K in TemplateName]: EmailTemplate<K> } = {
  verification: (v) => renderEmail('verification', v),
  'password-reset': (v) => renderEmail('password-reset', v),
  invitation: (v) => renderEmail('invitation', v),
  'task-assigned': (v) => renderEmail('task-assigned', v),
  'meeting-summary': (v) => renderEmail('meeting-summary', v),
  'member-added': (v) => renderEmail('member-added', v),
  'member-removed': (v) => renderEmail('member-removed', v),
  'tasks-ready-for-review': (v) => renderEmail('tasks-ready-for-review', v),
  'integration-error': (v) => renderEmail('integration-error', v),
};

/**
 * RFC 2369 List-Unsubscribe + RFC 8058 one-click. The URL must be https, contain no whitespace/control chars
 * or angle brackets, so it cannot break out of the header (no header injection).
 */
export function listUnsubscribeHeaders(unsubscribeUrl: string): Record<string, string> {
  const url = checkUrl(unsubscribeUrl);
  // eslint-disable-next-line no-control-regex
  if (!url.startsWith('https://') || /[\s<>\u0000-\u001f\u007f]/.test(url)) {
    throw new Error('List-Unsubscribe URL must be a clean https URL');
  }
  return { 'List-Unsubscribe': `<${url}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' };
}

export function renderTemplate<K extends TemplateName>(
  name: K,
  vars: TemplateVariables[K],
): RenderedEmail {
  const tpl = templates[name] as EmailTemplate<K> | undefined;
  if (!tpl) throw new Error(`Unknown email template: ${String(name)}`);
  // renderEmail already strips CR/LF from subjects (header injection).
  const out: RenderedEmail = tpl(vars);
  const unsubscribeUrl = (vars as { unsubscribeUrl?: string | undefined }).unsubscribeUrl;
  return unsubscribeUrl ? { ...out, headers: listUnsubscribeHeaders(unsubscribeUrl) } : out;
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
