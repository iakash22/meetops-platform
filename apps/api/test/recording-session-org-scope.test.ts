import { describe, expect, it } from 'vitest';
import { InMemoryRecordingSessionRepository } from '../src/modules/media/infrastructure/in-memory.js';
import type { RecordingSessionRecord } from '../src/modules/media/domain/recording-session.js';

describe('recording session lookup is org-scoped (security review B 4.4)', () => {
  it('findById returns null for another org', async () => {
    const repo = new InMemoryRecordingSessionRepository();
    const row = {
      id: '00000000-0000-4000-8000-0000000000a1',
      organizationId: '00000000-0000-4000-8000-0000000000b1',
      chunks: new Map(),
    } as unknown as RecordingSessionRecord;
    await repo.create(row);
    expect(await repo.findById(row.organizationId, row.id)).toMatchObject({ id: row.id });
    expect(await repo.findById('00000000-0000-4000-8000-0000000000b2', row.id)).toBeNull();
  });
});
