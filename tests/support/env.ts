import { execSync } from 'node:child_process';

type Env = Record<string, string | undefined>;

const truthy = (v: string | undefined) => v === '1' || v === 'true';

function probeDocker(): boolean {
  try {
    execSync('docker info', { stdio: 'ignore', timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Docker gate for the integration suites (Testcontainers).
 *
 * - Locally a missing daemon means the suites are skipped (with a warning).
 * - In CI (`CI=true`), or with `QA_REQUIRE_DOCKER=1`, a missing daemon is an error, so
 *   the suites can never pass by silently skipping.
 * - `QA_ALLOW_DOCKER_SKIP=1` opts out of that and restores the skip, even in CI.
 * - `QA_SKIP_DOCKER=1` forces "unavailable" (still an error in strict mode unless allowed).
 */
export function dockerGate(env: Env = process.env, probe: () => boolean = probeDocker): boolean {
  const available = env.QA_SKIP_DOCKER === '1' ? false : probe();
  if (available) return true;
  const strict =
    (truthy(env.CI) || truthy(env.QA_REQUIRE_DOCKER)) && !truthy(env.QA_ALLOW_DOCKER_SKIP);
  if (strict)
    throw new Error(
      'Docker is required for the integration suites in CI (CI=true or QA_REQUIRE_DOCKER=1) but ' +
        '`docker info` failed. Fix the runner, or set QA_ALLOW_DOCKER_SKIP=1 to skip on purpose.',
    );
  return false;
}

/** True when a Docker daemon is reachable; throws in strict (CI) mode when it is not. */
export function isDockerAvailable(): boolean {
  return dockerGate();
}
