import { providerConfigSchema, type ProviderConfig, type ProviderConfigInput } from './config.js';
import { effectiveOutputLimits, type OutputLimits } from './output-limits.js';
import type { AnyProvider, Capability } from './types.js';
import { AIError } from './errors.js';
import { redact, type AuditSink } from './audit.js';
import type { SystemContext } from './auth.js';
import type { ResolveCredential } from './credentials.js';

/** Builds an adapter for ONE call/org with the credential resolved for that org. No global key-bound clients. */
export type AdapterFactory = (cfg: ProviderConfig, apiKey: string | undefined, opts?: { outputLimits: OutputLimits }) => AnyProvider;

/** Per-org credential override (BYO key), from org config. */
export type OrgCredentialRefs = Record<string, string | undefined>;

/** Global (platform-level) registry of provider definitions. Tenant choices live in the router. */
export class ProviderRegistry {
  private readonly configs = new Map<string, ProviderConfig>();
  constructor(
    private readonly factories: Record<string, AdapterFactory>,
    private readonly resolveCredential: ResolveCredential,
    private readonly audit: AuditSink,
  ) {
    if (!audit) throw new AIError('CONFIG_INVALID', 'AuditSink is required');
  }

  /** Register/replace a provider definition. Platform-only; audit is awaited and required (failure aborts). */
  async register(input: ProviderConfigInput, ctx: SystemContext): Promise<ProviderConfig> {
    if (!ctx?.system || !ctx.userId) throw new AIError('FORBIDDEN', 'provider registry changes require a system context', { retryable: false });
    const config = providerConfigSchema.parse(input);
    const before = this.configs.get(config.name);
    try {
      await this.audit.emit({
        action: before ? 'update' : 'create',
        organizationId: null,
        actorId: ctx.userId,
        provider: config.name,
        before: before ? redact(before) : undefined,
        after: redact(config),
        at: new Date().toISOString(),
      });
    } catch (e) {
      throw new AIError('AUDIT_FAILED', 'audit write failed; change aborted', { retryable: true, cause: e });
    }
    this.configs.set(config.name, config);
    return config;
  }

  list(): ProviderConfig[] {
    return [...this.configs.values()];
  }

  getConfig(name: string): ProviderConfig | undefined {
    return this.configs.get(name);
  }

  /** Static availability (enabled + adapter). Credentials are checked per call, per org. */
  availability(name: string): { available: boolean; reason?: string | undefined } {
    const c = this.configs.get(name);
    if (!c) return { available: false, reason: 'unknown provider' };
    if (!c.enabled) return { available: false, reason: 'provider disabled' };
    if (!this.factories[c.adapter]) return { available: false, reason: 'no adapter' };
    return { available: true };
  }

  supports(name: string, cap: Capability): boolean {
    return this.configs.get(name)?.capabilities.includes(cap) ?? false;
  }

  /**
   * Build an adapter for this call. Credential precedence: org BYO ref (if set) ELSE platform ref (plan-gated by the
   * resolver). A failing BYO ref never falls back to the platform key.
   */
  async instantiate<T extends AnyProvider = AnyProvider>(name: string, ctx: { organizationId: string; orgCredentialRefs?: OrgCredentialRefs | undefined; feature?: string | undefined }): Promise<T> {
    const c = this.configs.get(name);
    const av = this.availability(name);
    if (!c || !av.available) throw new AIError(c && !c.enabled ? 'PROVIDER_DISABLED' : 'PROVIDER_UNAVAILABLE', av.reason ?? 'unavailable', { provider: name, retryable: false });
    const ref = ctx.orgCredentialRefs?.[name] ?? c.credentialRef;
    const key = ref ? await this.resolveCredential(ref, { organizationId: ctx.organizationId }) : undefined;
    const factory = this.factories[c.adapter]!;
    return factory(c, key, { outputLimits: effectiveOutputLimits(c.outputLimits, ctx.feature) }) as T;
  }

  markHealth(name: string, status: ProviderConfig['health']['status'], reason?: string) {
    const c = this.configs.get(name);
    if (!c) return;
    const at = new Date().toISOString();
    this.configs.set(name, { ...c, health: reason === undefined ? { status, checkedAt: at } : { status, reason, checkedAt: at } });
  }
}
