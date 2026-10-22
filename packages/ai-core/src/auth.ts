import { AIError } from './errors.js';

/**
 * Minimal CASL-compatible ability. The repo has no shared CASL/auth package yet; Backend should pass a real
 * `@casl/ability` `Ability` (its `can(action, subject)` signature is compatible).
 */
export interface Ability {
  can(action: AIAction, subject: AISubject): boolean;
}
export type AIAction = 'manage' | 'override' | 'read';
export type AISubject = 'ProviderConfig' | 'ProviderRegistry' | 'AIRoute';

/** Server-derived caller context. Never built from request payloads. */
export type TenantContext = {
  organizationId: string;
  userId: string;
  requestId?: string | undefined;
  ability: Ability;
};

/** Platform context for system bootstrap (registry definitions). */
export type SystemContext = { system: true; userId: string; requestId?: string | undefined };

export function assertCan(ctx: TenantContext, action: AIAction, subject: AISubject): void {
  if (!ctx?.ability?.can(action, subject)) throw new AIError('FORBIDDEN', `Not allowed to ${action} ${subject}`, { retryable: false });
}

/** Ability for org owner/admin per docs/09-security rbac (owner/admin => manage ProviderConfig). */
export function roleAbility(role: 'owner' | 'admin' | 'member' | 'viewer'): Ability {
  const admin = role === 'owner' || role === 'admin';
  return { can: (action, subject) => (subject === 'ProviderRegistry' ? false : admin || (action === 'read' && subject !== 'AIRoute')) };
}
