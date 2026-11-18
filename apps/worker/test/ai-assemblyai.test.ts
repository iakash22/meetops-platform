import { describe, expect, it } from 'vitest';
import {
  ASSEMBLYAI_WEBHOOK_HEADER,
  AssemblyAiTranscriptionProvider,
  ProviderError,
  mapAssemblyAiTranscript,
  parseAssemblyAiWebhook,
  verifyAssemblyAiWebhook,
} from '../src/ai/index.js';

const KEY = 'test-key-not-real';
type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };

function fakeFetch(responses: Array<() => Response | Promise<Response>>) {
  const calls: Call[] = [];
  const impl = async (url: string, init?: RequestInit) => {
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : init?.body;
    calls.push({
      url,
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body,
    });
    const next = responses.shift();
    if (!next) throw new Error('unexpected fetch');
    return next();
  };
  return { impl, calls };
}
const json = (status: number, body: unknown) => () =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const done = {
  id: 'tr_1',
  status: 'completed',
  text: 'Hi there. Ok.',
  language_code: 'en',
  audio_duration: 12.5,
  speech_model_used: 'assemblyai-stt-3-7',
  utterances: [
    { speaker: 'A', start: 0, end: 1200, text: 'Hi there.', confidence: 0.9 },
    { speaker: 'B', start: 1300, end: 2000, text: 'Ok.', confidence: 0.8 },
  ],
};
const make = (
  f: ReturnType<typeof fakeFetch>,
  over: Partial<ConstructorParameters<typeof AssemblyAiTranscriptionProvider>[0]> = {},
) => {
  let t = 0;
  return new AssemblyAiTranscriptionProvider({
    apiKey: KEY,
    fetch: f.impl,
    pollIntervalMs: 10,
    totalTimeoutMs: 1000,
    sleep: async (ms) => void (t += ms),
    now: () => t,
    ...over,
  });
};

