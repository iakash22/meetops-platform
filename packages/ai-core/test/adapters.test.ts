/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-base-to-string -- test doubles inspect untyped request payloads */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  GeminiProvider, AssemblyAIProvider, OllamaProvider, OpenAICompatibleProvider, FasterWhisperProvider, DeepgramProvider,
  hasStreaming, hasEmbeddings, type GeminiModelsClient, type AssemblyAITranscriptsClient,
} from '../src/index.js';

const schema = z.object({ title: z.string() }).strict();

describe('Gemini adapter (mocked client)', () => {
  it('sends zod->JSON schema via responseJsonSchema and validates output', async () => {
    let req: any;
    const client = {
      generateContent: async (r: unknown) => { req = r; return { text: '{"title":"x"}', usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2, totalTokenCount: 5 } }; },
    } as unknown as GeminiModelsClient;
    const g = new GeminiProvider({ client });
    const r = await g.generateStructured({ model: 'gemini-2.5-flash-lite', prompt: 'p', schema, schemaName: 's', system: 'sys' });
    expect(r.value).toEqual({ title: 'x' });
    expect(r.usage).toEqual({ inputTokens: 3, outputTokens: 2, totalTokens: 5 });
    expect(req.config.responseMimeType).toBe('application/json');
    expect(req.config.responseJsonSchema.type).toBe('object');
    expect(req.config.systemInstruction).toBe('sys');
  });
  it('rejects invalid output', async () => {
    const client = { generateContent: async () => ({ text: '{"title":"x","extra":1}' }) } as unknown as GeminiModelsClient;
    await expect(new GeminiProvider({ client }).generateStructured({ model: 'm', prompt: 'p', schema, schemaName: 's' })).rejects.toMatchObject({ code: 'INVALID_OUTPUT' });
  });
  it('maps 429 quota to QUOTA_EXCEEDED', async () => {
    const client = { generateContent: async () => { throw Object.assign(new Error('RESOURCE_EXHAUSTED quota'), { status: 429 }); } } as unknown as GeminiModelsClient;
    await expect(new GeminiProvider({ client }).generateText({ model: 'm', prompt: 'p' })).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' });
  });
  it('throws clear error without key', () => expect(() => new GeminiProvider({})).toThrow(/GEMINI_API_KEY/));
});

describe('AssemblyAI adapter (mocked client)', () => {
  it('maps utterances to segments', async () => {
    let params: any;
    const client = {
      transcribe: async (p: unknown) => { params = p; return { id: 'tr1', status: 'completed', text: 'hello', audio_duration: 12, language_code: 'en', utterances: [{ start: 0, end: 1500, text: 'hello', speaker: 'A', confidence: 0.9, words: [] }] }; },
    } as unknown as AssemblyAITranscriptsClient;
    const r = await new AssemblyAIProvider({ client }).transcribe({ url: 'https://cdn/x.mp3', language: 'en' });
    expect(params).toMatchObject({ audio: 'https://cdn/x.mp3', speaker_labels: true, language_code: 'en' });
    expect(r).toMatchObject({ text: 'hello', durationSec: 12, providerJobId: 'tr1', segments: [{ startSec: 0, endSec: 1.5, speaker: 'A' }] });
  });
  it('error status -> MODEL_ERROR', async () => {
    const client = { transcribe: async () => ({ id: 'x', status: 'error', error: 'bad audio' }) } as unknown as AssemblyAITranscriptsClient;
    await expect(new AssemblyAIProvider({ client }).transcribe({ url: 'https://x' })).rejects.toMatchObject({ code: 'MODEL_ERROR' });
  });
});

const local = { allowedHosts: ['api.openai.com'], allowedLocalOrigins: ['http://localhost:11434', 'http://localhost:8000'] };
const pub = async () => [{ address: '104.18.0.1', family: 4 }];

describe('HTTP adapters (mocked fetch)', () => {
  it('Ollama /api/chat with format schema', async () => {
    let body: any; let url = '';
    const fetch = async (u: string, i?: RequestInit) => { url = u; body = JSON.parse(String(i?.body)); return Response.json({ message: { content: '{"title":"t"}' }, prompt_eval_count: 4, eval_count: 2 }); };
    const r = await new OllamaProvider({ baseUrl: 'http://localhost:11434', policy: local, fetch }).generateStructured({ model: 'llama3.2', prompt: 'p', schema, schemaName: 's' });
    expect(url).toBe('http://localhost:11434/api/chat');
    expect(body.stream).toBe(false);
    expect(body.format.type).toBe('object');
    expect(r.usage.totalTokens).toBe(6);
  });
  it('OpenAI-compatible chat/completions json_schema', async () => {
    let body: any; let headers: any;
    const fetch = async (_u: string, i?: RequestInit) => { body = JSON.parse(String(i?.body)); headers = i?.headers; return Response.json({ choices: [{ message: { content: '{"title":"t"}' } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }); };
    const r = await new OpenAICompatibleProvider({ baseUrl: 'https://api.openai.com/v1', policy: local, fetch, lookup: pub, apiKey: 'k' }).generateStructured({ model: 'gpt-4o-mini', prompt: 'p', schema, schemaName: 's' });
    expect(body.response_format.type).toBe('json_schema');
    expect(headers.authorization).toBe('Bearer k');
    expect(r.value.title).toBe('t');
  });
  it('faster-whisper /v1/audio/transcriptions verbose_json', async () => {
    let url = ''; let form: FormData | undefined;
    const fetch = async (u: string, i?: RequestInit) => { url = u; form = i?.body as FormData; return Response.json({ text: 'hi', language: 'en', duration: 3, segments: [{ start: 0, end: 1, text: ' hi' }] }); };
    const r = await new FasterWhisperProvider({ baseUrl: 'http://localhost:8000', policy: local, fetch, model: 'small' }).transcribe({ bytes: new Uint8Array([1, 2]) });
    expect(url).toBe('http://localhost:8000/v1/audio/transcriptions');
    expect(form?.get('response_format')).toBe('verbose_json');
    expect(r.segments[0]).toEqual({ startSec: 0, endSec: 1, text: 'hi' });
  });
  it('local adapter blocked when origin not enabled', async () => {
    const p = new OllamaProvider({ baseUrl: 'http://localhost:11434', policy: { allowedHosts: [], allowedLocalOrigins: [] }, fetch: async () => Response.json({}) });
    await expect(p.generateText({ model: 'm', prompt: 'p' })).rejects.toMatchObject({ code: 'SSRF_BLOCKED' });
  });
});

describe('capability detection', () => {
  it('no adapter is assumed to stream/embed; deepgram stub disabled', async () => {
    expect(hasStreaming(new FasterWhisperProvider({ baseUrl: 'http://x', policy: local, model: 'm' }))).toBe(false);
    expect(hasEmbeddings(new GeminiProvider({ client: {} as GeminiModelsClient }))).toBe(false);
    expect((await new AssemblyAIProvider({ client: {} as AssemblyAITranscriptsClient }).getCapabilities()).streaming).toBe(false);
    await expect(new DeepgramProvider().transcribe()).rejects.toMatchObject({ code: 'PROVIDER_DISABLED' });
  });
});
