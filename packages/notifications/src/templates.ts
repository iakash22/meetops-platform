import type { EmailTemplateId } from '@meetops/contracts';
import { renderEmail, type EmailVariables, type RenderedEmail } from './email/catalog.js';

export type { RenderedEmail } from './email/catalog.js';
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
};

export function renderTemplate<K extends TemplateName>(
  name: K,
  vars: TemplateVariables[K],
): RenderedEmail {
  const tpl = templates[name] as EmailTemplate<K> | undefined;
  if (!tpl) throw new Error(`Unknown email template: ${String(name)}`);
  // renderEmail already strips CR/LF from subjects (header injection).
  return tpl(vars);
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
