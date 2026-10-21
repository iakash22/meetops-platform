import { describe, expect, it } from 'vitest';
import { createFactories } from './index.js';

describe('test-data factories', () => {
  it('is deterministic for the same seed', () => {
    const a = createFactories({ seed: 7 });
    const b = createFactories({ seed: 7 });
    expect(a.emailMessage()).toEqual(b.emailMessage());
    expect(a.storageObject()).toEqual(b.storageObject());
  });

  it('differs across seeds', () => {
    expect(createFactories({ seed: 1 }).storageObject()).not.toEqual(createFactories({ seed: 2 }).storageObject());
  });

  it('scopes records to the tenant', () => {
    const acme = createFactories({ seed: 1, tenantSlug: 'acme' });
    const globex = createFactories({ seed: 1, tenantSlug: 'globex' });
    const obj = acme.storageObject();
    expect(obj.key.startsWith(`${acme.tenant.id}/`)).toBe(true);
    expect(obj.custom?.tenantId).toBe(acme.tenant.id);
    expect(globex.emailAddress().email.endsWith('@globex.test')).toBe(true);
  });

  it('honours overrides', () => {
    const f = createFactories();
    expect(f.emailMessage({ subject: 'x' }).subject).toBe('x');
  });
});
