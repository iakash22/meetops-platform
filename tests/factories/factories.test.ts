import { describe, expect, it } from 'vitest';
import { createFactories } from './index.js';

describe('test-data factories', () => {
  it('is deterministic for the same seed', () => {
    const a = createFactories({ seed: 7 });
    const b = createFactories({ seed: 7 });
    expect(a.organization).toEqual(b.organization);
    expect(a.meeting()).toEqual(b.meeting());
    expect(a.fileObject()).toEqual(b.fileObject());
  });

  it('differs across seeds', () => {
    expect(createFactories({ seed: 1 }).organization.id).not.toBe(
      createFactories({ seed: 2 }).organization.id,
    );
  });

  it('generates UUID-shaped ids', () => {
    expect(createFactories().organization.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('scopes every record to its organization', () => {
    const acme = createFactories({ seed: 1, organizationSlug: 'acme' });
    const globex = createFactories({ seed: 1, organizationSlug: 'globex' });
    const orgId = acme.organization.id;
    for (const r of [acme.membership(), acme.project(), acme.meeting(), acme.fileObject()])
      expect(r.organizationId).toBe(orgId);
    expect(acme.fileObject().key.startsWith(`org/${orgId}/`)).toBe(true);
    expect(acme.storageObject().custom?.organizationId).toBe(orgId);
    expect(globex.user().email.endsWith('@globex.test')).toBe(true);
  });

  it('honours overrides', () => {
    const f = createFactories();
    expect(f.meeting({ title: 'x' }).title).toBe('x');
    expect(f.membership({ role: 'owner' }).role).toBe('owner');
  });
});
