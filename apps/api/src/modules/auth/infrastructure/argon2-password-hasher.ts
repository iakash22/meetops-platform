import argon2 from 'argon2';
import type { PasswordHasher } from '../domain/ports.js';

export class Argon2PasswordHasher implements PasswordHasher {
  hash(plain: string) {
    return argon2.hash(plain, { type: argon2.argon2id });
  }
  async verify(hash: string, plain: string) {
    try {
      return await argon2.verify(hash, plain);
    } catch {
      return false;
    }
  }
}
