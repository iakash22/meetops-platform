#!/usr/bin/env node
/* global process, console, setTimeout */
/**
 * Ensures the Docker engine is reachable before compose commands.
 * On Windows/macOS, starts Docker Desktop and waits until `docker info` succeeds.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

const TIMEOUT_MS = Number(process.env.DOCKER_WAIT_MS || 180_000);
const POLL_MS = 2_000;

function dockerBin() {
  return process.platform === 'win32' ? 'docker.exe' : 'docker';
}

function dockerReady() {
  const result = spawnSync(dockerBin(), ['info'], {
    encoding: 'utf8',
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  return result.status === 0;
}

function windowsDockerDesktopPaths() {
  const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
  const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const localAppData = process.env.LOCALAPPDATA || '';
  return [
    path.join(programFiles, 'Docker', 'Docker', 'Docker Desktop.exe'),
    path.join(programFilesX86, 'Docker', 'Docker', 'Docker Desktop.exe'),
    path.join(localAppData, 'Docker', 'Docker Desktop.exe'),
  ];
}

function startDockerDesktopWindows() {
  const exe = windowsDockerDesktopPaths().find((candidate) => existsSync(candidate));
  if (!exe) {
    console.error(
      'Docker Desktop was not found. Install it from https://www.docker.com/products/docker-desktop/',
    );
    process.exit(1);
  }
  console.log(`Starting Docker Desktop: ${exe}`);
  const child = spawn(exe, [], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
}

function startDockerDesktopMac() {
  console.log('Starting Docker Desktop via `open -a Docker`…');
  const result = spawnSync('open', ['-a', 'Docker'], { stdio: 'inherit' });
  if (result.status !== 0) {
    console.error('Could not open Docker Desktop. Start it from Applications and retry.');
    process.exit(1);
  }
}

async function waitForDocker() {
  const deadline = Date.now() + TIMEOUT_MS;
  process.stdout.write('Waiting for Docker engine');
  while (Date.now() < deadline) {
    if (dockerReady()) {
      process.stdout.write('\n');
      return true;
    }
    process.stdout.write('.');
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  process.stdout.write('\n');
  return false;
}

async function main() {
  if (dockerReady()) {
    console.log('Docker is ready.');
    return;
  }

  if (process.platform === 'win32') {
    startDockerDesktopWindows();
  } else if (process.platform === 'darwin') {
    startDockerDesktopMac();
  } else {
    console.error(
      'Docker daemon is not running. Start Docker (or your container engine) and retry.',
    );
    process.exit(1);
  }

  const ready = await waitForDocker();
  if (!ready) {
    console.error(
      `Timed out after ${Math.round(TIMEOUT_MS / 1000)}s waiting for Docker. ` +
        'Open Docker Desktop, wait until it says it is running, then retry.',
    );
    process.exit(1);
  }

  console.log('Docker is ready.');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
