import { describe, expect, it } from 'vitest';
import { FormatRegistry, type TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import * as contracts from '@meetops/contracts';
import { createFactories } from '../factories/index.js';

/*
 * Validates factory output against the runtime TypeBox schemas exported by
 * @meetops/contracts (added in PR #17, feat/core-contracts). Until #17 is merged the
 * schemas are absent on main, so this suite skips. To run it against #17 locally set
 * QA_CONTRACTS_DIR to a checkout of packages/contracts from that branch.
 */
// @meetops/contracts registers 'date-time' and 'email' in *its* TypeBox FormatRegistry.
// tests/ installs its own TypeBox copy, so register equivalent checks here when missing.
// TODO(QA): drop once contracts exports a validator (e.g. check(schema, value)).
if (!FormatRegistry.Has('date-time'))
  FormatRegistry.Set(
    'date-time',
    (v) =>
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(v) &&
      !Number.isNaN(Date.parse(v)),
  );
if (!FormatRegistry.Has('email'))
  FormatRegistry.Set('email', (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v));

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

    it('rejects a meeting without organizationId', () => {
      const rest: Record<string, unknown> = { ...f.meeting() };
      delete rest.organizationId;
      expect(Value.Check(schema('Meeting'), rest)).toBe(false);
    });
  },
);
