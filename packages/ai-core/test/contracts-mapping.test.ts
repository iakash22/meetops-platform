import { describe, it, expect } from 'vitest';
import { aiJobToRequest, parseModelRouteId, transcriptionJobToRequest } from '../src/index.js';

describe('@meetops/contracts mapping (local mirror of PR #17)', () => {
  it('parses provider:model route ids', () => {
    expect(parseModelRouteId('gemini:gemini-2.5-flash-lite')).toEqual({ provider: 'gemini', model: 'gemini-2.5-flash-lite' });
    expect(() => parseModelRouteId('evil:x')).toThrow();
  });
  it('maps AiJobPayload with explicit fallbacks only', () => {
    const r = aiJobToRequest({ jobVersion: 1, organizationId: 'org1', idempotencyKey: 'k', kind: 'extract_tasks', meetingId: 'm', transcriptId: 't', modelRouteId: 'gemini:gemini-2.5-flash-lite', promptVersion: 'p1', fallback: { fallbackRouteIds: ['ollama:llama3.2'], allowPaidFallback: false } });
    expect(r).toMatchObject({ tenantId: 'org1', feature: 'actions', override: { provider: 'gemini', fallbacks: ['ollama'] } });
  });
  it('maps TranscriptionJobPayload', () => {
    const r = transcriptionJobToRequest({ jobVersion: 1, organizationId: 'o', idempotencyKey: 'k', kind: 'transcribe_recording', meetingId: 'm', recordingId: 'r', fileObjectId: 'f', sttProviderId: 'assemblyai', diarize: true });
    expect(r.override.provider).toBe('assemblyai');
  });
});
