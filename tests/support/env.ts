import { execSync } from 'node:child_process';

/** True when a Docker daemon is reachable (needed for Testcontainers). */
export function isDockerAvailable(): boolean {
  if (process.env.QA_SKIP_DOCKER === '1') return false;
  try {
    execSync('docker info', { stdio: 'ignore', timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}
