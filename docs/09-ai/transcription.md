# Transcription

Status: design.

- Primary provider: AssemblyAI (`AI_STT_PROVIDER=assemblyai`, key in `ASSEMBLYAI_API_KEY`).
- Optional, disabled by default: local STT (`LOCAL_STT_ENABLED`, `LOCAL_STT_URL`, e.g. faster-whisper) and Deepgram (`DEEPGRAM_ENABLED`).
- Flow: media is stored in object storage → the AI worker picks up a BullMQ job → `TranscriptionProvider` returns a timestamped, speaker-attributed transcript → the transcript is stored and linked as evidence for AI output.
- No automatic switch to another paid STT provider on failure; jobs retry on the configured provider, then fail visibly.
- Provider endpoints must be on the outbound allowlist.
- Recording consent is required before transcription.
