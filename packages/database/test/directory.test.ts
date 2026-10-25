/**
 * Directory repositories without a database: a fake transaction client records what reaches
 * Prisma, proving writes pick fields explicitly so client input can never override tenant or
 * system columns (organizationId, id, deletedAt, ...). The live RLS behaviour is in
 * directory.live.test.ts.
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import {
  createEmployeeRepository,
  createProjectRepository,
  createTeamRepository,
} from '../src/index.js';

type Call = { model: string; op: string; args: { data?: Record<string, unknown> } };

/** Every count is 1 (rows exist, user is a member) except uniqueness checks, which are 0. */
function fakeClient() {
  const calls: Call[] = [];
  const model = (name: string) => ({
    count: (args: { where?: Record<string, unknown> }) => {
      const w = args.where ?? {};
      const existence = 'id' in w || name === 'membership';
      return Promise.resolve(existence ? 1 : 0);
    },
    create: (args: Call['args']) => {
      calls.push({ model: name, op: 'create', args });
      return Promise.resolve({ id: randomUUID(), ...args.data });
    },
    update: (args: Call['args']) => {
      calls.push({ model: name, op: 'update', args });
      return Promise.resolve({ id: randomUUID(), ...args.data });
    },
  });
  const tx = {
    $executeRaw: () => Promise.resolve(0),
    employee: model('employee'),
    team: model('team'),
    project: model('project'),
    membership: model('membership'),
  };
  const client = {
    $transaction: (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
  } as unknown as PrismaClient;
  const dataOf = (m: string, op: string) =>
    calls.find((c) => c.model === m && c.op === op)?.args.data;
  return { client, dataOf };
}

const orgA = randomUUID();
const orgB = randomUUID();
const hostile = {
  organizationId: orgB,
  id: randomUUID(),
  deletedAt: null,
  createdAt: new Date(0),
  isAdmin: true,
};

describe('directory writes pick fields explicitly', () => {
  it('employee create/update ignore organizationId and unknown fields', async () => {
    const { client, dataOf } = fakeClient();
    const repo = createEmployeeRepository({ client });
    await repo.create(orgA, { fullName: 'Ada', email: 'ada@a.test', ...hostile });
    expect(dataOf('employee', 'create')).toEqual({
      fullName: 'Ada',
      email: 'ada@a.test',
      organizationId: orgA,
    });
    await repo.update(orgA, randomUUID(), { title: null, ...hostile });
    expect(dataOf('employee', 'update')).toEqual({ title: null });
  });

  it('team create/update ignore organizationId and unknown fields', async () => {
    const { client, dataOf } = fakeClient();
    const repo = createTeamRepository({ client });
    await repo.create(orgA, { name: 'Core', ...hostile });
    expect(dataOf('team', 'create')).toEqual({ name: 'Core', organizationId: orgA });
    await repo.update(orgA, randomUUID(), { description: 'x', ...hostile });
    expect(dataOf('team', 'update')).toEqual({ description: 'x' });
  });

  it('project create ignores organizationId and unknown fields', async () => {
    const { client, dataOf } = fakeClient();
    const repo = createProjectRepository({ client });
    await repo.create(orgA, { name: 'Gemini', key: 'GEM', ...hostile });
    expect(dataOf('project', 'create')).toEqual({
      name: 'Gemini',
      key: 'GEM',
      organizationId: orgA,
    });
  });
});
