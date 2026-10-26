/**
 * Writes every email to $EMAIL_PREVIEW_DIR/<name>.html (+ .txt) for visual review. Skipped unless the env var is set:
 *   EMAIL_PREVIEW_DIR=/tmp/email-previews pnpm --filter @meetops/notifications test -- previews
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { emailNames, renderEmail } from '../src/index.js';
import { sampleVariables } from './fixtures.js';

const out = process.env.EMAIL_PREVIEW_DIR;

describe.skipIf(!out)('email previews', () => {
  it('writes one file per template', () => {
    const dir = out as string;
    mkdirSync(dir, { recursive: true });
    for (const name of emailNames) {
      const r = renderEmail(name, sampleVariables[name] as never);
      writeFileSync(join(dir, `${name}.html`), r.html);
      writeFileSync(join(dir, `${name}.txt`), `Subject: ${r.subject}\n\n${r.text}`);
    }
    expect(emailNames.length).toBe(12);
  });
});
