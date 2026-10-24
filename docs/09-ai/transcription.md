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
