import type { Integration } from '@meetops/contracts';
import {
  createIntegrationConnectionRepository,
  type IntegrationConnectionRecord,
  type IntegrationConnectionRepository,
  type IntegrationSecretCipher,
} from '@meetops/database';
import type { DatabaseClient } from '../../shared/prisma/context.js';
import type { IntegrationsRepository } from './ports.js';

/**
 * list/disconnect never touch secrets, so until the @meetops/integrations TokenCipher is wired (held lockfile
 * step) the repository gets a cipher that refuses every call: nothing can be encrypted or decrypted by accident.
 */
const refusingCipher: IntegrationSecretCipher = {
  encrypt: () => Promise.reject(new Error('integration token cipher is not configured')),
  decrypt: () => Promise.reject(new Error('integration token cipher is not configured')),
};

export function toIntegration(r: IntegrationConnectionRecord): Integration | null {
  // The contract requires a connector; rows whose connecting user was deleted are not listed.
  if (!r.connectedById || (r.provider !== 'jira' && r.provider !== 'github')) return null;
  return {
    id: r.id,
    organizationId: r.organizationId,
    provider: r.provider,
    status: r.status,
    displayName: r.displayName,
    externalAccountId: r.externalAccountId,
    connectedById: r.connectedById,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

export class PrismaIntegrations implements IntegrationsRepository {
  private readonly repo: IntegrationConnectionRepository;
  constructor(client: DatabaseClient, cipher: IntegrationSecretCipher = refusingCipher) {
    this.repo = createIntegrationConnectionRepository({ client, cipher });
  }
  async list(organizationId: string): Promise<Integration[]> {
    return (await this.repo.list(organizationId))
      .map(toIntegration)
      .filter((x): x is Integration => x !== null);
  }
  async disconnect(organizationId: string, id: string): Promise<Integration | null> {
    const r = await this.repo.disconnect(organizationId, id);
    return r ? toIntegration(r) : null;
  }
}
