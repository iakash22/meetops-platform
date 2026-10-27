import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  clampMeetingsLimit,
  decodeMeetingsCursor,
  encodeMeetingsCursor,
} from '../src/meetings-page.js';

const sql = readFileSync(
  fileURLToPath(
    new URL(
      '../prisma/migrations/20261027130000_recording_session_bytes_received/migration.sql',
      import.meta.url,
    ),
  ),
  'utf8',
);

// Read the contract cap from source (database does not depend on @meetops/contracts).
const constants = readFileSync(
  fileURLToPath(new URL('../../contracts/src/constants.ts', import.meta.url)),
  'utf8',
);
const MAX_MEDIA_BYTES = Number(
  /export const MAX_MEDIA_BYTES = ([\d_]+);/.exec(constants)?.[1]?.replace(/_/g, ''),
);
const MAX_RECORDING_SESSION_BYTES =
  /export const MAX_RECORDING_SESSION_BYTES = MAX_MEDIA_BYTES;/.test(constants)
    ? MAX_MEDIA_BYTES
    : Number.NaN;

describe('meetings cursor helpers', () => {
  it('round-trips an opaque cursor', () => {
    const c = {
      createdAt: new Date('2026-10-22T08:00:00.123Z'),
      id: '6f0d3a4e-1c2b-5d7e-9f80-a1b2c3d4e5f6',
    };
    const s = encodeMeetingsCursor(c);
    expect(s).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeMeetingsCursor(s)).toEqual(c);
  });
  it('rejects garbage cursors', () => {
    for (const bad of [
      '',
      'x',
      Buffer.from('{"c":"nope","i":"1"}').toString('base64url'),
      Buffer.from('[]').toString('base64url'),
    ]) {
      expect(() => decodeMeetingsCursor(bad)).toThrow('invalid_cursor');
    }
  });
  it('clamps the limit', () => {
    expect(clampMeetingsLimit(undefined)).toBe(20);
    expect(clampMeetingsLimit(0)).toBe(1);
    expect(clampMeetingsLimit(-5)).toBe(1);
    expect(clampMeetingsLimit(1000)).toBe(100);
    expect(() => clampMeetingsLimit(Number.NaN)).toThrow('invalid_limit');
    expect(() => clampMeetingsLimit(1.5)).toThrow('invalid_limit');
  });
});

describe('P1-DB-4 migration (static)', () => {
  it('uses the contract MAX_RECORDING_SESSION_BYTES literal', () => {
    expect(MAX_RECORDING_SESSION_BYTES).toBe(1_400_000_000);
    expect(sql).toContain(`CHECK ("bytes_received" BETWEEN 0 AND ${MAX_RECORDING_SESSION_BYTES})`);
    expect(sql).toContain(`bytes_received + p_delta <= ${MAX_RECORDING_SESSION_BYTES}`);
  });
  it('function is invoker, pinned, app-only, single atomic UPDATE scoped to org + uploading', () => {
    expect(sql).toContain('SECURITY INVOKER');
    expect(sql).not.toContain('SECURITY DEFINER');
    expect(sql).toContain('SET search_path = public, pg_temp');
    expect(sql).toContain(
      'REVOKE ALL ON FUNCTION public.add_recording_session_bytes(uuid, bigint) FROM PUBLIC;',
    );
    expect(sql).toContain(
      'GRANT EXECUTE ON FUNCTION public.add_recording_session_bytes(uuid, bigint) TO meetops_app;',
    );
    expect(sql).toMatch(/SET bytes_received = bytes_received \+ p_delta/);
    expect(sql).toMatch(/AND status = 'uploading'/);
    for (const e of [
      'recording_session_bytes_invalid_delta',
      'recording_session_not_found',
      'recording_session_not_uploading',
      'recording_session_bytes_exceeded',
    ])
      expect(sql).toContain(`'${e}'`);
  });
  it('adds no duplicate meetings index (reuses meetings_org_id_created_at_id_idx)', () => {
    expect(sql).not.toMatch(/CREATE INDEX/);
  });
});
