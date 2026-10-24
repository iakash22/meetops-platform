import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { GeminiProvider, AssemblyAIProvider, DEFAULT_ALLOWED_HOSTS } from '../src/index.js';

const GEMINI = process.env.GEMINI_API_KEY;
const AAI = process.env.ASSEMBLYAI_API_KEY;
const SAMPLE = process.env.AI_SMOKE_AUDIO_FILE; // local audio file path for the AssemblyAI smoke test
const policy = { allowedHosts: DEFAULT_ALLOWED_HOSTS, allowedLocalOrigins: [] };

describe.skipIf(!GEMINI)('LIVE Gemini smoke', () => {
  it('structured output', async () => {
    const g = new GeminiProvider({ apiKey: GEMINI, policy });
    const r = await g.generateStructured({ model: process.env.GEMINI_MODEL ?? 'gemini-2.5-flash-lite', prompt: 'Return {"ok": true}', schema: z.object({ ok: z.boolean() }).strict(), schemaName: 'ok' });
    expect(r.value.ok).toBe(true);
  }, 60_000);
});

describe.skipIf(!AAI || !SAMPLE)('LIVE AssemblyAI smoke', () => {
  it('transcribes sample bytes', async () => {
    const { readFile } = await import('node:fs/promises');
    const bytes = new Uint8Array(await readFile(SAMPLE!));
    const r = await new AssemblyAIProvider({ apiKey: AAI, policy }).transcribe({ bytes, language: 'en' });
    expect(r.text.length).toBeGreaterThan(0);
  }, 300_000);
});
