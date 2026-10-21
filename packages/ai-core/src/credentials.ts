import { AIError } from './errors.js';

/** Server-decided org plan (Backend/billing). Platform keys are an entitlement, never a fallback. */
export type OrgPlan = { platformKeys: boolean };
export type OrgPlanResolver = (orgId: string) => Promise<OrgPlan>;

/** Raw secret lookup (env / secret manager). Supplied by the host app. */
export type SecretSource = {
  env: (name: string) => string | undefined;
  secret: (path: string) => Promise<string | undefined>;
};

export type CredentialContext = { orgId: string };

/**
 * Call-time credential resolution.
 * - `secret:org/{orgId}/...` (BYO): must belong to ctx.orgId, else rejected.
 * - `env:NAME` (platform key): only if the org's server-side plan grants platform keys.
 * Any other secret path is rejected.
 */
export function createCredentialResolver(src: SecretSource, plans: OrgPlanResolver) {
  return async function resolveCredential(ref: string, ctx: CredentialContext): Promise<string> {
    if (!ctx?.orgId) throw new AIError('FORBIDDEN', 'orgId required for credential resolution', { retryable: false });
    if (ref.startsWith('secret:')) {
      const path = ref.slice(7);
      const m = /^org\/([^/]+)\/.+$/.exec(path);
      if (!m || m[1] !== ctx.orgId) throw new AIError('FORBIDDEN', 'credential does not belong to this organization', { retryable: false });
      const v = await src.secret(path);
      if (!v) throw new AIError('MISSING_CREDENTIALS', 'organization credential not found', { retryable: false });
      return v;
    }
    if (ref.startsWith('env:')) {
      const plan = await plans(ctx.orgId);
      if (!plan.platformKeys) throw new AIError('MISSING_CREDENTIALS', 'platform credentials not enabled for this organization plan', { retryable: false });
      const v = src.env(ref.slice(4));
      if (!v || v.trim() === '') throw new AIError('MISSING_CREDENTIALS', 'platform credential not configured', { retryable: false });
      return v;
    }
    throw new AIError('FORBIDDEN', 'unsupported credential reference', { retryable: false });
  };
}
export type ResolveCredential = ReturnType<typeof createCredentialResolver>;
