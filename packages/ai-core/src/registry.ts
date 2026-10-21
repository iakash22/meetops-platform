import { providerConfigSchema, type ProviderConfig, type ProviderConfigInput } from './config.js';
import type { AnyProvider, Capability } from './types.js';
import { AIError } from './errors.js';
import { redact, type AuditSink } from './audit.js';

export type CredentialResolver = (ref: string) => string | undefined;

/** Resolves "env:NAME" against a given env map. Secret-store refs must be supplied by the host app. */
export const envCredentialResolver =
  (env: Record<string, string | undefined> = process.env): CredentialResolver =>
  (ref) => {
    if (!ref.startsWith('env:')) return undefined;
    const v = env[ref.slice(4)];
    return v && v.trim() !== '' ? v : undefined;
  };

export type AdapterFactory = (cfg: ProviderConfig, apiKey: string | undefined) => AnyProvider;

type Entry = { config: ProviderConfig; instance?: AnyProvider | undefined; unavailableReason?: string | undefined };

/** Global (system-level) registry of provider definitions. Tenant choices live in the router. */
export class ProviderRegistry {
  private readonly entries = new Map<string, Entry>();
  constructor(
    private readonly factories: Record<string, AdapterFactory>,
    private readonly resolveCredential: CredentialResolver,
    private readonly audit?: AuditSink,
  ) {}

  register(input: ProviderConfigInput, actorId = 'system'): ProviderConfig {
    const config = providerConfigSchema.parse(input);
    const before = this.entries.get(config.name)?.config;
    this.entries.set(config.name, this.build(config));
    void this.audit?.emit({
      action: before ? 'update' : 'create',
      tenantId: null,
      actorId,
      provider: config.name,
      before: before ? redact(before) : undefined,
      after: redact(config),
      at: new Date().toISOString(),
    });
    return config;
  }

  private build(config: ProviderConfig): Entry {
    if (!config.enabled) return { config, unavailableReason: `Provider ${config.name} is disabled` };
    const factory = this.factories[config.adapter];
    if (!factory) return { config, unavailableReason: `No adapter registered for "${config.adapter}"` };
    let key: string | undefined;
    if (config.credentialRef) {
      key = this.resolveCredential(config.credentialRef);
      if (!key) return { config, unavailableReason: `Missing credential ${config.credentialRef} for ${config.name}` };
    }
    try {
      return { config, instance: factory(config, key) };
    } catch (e) {
      return { config, unavailableReason: `Failed to init ${config.name}: ${(e as Error).message}` };
    }
  }

  list(): ProviderConfig[] {
    return [...this.entries.values()].map((e) => e.config);
  }

  getConfig(name: string): ProviderConfig | undefined {
    return this.entries.get(name)?.config;
  }

  availability(name: string): { available: boolean; reason?: string | undefined } {
    const e = this.entries.get(name);
    if (!e) return { available: false, reason: `Unknown provider ${name}` };
    return e.instance ? { available: true } : { available: false, reason: e.unavailableReason };
  }

  supports(name: string, cap: Capability): boolean {
    return this.entries.get(name)?.config.capabilities.includes(cap) ?? false;
  }

  get<T extends AnyProvider = AnyProvider>(name: string): T {
    const e = this.entries.get(name);
    if (!e) throw new AIError('PROVIDER_UNAVAILABLE', `Unknown provider ${name}`, { provider: name, retryable: false });
    if (!e.instance) {
      const code = e.unavailableReason?.startsWith('Missing credential') ? 'MISSING_CREDENTIALS' : e.config.enabled ? 'PROVIDER_UNAVAILABLE' : 'PROVIDER_DISABLED';
      throw new AIError(code, e.unavailableReason ?? 'unavailable', { provider: name, retryable: false });
    }
    return e.instance as T;
  }

  markHealth(name: string, status: ProviderConfig['health']['status'], reason?: string) {
    const e = this.entries.get(name);
    if (!e) return;
    e.config = { ...e.config, health: reason === undefined ? { status, checkedAt: new Date().toISOString() } : { status, reason, checkedAt: new Date().toISOString() } };
  }
}
