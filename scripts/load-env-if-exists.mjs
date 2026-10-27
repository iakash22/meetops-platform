// Preload for `node --import` / `tsx --import`: loads the repo-root .env when it
// exists and is a no-op otherwise, so CI and fresh checkouts work without one.
// Equivalent to Node >=22.9 `--env-file-if-exists`, but works on Node 20.12+
// (engines allow >=20.19). Variables already set in the environment win.
import { existsSync } from 'node:fs';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';

const envPath = fileURLToPath(new URL('../.env', import.meta.url));
if (existsSync(envPath)) process.loadEnvFile(envPath);
