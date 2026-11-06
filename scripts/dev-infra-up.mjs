#!/usr/bin/env node
/* global console, process, URL */
/**
 * Start local dev infra.
 * Docker Postgres starts only when DATABASE_URL is local.
 * Docker Redis starts only when REDIS_URL is local.
 * MinIO starts only when storage is still local (STORAGE_PROVIDER=minio).
 * Remote Neon database, Layerbase Redis, and Neon Object Storage skip their containers.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const envFile = fileURLToPath(new URL('../.env', import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);

function remoteHost(url) {
  if (!url) return false;
  try {
    const host = new URL(url).hostname;
    return host !== 'localhost' && host !== '127.0.0.1' && host !== '::1';
  } catch {
    return false;
  }
}

const dbRemote = remoteHost(process.env.DATABASE_URL);
const redisRemote = remoteHost(process.env.REDIS_URL);
const storageProvider = (process.env.STORAGE_PROVIDER || 'minio').trim().toLowerCase();
const storageRemote = storageProvider === 'neon' || remoteHost(process.env.STORAGE_ENDPOINT);
const services = [];
if (dbRemote || redisRemote || storageRemote) {
  if (!dbRemote) services.push('postgres');
  if (!redisRemote) services.push('redis');
  if (!storageRemote) services.push('minio', 'minio-init');
  if (dbRemote) console.log('[dev:infra] DATABASE_URL is remote; skipping local Postgres');
  if (redisRemote) console.log('[dev:infra] REDIS_URL is remote; skipping local Redis');
  if (storageRemote) console.log('[dev:infra] storage is remote; skipping local MinIO');
  if (services.length === 0) {
    console.log('[dev:infra] database, Redis, and storage are remote; nothing to start');
    process.exit(0);
  }
}

const docker = process.platform === 'win32' ? 'docker.exe' : 'docker';
const compose = spawnSync(
  docker,
  ['compose', '--env-file', '.env', '-f', 'infra/compose/compose.dev.yml', 'up', '-d', ...services],
  { cwd: root, stdio: 'inherit' },
);
process.exit(compose.status ?? 1);
