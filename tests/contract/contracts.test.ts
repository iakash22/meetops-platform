import { describe, expect, it } from 'vitest';
import type { TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import * as contracts from '@meetops/contracts';
import { createFactories } from '../factories/index.js';

/*
 * Validates factory output against the runtime TypeBox schemas exported by
 * @meetops/contracts (PR #17, merged into integration/phase-1). The suite skips if the
 * installed contracts package has no runtime schemas. QA_CONTRACTS_DIR points it at
 * another checkout of packages/contracts.
 */
const schemas = contracts as unknown as Record<string, TSchema | undefined>;
const hasRuntimeSchemas = ['Organization', 'Membership', 'Meeting', 'FileObject'].every(
  (k) => typeof schemas[k] === 'object',
);
if (!hasRuntimeSchemas)
  console.warn(
    '[contract] @meetops/contracts has no runtime schemas (PR #17 not merged): skipping',
  );

const schema = (name: string): TSchema => {
  const s = schemas[name];
  if (!s) throw new Error(`missing schema ${name}`);
  return s;
};

describe.skipIf(!hasRuntimeSchemas)(
  'contracts: factory output matches @meetops/contracts schemas',
  () => {
    const f = createFactories({ seed: 123, organizationSlug: 'contract' });

    it('Organization', () => {
      expect(Value.Check(schema('Organization'), f.organization)).toBe(true);
    });

    it('Membership', () => {
      expect(Value.Check(schema('Membership'), f.membership({ role: 'admin' }))).toBe(true);
    });

    it('Project', () => {
      expect(Value.Check(schema('Project'), f.project())).toBe(true);
    });

    it('Meeting', () => {
      expect(Value.Check(schema('Meeting'), f.meeting())).toBe(true);
    });

    it('FileObject', () => {
      expect(Value.Check(schema('FileObject'), f.fileObject())).toBe(true);
    });

    it('rejects an invalid organization slug', () => {
      expect(Value.Check(schema('Organization'), { ...f.organization, slug: 'Not Valid!' })).toBe(
        false,
      );
    });

    it('rejects an unknown membership role', () => {
      expect(Value.Check(schema('Membership'), { ...f.membership(), role: 'superuser' })).toBe(
        false,
      );
    });

    it('rejects a negative file size', () => {
      expect(Value.Check(schema('FileObject'), { ...f.fileObject(), sizeBytes: -1 })).toBe(false);
    });

    it('every factory id is a UUID', () => {
      const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
      const m = f.membership();
      for (const id of [
        f.organization.id,
        f.user().id,
        m.id,
        m.userId,
        f.project().id,
        f.meeting().createdById,
        f.fileObject().id,
      ])
        expect(id).toMatch(uuid);
    });

    it('rejects a meeting without organizationId', () => {
      const rest: Record<string, unknown> = { ...f.meeting() };
      delete rest.organizationId;
      expect(Value.Check(schema('Meeting'), rest)).toBe(false);
    });
  },
);
