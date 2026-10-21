import argon2 from 'argon2';
import type { PasswordHasher } from '../domain/ports.js';

/** OWASP minimum per auth-session-spec §1. */
export interface Argon2Params {
  type: typeof argon2.argon2id;
  memoryCost: number;
  timeCost: number;
  parallelism: number;
}
export const ARGON2_PARAMS: Argon2Params = { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 };

export class Argon2PasswordHasher implements PasswordHasher {
  constructor(private readonly params: Argon2Params = ARGON2_PARAMS) {}
  hash(plain: string) {
    return argon2.hash(plain, this.params);
  }
  async verify(hash: string, plain: string) {
    try {
      return await argon2.verify(hash, plain);
    } catch {
      return false;
    }
  }
  needsRehash(hash: string) {
    try {
      return argon2.needsRehash(hash, this.params);
    } catch {
      return true;
    }
  }
}