describe('AssemblyAI adapter (mocked fetch)', () => {
  it('URL submit + poll maps utterances to speaker-labelled segments', async () => {
    const f = fakeFetch([
      json(200, { id: 'tr_1', status: 'queued' }),
      json(200, { id: 'tr_1', status: 'processing' }),
      json(200, done),
    ]);
    const out = await make(f).transcribe({
      audio: { kind: 'url', url: 'https://bucket.example/a.wav?sig=x' },
      speakerLabels: true,
    });
    expect(out).toMatchObject({
      provider: 'assemblyai',
      providerJobId: 'tr_1',
      language: 'en',
      durationMs: 12_500,
      model: 'assemblyai-stt-3-7',
    });
    expect(out.segments).toEqual([
      { speaker: 'A', startMs: 0, endMs: 1200, text: 'Hi there.', confidence: 0.9 },
      { speaker: 'B', startMs: 1300, endMs: 2000, text: 'Ok.', confidence: 0.8 },
    ]);
    expect(f.calls[0]).toMatchObject({
      url: 'https://api.assemblyai.com/v2/transcript',
      method: 'POST',
    });
    expect(f.calls[0]!.headers.authorization).toBe(KEY);
    expect(f.calls[0]!.body).toMatchObject({
      audio_url: 'https://bucket.example/a.wav?sig=x',
      speaker_labels: true,
      language_detection: true,
    });
    expect(f.calls.slice(1).map((c) => c.url)).toEqual(
      Array(2).fill('https://api.assemblyai.com/v2/transcript/tr_1'),
    );
  });

  it('bytes are uploaded first, then submitted with the upload URL and language', async () => {
    const f = fakeFetch([
      json(200, { upload_url: 'https://cdn.assemblyai.com/upload/u1' }),
      json(200, { id: 'tr_1' }),
      json(200, done),
    ]);
    await make(f).transcribe({
      audio: { kind: 'bytes', bytes: new Uint8Array([1, 2]) },
      language: 'en',
      speakerLabels: false,
    });
    expect(f.calls[0]).toMatchObject({
      url: 'https://api.assemblyai.com/v2/upload',
      method: 'POST',
    });
    expect(f.calls[1]!.body).toMatchObject({
      audio_url: 'https://cdn.assemblyai.com/upload/u1',
      language_code: 'en',
      speaker_labels: false,
    });
  });

  it('webhook mode sends the auth header config; fetchResult reports pending', async () => {
    const f = fakeFetch([
      json(200, { id: 'tr_9' }),
      json(200, { id: 'tr_9', status: 'processing' }),
    ]);
    const p = make(f, {
      webhookUrl: 'https://api.example/webhooks/assemblyai',
      webhookSecret: 's3cret',
    });
    expect(
      await p.submit({ audio: { kind: 'url', url: 'https://x.example/a' }, speakerLabels: true }),
    ).toBe('tr_9');
    expect(f.calls[0]!.body).toMatchObject({
      webhook_url: 'https://api.example/webhooks/assemblyai',
      webhook_auth_header_name: ASSEMBLYAI_WEBHOOK_HEADER,
    });
    expect(await p.fetchResult('tr_9')).toEqual({ status: 'pending' });
    await expect(p.fetchResult('../etc')).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it.each([
    [401, 'auth', false],
    [403, 'auth', false],
    [400, 'invalid_request', false],
    [429, 'rate_limited', true],
    [503, 'unavailable', true],
  ] as const)(
    'HTTP %i maps to %s (retryable=%s) without leaking the key or body',
    async (status, code, retryable) => {
      const f = fakeFetch([json(status, { error: `bad key ${KEY}` })]);
      const err = (await make(f)
        .transcribe({ audio: { kind: 'url', url: 'https://x.example/a' }, speakerLabels: true })
        .catch((e: unknown) => e)) as ProviderError;
      expect(err).toBeInstanceOf(ProviderError);
      expect(err).toMatchObject({ code, retryable, status });
      expect(err.message).not.toContain(KEY);
    },
  );

  it('provider error status, network failure, malformed body and polling timeout', async () => {
    const run = (f: ReturnType<typeof fakeFetch>, over = {}) =>
      make(f, over)
        .transcribe({ audio: { kind: 'url', url: 'https://x.example/a' }, speakerLabels: true })
        .catch((e: unknown) => e as ProviderError);
    expect(
      await run(
        fakeFetch([
          json(200, { id: 't' }),
          json(200, { id: 't', status: 'error', error: 'secret detail' }),
        ]),
      ),
    ).toMatchObject({ code: 'provider_failed', retryable: false });
    expect(
      await run(fakeFetch([() => Promise.reject(new Error(`ECONNRESET ${KEY}`))])),
    ).toMatchObject({ code: 'unavailable', retryable: true });
    expect(await run(fakeFetch([() => new Response('not json', { status: 200 })]))).toMatchObject({
      code: 'bad_response',
    });
    const pending = Array.from({ length: 200 }, () => json(200, { id: 't', status: 'processing' }));
    expect(
      await run(fakeFetch([json(200, { id: 't' }), ...pending]), { totalTimeoutMs: 50 }),
    ).toMatchObject({ code: 'timeout', retryable: true });
  });

  it('per-request timeout aborts a hung call', async () => {
    const hang = (_u: string, init?: RequestInit) =>
      new Promise<Response>((_, rej) =>
        init?.signal?.addEventListener('abort', () => rej(new Error('aborted'))),
      );
    const p = new AssemblyAiTranscriptionProvider({
      apiKey: KEY,
      fetch: hang,
      requestTimeoutMs: 20,
    });
    await expect(
      p.submit({ audio: { kind: 'url', url: 'https://x.example/a' }, speakerLabels: true }),
    ).rejects.toMatchObject({ code: 'timeout' });
  });

  it('rejects non-https audio URLs, empty uploads and a missing key', async () => {
    const f = fakeFetch([]);
    await expect(
      make(f).submit({ audio: { kind: 'url', url: 'http://x.example/a' }, speakerLabels: true }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(
      make(f).submit({ audio: { kind: 'bytes', bytes: new Uint8Array() }, speakerLabels: true }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
    expect(f.calls).toHaveLength(0);
    expect(() => new AssemblyAiTranscriptionProvider({ apiKey: '' })).toThrow(ProviderError);
  });

  it('mapping falls back to one segment without utterances', () => {
    const r = mapAssemblyAiTranscript(
      { id: 'x', text: 'solo', words: [{ start: 100, end: 900 }], confidence: 0.7 },
      'assemblyai-stt-3-7',
    );
    expect(r.segments).toEqual([
      { speaker: null, startMs: 100, endMs: 900, text: 'solo', confidence: 0.7 },
    ]);
    expect(() => mapAssemblyAiTranscript({}, 'm')).toThrow(ProviderError);
  });

  it('webhook verification is exact and parse is strict', () => {
    expect(verifyAssemblyAiWebhook('s3cret', 's3cret')).toBe(true);
    expect(verifyAssemblyAiWebhook('s3creT', 's3cret')).toBe(false);
    expect(verifyAssemblyAiWebhook('s3cret-longer', 's3cret')).toBe(false);
    expect(verifyAssemblyAiWebhook(undefined, 's3cret')).toBe(false);
    expect(verifyAssemblyAiWebhook(['s3cret'], 's3cret')).toBe(false);
    expect(verifyAssemblyAiWebhook('', '')).toBe(false);
    expect(parseAssemblyAiWebhook({ transcript_id: 'tr_1', status: 'completed' })).toEqual({
      transcriptId: 'tr_1',
      status: 'completed',
    });
    expect(parseAssemblyAiWebhook({ transcript_id: '../x', status: 'completed' })).toBeUndefined();
    expect(parseAssemblyAiWebhook({ transcript_id: 'tr_1', status: 'queued' })).toBeUndefined();
    expect(parseAssemblyAiWebhook(null)).toBeUndefined();
  });
});

it('submit body uses speech_models and omits the legacy speech_model field', async () => {
  const f = fakeFetch([json(200, { id: 'tr_1' })]);
  await make(f).submit({ audio: { kind: 'url', url: 'https://x.example/a' }, speakerLabels: true });
  const body = f.calls[0]!.body as Record<string, unknown>;
  expect(body).toEqual({
    audio_url: 'https://x.example/a',
    speaker_labels: true,
    speech_models: ['assemblyai-stt-3-7'],
    language_detection: true,
  });
  expect(body).not.toHaveProperty('speech_model');
});

it('honours an explicit speechModels override in the request body', async () => {
  const f = fakeFetch([json(200, { id: 'tr_1' })]);
  await make(f, { speechModels: ['universal-2'] }).submit({
    audio: { kind: 'url', url: 'https://x.example/a' },
    speakerLabels: false,
  });
  expect(f.calls[0]!.body).toEqual({
    audio_url: 'https://x.example/a',
    speaker_labels: false,
    speech_models: ['universal-2'],
    language_detection: true,
  });
});

it('rejects an unknown speech model without calling the provider', async () => {
  const f = fakeFetch([]);
  expect(() => make(f, { speechModel: 'universal' })).toThrow(ProviderError);
  expect(f.calls).toHaveLength(0);
});

describe('loadAssemblyAiConfig', () => {
  it('is undefined without a key, clamps numbers, requires https base', async () => {
    const { loadAssemblyAiConfig } = await import('../src/ai/index.js');
    expect(loadAssemblyAiConfig({})).toBeUndefined();
    expect(
      loadAssemblyAiConfig({
        ASSEMBLYAI_API_KEY: 'k',
        AI_TRANSCRIPTION_POLL_INTERVAL_MS: '1',
        AI_TRANSCRIPTION_TIMEOUT_MS: 'abc',
      }),
    ).toMatchObject({
      apiKey: 'k',
      pollIntervalMs: 500,
      totalTimeoutMs: 1_800_000,
      requestTimeoutMs: 30_000,
    });
    expect(() =>
      loadAssemblyAiConfig({ ASSEMBLYAI_API_KEY: 'k', ASSEMBLYAI_BASE_URL: 'http://evil' }),
    ).toThrow(ProviderError);
    expect(loadAssemblyAiConfig({ ASSEMBLYAI_API_KEY: 'k' })?.speechModels).toEqual([
      'assemblyai-stt-3-7',
    ]);
    expect(
      loadAssemblyAiConfig({
        ASSEMBLYAI_API_KEY: 'k',
        ASSEMBLYAI_SPEECH_MODELS: 'assemblyai-stt-3-7,universal-2',
      })?.speechModels,
    ).toEqual(['assemblyai-stt-3-7', 'universal-2']);
    expect(
      loadAssemblyAiConfig({
        ASSEMBLYAI_API_KEY: 'k',
        ASSEMBLYAI_SPEECH_MODEL: 'universal-2',
      })?.speechModels,
    ).toEqual(['universal-2']);
    expect(() =>
      loadAssemblyAiConfig({ ASSEMBLYAI_API_KEY: 'k', ASSEMBLYAI_SPEECH_MODEL: 'universal' }),
    ).toThrow(ProviderError);
  });
});
