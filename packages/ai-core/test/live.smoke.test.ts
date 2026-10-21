import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { GeminiProvider, AssemblyAIProvider } from '../src/index.js';

const GEMINI = process.env.GEMINI_API_KEY;
const AAI = process.env.ASSEMBLYAI_API_KEY;

describe.skipIf(!GEMINI)('LIVE Gemini smoke', () => {
  it('structured output', async () => {
    const g = new GeminiProvider({ apiKey: GEMINI });
    const r = await g.generateStructured({ model: process.env.GEMINI_MODEL ?? 'gemini-2.5-flash-lite', prompt: 'Return {"ok": true}', schema: z.object({ ok: z.boolean() }).strict(), schemaName: 'ok' });
    expect(r.value.ok).toBe(true);
  }, 60_000);
});

describe.skipIf(!AAI)('LIVE AssemblyAI smoke', () => {
  it('transcribes sample', async () => {
    const r = await new AssemblyAIProvider({ apiKey: AAI }).transcribe({ url: 'https://assembly.ai/wildfires.mp3', language: 'en' });
    expect(r.text.length).toBeGreaterThan(0);
  }, 300_000);
});
