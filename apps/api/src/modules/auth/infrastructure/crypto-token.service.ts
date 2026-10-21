import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { TokenService } from '../domain/ports.js';
import type { IdGenerator } from '../../../shared/ports.js';

export class CryptoTokenService implements TokenService {
  generate() {
    return randomBytes(32).toString('base64url');
  }
  hash(token: string) {
    return createHash('sha256').update(token).digest('hex');
  }
}

export const uuidGenerator: IdGenerator = { next: () => randomUUID() };
