import { describe, it, expect } from 'vitest';
import {
  aiJobToRequest,
  transcriptionJobToRequest,
  type AiJobPayload,
  type TranscriptionJobPayload,
} from '../src/index.js';
import { admin, setup } from './helpers.js';

const ORG = '00000000-0000-4000-8000-00000000000c';
const aiJob = (o: Partial<AiJobPayload> = {}): AiJobPayload => ({
  jobVersion: 1,
  organizationId: ORG,
  idempotencyKey: 'k',
  kind: 'extract_tasks',
  meetingId: '10000000-0000-4000-8000-000000000001',
  transcriptId: '20000000-0000-4000-8000-000000000001',
  modelRouteId: 'gemini:gemini-2.5-flash-lite',
  promptVersion: 'p1',
  ...o,
});
const sttJob = (o: Partial<TranscriptionJobPayload> = {}): TranscriptionJobPayload => ({
  jobVersion: 1,
  organizationId: ORG,
  idempotencyKey: 'k',
  kind: 'transcribe_recording',
  meetingId: '10000000-0000-4000-8000-000000000001',
  recordingId: '30000000-0000-4000-8000-000000000001',
  fileObjectId: '40000000-0000-4000-8000-000000000001',
  sttProviderId: 'assemblyai',
  diarize: true,
  ...o,
});

describe('@meetops/contracts mapping', () => {
  it('maps AiJobPayload with explicit fallbacks', () => {
    const r = aiJobToRequest(
      aiJob({ fallback: { fallbackRouteIds: ['ollama:llama3.2'], allowPaidFallback: false } }),
    );
    expect(r).toMatchObject({
      organizationId: ORG,
      feature: 'actions',
      override: { provider: 'gemini', fallbacks: ['ollama'] },
    });
  });

  it('N3: no job fallback -> undefined (not []); explicit [] is preserved', () => {
    expect(aiJobToRequest(aiJob()).override.fallbacks).toBeUndefined();
    expect(
      aiJobToRequest(aiJob({ fallback: { fallbackRouteIds: [], allowPaidFallback: false } }))
        .override.fallbacks,
    ).toEqual([]);
  });

  it('N3: org fallbacks apply when the job has none; an explicit job list overrides them', async () => {
    const s = await setup({ providers: {}, configs: [] });
    await s.router.setOrgConfig(
      { organizationId: ORG, features: { actions: { provider: 'gemini', fallbacks: ['openai'] } } },
      admin(ORG),
    );
    const none = await s.router.resolve(
      ORG,
      'actions',
      aiJobToRequest(aiJob()).override,
      admin(ORG),
    );
    expect(none.fallbacks).toEqual(['openai']);
    const explicit = aiJobToRequest(
      aiJob({ fallback: { fallbackRouteIds: ['ollama:llama3.2'], allowPaidFallback: false } }),
    );
    expect(
      (await s.router.resolve(ORG, 'actions', explicit.override, admin(ORG))).fallbacks,
    ).toEqual(['ollama']);
  });

  it('N2: transcription ignores job (LLM) fallback route ids', () => {
    const r = transcriptionJobToRequest(
      sttJob({
        fallback: {
          fallbackRouteIds: ['gemini:gemini-2.5-flash-lite', 'ollama:llama3.2'],
          allowPaidFallback: true,
        },
      }),
    );
    expect(r.override.provider).toBe('assemblyai');
    expect(r.override.fallbacks).toBeUndefined();
    expect(transcriptionJobToRequest(sttJob()).override.fallbacks).toBeUndefined();
  });

  it('N2: job LLM fallbacks never become STT fallbacks (STT has none, ADR-009)', async () => {
    const s = await setup({ providers: {}, configs: [] });
    await s.router.setOrgConfig(
      { organizationId: ORG, features: { transcription: { provider: 'assemblyai' } } },
      admin(ORG),
    );
    const r = transcriptionJobToRequest(
      sttJob({
        fallback: { fallbackRouteIds: ['gemini:gemini-2.5-flash-lite'], allowPaidFallback: true },
      }),
    );
    expect(
      (await s.router.resolve(ORG, 'transcription', r.override, admin(ORG))).fallbacks,
    ).toEqual([]);
  });
});
