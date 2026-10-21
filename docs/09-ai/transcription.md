# Transcription

## Providers

- **AssemblyAI** (default, `AI_STT_PROVIDER=assemblyai`): official SDK, `client.transcripts.transcribe({ audio, speaker_labels, language_code | language_detection })`.
  The SDK uploads bytes or uses a URL, then polls. Utterances map to `segments` (ms → s, speaker, confidence).
  `audio_duration` gives `usage.audioSeconds`. Diarization: yes. Streaming: not wired yet (capability reports false).
- **faster-whisper (local)**, enabled with `LOCAL_STT_ENABLED=true` and `LOCAL_STT_URL`. It expects an
  **OpenAI-compatible** server, for example [speaches](https://github.com/speaches-ai/speaches) (formerly faster-whisper-server):
  - `POST {LOCAL_STT_URL}/v1/audio/transcriptions`, multipart: `file` (audio bytes), `model` (e.g. `Systran/faster-whisper-small`),
    `response_format=verbose_json`, optional `language`
  - Response: `{ text, language, duration, segments: [{ start, end, text }] }`
  - `GET {LOCAL_STT_URL}/health` must return 2xx
  - Accepts bytes only (no URL fetch). No diarization.
- **Deepgram**: stub, disabled.

## Results

`TranscriptionResult { text, segments[], language, durationSec, providerJobId }`. The executor wraps it with
`transcriptRevision` (pass it in `AIJobRequest`), provider, model and usage.

## Live transcription

The `live-transcription` feature requires the `streaming-transcription` capability. No adapter declares it yet, so
routing returns `failed` with `CAPABILITY_UNSUPPORTED` instead of silently using batch.

## Chunked transcription jobs (`TranscriptionChunkHandler`)

Media's pipeline enqueues one job per audio chunk. The payload is PR #17's `TranscriptionJobPayload` plus a `chunk` object
`{ index, count?, startSec, durationSec, overlapSec, fileObjectId }`. These chunk fields are **not in PR #17 yet** and need to
be added to `@meetops/contracts`.

How a chunk job is handled:

1. **Idempotency.** The key is `stt:<org>:<meeting>:<recording>:chunk:<index>`. If the chunk result is already stored, no STT
   call is made. The executor's idempotency store also dedupes concurrent redeliveries.
2. **Audio.** The `AudioResolver` (Media/Storage) reads `chunk.fileObjectId` server-side, checks the tenant, and returns **bytes**. Providers never fetch our URLs. The `JobActorResolver` supplies a server-derived actor. Without one, the payload's `sttProviderId` is ignored and normal routing applies.
3. **Transcription.** The STT call goes through `AIExecutor` (routing, quota, bounded retry, usage in audio seconds).
4. **Storage.** The chunk is stored first-write-wins (`TranscriptStore.putChunk`).
5. **Merge.** All received chunks are re-merged with `mergeChunkTranscripts`:
   - **Offsets.** Segment times are shifted by `chunk.startSec`.
   - **Overlap.** The overlap with the previous chunk is split at its midpoint. A segment is kept only in the chunk whose
     window contains the segment's midpoint.
   - **Ordering and duplicates.** Chunks are sorted by index, and the first received result wins. Gaps go into
     `missingChunks`. `complete` is true when there are no gaps and `count` is met.
   - **Speakers.** Provider labels are chunk-local. They are mapped to recording-wide `S1, S2…` by time overlap with the
     previous chunk's speech in the overlap region. Unmatched labels get new ids.
   - **Segment ids.** These are stable `c<chunk>-s<n>` ids, used as evidence references.
6. **Revision.** A new revision (`revision + 1`) is written only when the content hash or completeness changes. It uses
   compare-and-set on the previous revision, and the CAS loop is bounded.

## Consuming Media's transcription queue (PR #39)

Media's worker enqueues one contracts `TranscriptionJobPayload` per 16 kHz mono WAV chunk at
`processed/{rec}/chunks/NNNNN.wav`. Each job has the BullMQ job id `transcribe_{org}_{rec}_{NNNNN}` and the
idempotency key `transcribe:{rec}:{index}`. `createTranscriptionQueueConsumer(handler, { segmentSeconds })` (in
`packages/ai-core/src/transcription/queue.ts`) maps each job to a `TranscriptionChunkJobPayload`:

- **Index:** taken from `chunkIndex` once Architecture adds it in PR #38. Until then it is derived with
  `parseTranscriptionIdempotencyKey`. If both are present they must agree.
- **Validation:** the key's recording must equal `recordingId`, and the job id must match the payload. A mismatch
  throws `InvalidTranscriptionJobError`, which is non-retryable.
- **Geometry:** `startSec = index * segmentSeconds`, overlap 0 (ffmpeg `-segment_time`). `segmentSeconds` must
  equal Media's `MEDIA_CHUNK_SECONDS` (default 600). `durationSec` is nominal; the provider-reported duration wins.
- **Completeness:** the chunk count is not on the payload, so `complete` needs the count from Media's manifest.
