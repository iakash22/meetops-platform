import { describe, expect, it } from 'vitest';
import { dockerGate } from '../support/env.js';

const up = () => true;
const down = () => false;

describe('Docker gate for integration suites', () => {
  it('returns true when the daemon is reachable, in any mode', () => {
    expect(dockerGate({}, up)).toBe(true);
    expect(dockerGate({ CI: 'true' }, up)).toBe(true);
  });

  it('skips gracefully locally when the daemon is missing', () => {
    expect(dockerGate({}, down)).toBe(false);
    expect(dockerGate({ CI: 'false' }, down)).toBe(false);
  });

  it('fails in CI when the daemon is missing (no silent skip)', () => {
    expect(() => dockerGate({ CI: 'true' }, down)).toThrow(/Docker is required/);
    expect(() => dockerGate({ CI: '1' }, down)).toThrow(/Docker is required/);
    expect(() => dockerGate({ QA_REQUIRE_DOCKER: '1' }, down)).toThrow(/Docker is required/);
  });

  it('QA_SKIP_DOCKER=1 in CI is always an error, even with QA_ALLOW_DOCKER_SKIP', () => {
    expect(() => dockerGate({ CI: 'true', QA_SKIP_DOCKER: '1' }, up)).toThrow(/Docker is required/);
    expect(() =>
      dockerGate({ CI: 'true', QA_SKIP_DOCKER: '1', QA_ALLOW_DOCKER_SKIP: '1' }, up),
    ).toThrow(/Docker is required/);
  });

  it('QA_ALLOW_DOCKER_SKIP=1 is ignored in CI (Docker missing = hard fail)', () => {
    expect(() => dockerGate({ CI: 'true', QA_ALLOW_DOCKER_SKIP: '1' }, down)).toThrow(
      /Docker is required/,
    );
    expect(() => dockerGate({ CI: '1', QA_ALLOW_DOCKER_SKIP: '1' }, down)).toThrow(
      /Docker is required/,
    );
  });

  it('QA_ALLOW_DOCKER_SKIP=1 restores the skip locally under QA_REQUIRE_DOCKER=1', () => {
    expect(dockerGate({ QA_REQUIRE_DOCKER: '1', QA_ALLOW_DOCKER_SKIP: '1' }, down)).toBe(false);
  });
});
