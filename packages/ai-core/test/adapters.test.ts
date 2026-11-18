/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument -- test doubles inspect untyped request payloads */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  GeminiProvider,
  AssemblyAIProvider,
  OllamaProvider,
  OpenAICompatibleProvider,
  FasterWhisperProvider,
  DeepgramProvider,
  hasStreaming,
  hasEmbeddings,
} from '../src/index.js';

const schema = z.object({ title: z.string() }).strict();

const pubLookup = async () => [{ address: '142.250.0.1', family: 4 }];
const remote = {
  allowedHosts: ['generativelanguage.googleapis.com', 'api.assemblyai.com'],
  allowedLocalOrigins: [],
};

describe('Gemini REST adapter (mocked fetch)', () => {
  it('POST models/{model}:generateContent with x-goog-api-key + responseJsonSchema', async () => {
    let url = '';
    let init: any;
    const fetch = async (u: string, i: any) => {
      url = u;
      init = i;
      return Response.json({
        candidates: [{ content: { parts: [{ text: '{"title":"x"}' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2, totalTokenCount: 5 },
      });
    };
    const g = new GeminiProvider({ apiKey: 'k1', policy: remote, fetch, lookup: pubLookup });
    const r = await g.generateStructured({
      model: 'gemini-2.5-flash-lite',
      prompt: 'p',
      schema,
      schemaName: 's',
      system: 'sys',
    });
    expect(url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent',
    );
    expect(init.headers['x-goog-api-key']).toBe('k1');
    expect(init.redirect).toBe('manual');
    const body = JSON.parse(init.body);
    expect(body.generationConfig.responseMimeType).toBe('application/json');
    expect(body.generationConfig.responseJsonSchema.type).toBe('object');
    expect(body.systemInstruction.parts[0].text).toBe('sys');
    expect(body.contents[0].parts[0].text).toBe('p');
    expect(r).toMatchObject({
      value: { title: 'x' },
      usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
    });
  });
  it('rejects invalid output and bad model ids', async () => {
    const fetch = async () =>
      Response.json({
        candidates: [{ content: { parts: [{ text: '{"title":"x","extra":1}' }] } }],
      });
    const g = new GeminiProvider({ apiKey: 'k', policy: remote, fetch, lookup: pubLookup });
    await expect(
      g.generateStructured({
        model: 'gemini-2.5-flash-lite',
        prompt: 'p',
        schema,
        schemaName: 's',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_OUTPUT' });
    await expect(g.generateText({ model: '../../evil', prompt: 'p' })).rejects.toMatchObject({
      code: 'CONFIG_INVALID',
    });
  });
  it('maps 429 quota to QUOTA_EXCEEDED', async () => {
    const fetch = async () =>
      new Response('{"error":{"status":"RESOURCE_EXHAUSTED","message":"quota exceeded"}}', {
        status: 429,
      });
    await expect(
      new GeminiProvider({ apiKey: 'k', policy: remote, fetch, lookup: pubLookup }).generateText({
        model: 'm',
        prompt: 'p',
      }),
    ).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' });
  });
  it('throws clear error without key', () =>
    expect(() => new GeminiProvider({ policy: remote })).toThrow(/credential/));
});

describe('AssemblyAI REST adapter (mocked fetch)', () => {
  it('upload bytes -> create transcript -> bounded poll', async () => {
    const calls: Array<[string, any]> = [];
    let polls = 0;
    const fetch = async (u: string, i: any) => {
      calls.push([u, i]);
      if (u.endsWith('/v2/upload'))
        return Response.json({ upload_url: 'https://cdn.assemblyai.com/upload/abc' });
      if (u.endsWith('/v2/transcript')) return Response.json({ id: 'tr1', status: 'queued' });
      polls++;
      return Response.json(
        polls < 2
          ? { id: 'tr1', status: 'processing' }
          : {
              id: 'tr1',
              status: 'completed',
              text: 'hello',
              audio_duration: 12,
              language_code: 'en',
              utterances: [{ start: 0, end: 1500, text: 'hello', speaker: 'A', confidence: 0.9 }],
            },
      );
    };
    const a = new AssemblyAIProvider({
      apiKey: 'aai',
      policy: remote,
      fetch,
      lookup: pubLookup,
      sleep: async () => {},
    });
    const r = await a.transcribe({ bytes: new Uint8Array([1, 2, 3]), language: 'en' });
    expect(calls[0]?.[0]).toBe('https://api.assemblyai.com/v2/upload');
    expect(calls[0]?.[1].headers.authorization).toBe('aai');
    expect(calls[0]?.[1].headers['content-type']).toBe('application/octet-stream');
    const submitted = JSON.parse(calls[1]?.[1].body);
    expect(submitted).toEqual({
      audio_url: 'https://cdn.assemblyai.com/upload/abc',
      speaker_labels: true,
      speech_models: ['assemblyai-stt-3-7'],
      language_code: 'en',
    });
    expect(submitted).not.toHaveProperty('speech_model');
    expect(calls[2]?.[0]).toBe('https://api.assemblyai.com/v2/transcript/tr1');
    expect(r).toMatchObject({
      text: 'hello',
      durationSec: 12,
      providerJobId: 'tr1',
      segments: [{ startSec: 0, endSec: 1.5, speaker: 'A' }],
    });
  });

  it('always sends speech_models and never the legacy speech_model field', async () => {
    const calls: Array<[string, any]> = [];
    const fetch = async (u: string, i: any) => {
      calls.push([u, i]);
      if (u.endsWith('/v2/upload'))
        return Response.json({ upload_url: 'https://cdn.assemblyai.com/upload/abc' });
      if (u.endsWith('/v2/transcript')) return Response.json({ id: 'tr1', status: 'queued' });
      return Response.json({ id: 'tr1', status: 'completed', text: 'ok' });
    };
    await new AssemblyAIProvider({
      apiKey: 'aai',
      policy: remote,
      fetch,
      lookup: pubLookup,
      sleep: async () => {},
    }).transcribe({ bytes: new Uint8Array([1]) });
    const body = JSON.parse(calls[1]?.[1].body);
    expect(body.speech_models).toEqual(['assemblyai-stt-3-7']);
    expect(body).not.toHaveProperty('speech_model');

    const overrideCalls: Array<[string, any]> = [];
    const overrideFetch = async (u: string, i: any) => {
      overrideCalls.push([u, i]);
      if (u.endsWith('/v2/upload'))
        return Response.json({ upload_url: 'https://cdn.assemblyai.com/upload/abc' });
      if (u.endsWith('/v2/transcript')) return Response.json({ id: 'tr2', status: 'queued' });
      return Response.json({ id: 'tr2', status: 'completed', text: 'ok' });
    };
    await new AssemblyAIProvider({
      apiKey: 'aai',
      policy: remote,
      fetch: overrideFetch,
      lookup: pubLookup,
      sleep: async () => {},
      speechModels: ['universal-2'],
    }).transcribe({ bytes: new Uint8Array([1]) });
    expect(JSON.parse(overrideCalls[1]?.[1].body).speech_models).toEqual(['universal-2']);
    expect(JSON.parse(overrideCalls[1]?.[1].body)).not.toHaveProperty('speech_model');
  });
  it('polling is bounded and error status -> MODEL_ERROR', async () => {
    const pending = async (u: string) =>
      u.endsWith('/v2/upload')
        ? Response.json({ upload_url: 'https://cdn.assemblyai.com/upload/x' })
        : Response.json({ id: 'tr2', status: 'processing' });
    await expect(
      new AssemblyAIProvider({
        apiKey: 'k',
        policy: remote,
        fetch: pending,
        lookup: pubLookup,
        sleep: async () => {},
        maxPollAttempts: 3,
      }).transcribe({ bytes: new Uint8Array([1]) }),
    ).rejects.toMatchObject({ code: 'TIMEOUT' });
    const err = async (u: string) =>
      u.endsWith('/v2/upload')
        ? Response.json({ upload_url: 'https://cdn.assemblyai.com/upload/x' })
        : Response.json({ id: 'tr3', status: 'error', error: 'bad audio' });
    await expect(
      new AssemblyAIProvider({
        apiKey: 'k',
        policy: remote,
        fetch: err,
        lookup: pubLookup,
        sleep: async () => {},
      }).transcribe({ bytes: new Uint8Array([1]) }),
    ).rejects.toMatchObject({ code: 'MODEL_ERROR' });
  });
  it('requires bytes (never asks AssemblyAI to fetch our URLs)', async () => {
    await expect(
      new AssemblyAIProvider({ apiKey: 'k', policy: remote }).transcribe({
        url: 'https://internal/x',
      }),
    ).rejects.toMatchObject({ code: 'CAPABILITY_UNSUPPORTED' });
  });
});

const local = {
  allowedHosts: ['api.openai.com'],
  allowedLocalOrigins: ['http://localhost:11434', 'http://localhost:8000'],
};
const pub = async () => [{ address: '104.18.0.1', family: 4 }];

describe('HTTP adapters (mocked fetch)', () => {
  it('Ollama /api/chat with format schema', async () => {
    let body: any;
    let url = '';
    const fetch = async (u: string, i: any) => {
      url = u;
      body = JSON.parse(String(i?.body));
      return Response.json({
        message: { content: '{"title":"t"}' },
        prompt_eval_count: 4,
        eval_count: 2,
      });
    };
    const r = await new OllamaProvider({
      baseUrl: 'http://localhost:11434',
      policy: local,
      fetch,
    }).generateStructured({ model: 'llama3.2', prompt: 'p', schema, schemaName: 's' });
    expect(url).toBe('http://localhost:11434/api/chat');
    expect(body.stream).toBe(false);
    expect(body.format.type).toBe('object');
    expect(r.usage.totalTokens).toBe(6);
  });
  it('OpenAI-compatible chat/completions json_schema', async () => {
    let body: any;
    let headers: any;
    const fetch = async (_u: string, i: any) => {
      body = JSON.parse(String(i?.body));
      headers = i?.headers;
      return Response.json({
        choices: [{ message: { content: '{"title":"t"}' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    };
    const r = await new OpenAICompatibleProvider({
      baseUrl: 'https://api.openai.com/v1',
      policy: local,
      fetch,
      lookup: pub,
      apiKey: 'k',
    }).generateStructured({ model: 'gpt-4o-mini', prompt: 'p', schema, schemaName: 's' });
    expect(body.response_format.type).toBe('json_schema');
    expect(headers.authorization).toBe('Bearer k');
    expect(r.value.title).toBe('t');
  });
  it('faster-whisper /v1/audio/transcriptions verbose_json', async () => {
    let url = '';
    let form: FormData | undefined;
    const fetch = async (u: string, i: any) => {
      url = u;
      form = i?.body as FormData;
      return Response.json({
        text: 'hi',
        language: 'en',
        duration: 3,
        segments: [{ start: 0, end: 1, text: ' hi' }],
      });
    };
    const r = await new FasterWhisperProvider({
      baseUrl: 'http://localhost:8000',
      policy: local,
      fetch,
      model: 'small',
    }).transcribe({ bytes: new Uint8Array([1, 2]) });
    expect(url).toBe('http://localhost:8000/v1/audio/transcriptions');
    expect(form?.get('response_format')).toBe('verbose_json');
    expect(r.segments[0]).toEqual({ startSec: 0, endSec: 1, text: 'hi' });
  });
  it('local adapter blocked when origin not enabled', async () => {
    const p = new OllamaProvider({
      baseUrl: 'http://localhost:11434',
      policy: { allowedHosts: [], allowedLocalOrigins: [] },
      fetch: async () => Response.json({}),
    });
    await expect(p.generateText({ model: 'm', prompt: 'p' })).rejects.toMatchObject({
      code: 'SSRF_BLOCKED',
    });
  });
});

describe('capability detection', () => {
  it('no adapter is assumed to stream/embed; deepgram stub disabled', async () => {
    expect(
      hasStreaming(new FasterWhisperProvider({ baseUrl: 'http://x', policy: local, model: 'm' })),
    ).toBe(false);
    expect(hasEmbeddings(new GeminiProvider({ apiKey: 'k', policy: remote }))).toBe(false);
    expect(
      (await new AssemblyAIProvider({ apiKey: 'k', policy: remote }).getCapabilities()).streaming,
    ).toBe(false);
    await expect(new DeepgramProvider().transcribe()).rejects.toMatchObject({
      code: 'PROVIDER_DISABLED',
    });
  });
});

describe('AssemblyAI deleteTranscript (mocked fetch)', () => {
  const secretText = 'CONFIDENTIAL_TRANSCRIPT_BODY hello world';

  it('DELETE /v2/transcript/:id on success', async () => {
    const calls: Array<[string, any]> = [];
    const fetch = async (u: string, i: any) => {
      calls.push([u, i]);
      return new Response(secretText, { status: 200 });
    };
    const a = new AssemblyAIProvider({ apiKey: 'k', policy: remote, fetch, lookup: pubLookup });
    const r = await a.deleteTranscript('tr-abc');
    expect(calls[0]?.[0]).toBe('https://api.assemblyai.com/v2/transcript/tr-abc');
    expect(calls[0]?.[1].method).toBe('DELETE');
    expect(r).toEqual({ outcome: 'deleted', httpStatus: 200 });
  });

  it('treats 404 as already-deleted success', async () => {
    const fetch = async () => new Response(secretText, { status: 404 });
    const a = new AssemblyAIProvider({ apiKey: 'k', policy: remote, fetch, lookup: pubLookup });
    await expect(a.deleteTranscript('tr1')).resolves.toEqual({
      outcome: 'already_deleted',
      httpStatus: 404,
    });
  });

  it('maps 5xx to a retryable PROVIDER_UNAVAILABLE error', async () => {
    const fetch = async () => new Response(secretText, { status: 503 });
    const a = new AssemblyAIProvider({ apiKey: 'k', policy: remote, fetch, lookup: pubLookup });
    await expect(a.deleteTranscript('tr1')).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
      retryable: true,
    });
  });

  it('does not put transcript content in thrown error messages', async () => {
    const fetch = async () => new Response(secretText, { status: 500 });
    const a = new AssemblyAIProvider({ apiKey: 'k', policy: remote, fetch, lookup: pubLookup });
    try {
      await a.deleteTranscript('tr1');
      throw new Error('expected delete to fail');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      expect(msg).not.toContain(secretText);
      expect(msg).not.toContain('hello world');
      expect(msg).toMatch(/HTTP 500/);
    }
  });
});
