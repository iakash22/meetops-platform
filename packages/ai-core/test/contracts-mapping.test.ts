import { describe, it, expect } from 'vitest';
import { aiJobToRequest, parseModelRouteId, transcriptionJobToRequest } from '../src/index.js';

describe('@meetops/contracts mapping (local mirror of PR #17)', () => {
  it('parses provider:model route ids', () => {
    expect(parseModelRouteId('gemini:gemini-2.5-flash-lite')).toEqual({ provider: 'gemini', model: 'gemini-2.5-flash-lite' });
    expect(() => parseModelRouteId('evil:x')).toThrow();
  });
  it('maps AiJobPayload with explicit fallbacks only', () => {
    const r = aiJobToRequest({ jobVersion: 1, organizationId: '00000000-0000-4000-8000-00000000000c', idempotencyKey: 'k', kind: 'extract_tasks', meetingId: '10000000-0000-4000-8000-000000000001', transcriptId: '20000000-0000-4000-8000-000000000001', modelRouteId: 'gemini:gemini-2.5-flash-lite', promptVersion: 'p1', fallback: { fallbackRouteIds: ['ollama:llama3.2'], allowPaidFallback: false } });
    expect(r).toMatchObject({ organizationId: '00000000-0000-4000-8000-00000000000c', feature: 'actions', override: { provider: 'gemini', fallbacks: ['ollama'] } });
  });
  it('maps TranscriptionJobPayload', () => {
    const r = transcriptionJobToRequest({ jobVersion: 1, organizationId: '00000000-0000-4000-8000-00000000000e', idempotencyKey: 'k', kind: 'transcribe_recording', meetingId: '10000000-0000-4000-8000-000000000001', recordingId: '30000000-0000-4000-8000-000000000001', fileObjectId: '40000000-0000-4000-8000-000000000001', sttProviderId: 'assemblyai', diarize: true });
    expect(r.override.provider).toBe('assemblyai');
  });
});
