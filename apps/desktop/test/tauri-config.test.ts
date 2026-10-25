import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Guards the Tauri config without needing the Rust toolchain in CI.
// vitest runs with the package root as cwd (jsdom rewrites import.meta.url, so resolve from cwd).
const tauriDir = resolve(process.cwd(), 'src-tauri');
const readJson = (rel: string) =>
  JSON.parse(readFileSync(resolve(tauriDir, rel), 'utf8')) as unknown;

interface TauriConf {
  identifier: string;
  build: { frontendDist: string; devUrl: string };
  app: { security: { csp: string; devCsp: string } };
}
interface Capability {
  windows: string[];
  permissions: string[];
}

const conf = readJson('tauri.conf.json') as TauriConf;

describe('tauri.conf.json', () => {
  it('keeps the bundle identifier as a marked owner placeholder', () => {
    // TODO-owner: replace with the real reverse-DNS identifier before any signed release.
    expect(conf.identifier).toMatch(/todo-owner/);
    expect(conf.identifier).toMatch(/^[a-z0-9-]+(\.[a-z0-9-]+)+$/);
  });

  it('serves the Vite build and dev server', () => {
    expect(conf.build.frontendDist).toBe('../dist');
    expect(conf.build.devUrl).toBe('http://localhost:1420');
  });

  it('ships a strict CSP', () => {
    for (const csp of [conf.app.security.csp, conf.app.security.devCsp]) {
      expect(csp).toContain("default-src 'self'");
      expect(csp).toContain("object-src 'none'");
      expect(csp).not.toContain('unsafe-eval');
      expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
    }
    expect(conf.app.security.csp).not.toContain('unsafe-inline');
  });
});

describe('capabilities/default.json', () => {
  it('grants core defaults only', () => {
    const cap = readJson('capabilities/default.json') as Capability;
    expect(cap.windows).toEqual(['main']);
    expect(cap.permissions).toEqual(['core:default']);
  });
});
