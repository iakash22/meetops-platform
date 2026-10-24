import { parseCredentialRef, parseOrgSecretRef } from './credential-ref.js';
import { AIError } from './errors.js';

/** Server-decided org plan (Backend/billing). Platform keys are an entitlement, never a fallback. */
export type OrgPlan = { platformKeys: boolean };
export type OrgPlanResolver = (organizationId: string) => Promise<OrgPlan>;

/** Raw secret lookup (env / secret manager). Supplied by the host app. */
export type SecretSource = {
  env: (name: string) => string | undefined;
  secret: (path: string) => Promise<string | undefined>;
};

export type CredentialContext = { organizationId: string };

/**
 * Call-time credential resolution.
 * - `secret:org/{organizationId}/...` (BYO): must belong to ctx.organizationId, else rejected.
 * - `env:NAME` (platform key): only if the org's server-side plan grants platform keys.
 * Any other secret path is rejected.
 */
export function createCredentialResolver(src: SecretSource, plans: OrgPlanResolver) {
  return async function resolveCredential(ref: string, ctx: CredentialContext): Promise<string> {
    if (!ctx?.organizationId) throw new AIError('FORBIDDEN', 'organizationId required for credential resolution', { retryable: false });
    const parsed = parseCredentialRef(ref);
    if (parsed?.kind === 'secret') {
      const owned = parseOrgSecretRef(ref, ctx.organizationId);
      if (!owned) throw new AIError('FORBIDDEN', 'credential does not belong to this organization', { retryable: false });
      // Only the canonical, validated path ever reaches the secret store.
      const v = await src.secret(owned.path);
      if (!v) throw new AIError('MISSING_CREDENTIALS', 'organization credential not found', { retryable: false });
      return v;
    }
    if (parsed?.kind === 'env') {
      const plan = await plans(ctx.organizationId);
      if (!plan.platformKeys) throw new AIError('MISSING_CREDENTIALS', 'platform credentials not enabled for this organization plan', { retryable: false });
      const v = src.env(parsed.name);
      if (!v || v.trim() === '') throw new AIError('MISSING_CREDENTIALS', 'platform credential not configured', { retryable: false });
      return v;
    }
    throw new AIError('FORBIDDEN', 'unsupported credential reference', { retryable: false });
  };
}
export type ResolveCredential = ReturnType<typeof createCredentialResolver>;
