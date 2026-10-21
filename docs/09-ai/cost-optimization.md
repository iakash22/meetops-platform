# Cost optimization

Status: design. No pricing figures are recorded here; check provider pricing pages before decisions.

- Free local stack by default (MinIO, Postgres, Redis); paid AI calls happen only when keys are configured.
- No automatic paid fallback: a failure never silently moves spend to a second provider (`AI_ALLOW_PAID_FALLBACK=false`).
- Provider changes need approval (`AI_REQUIRE_PROVIDER_APPROVAL=true`).
- Use the configured lightweight Gemini model by default and escalate only via explicit routing config.
- Avoid repeat work: cache transcripts and AI outputs by input checksum; don't re-transcribe unchanged media.
- Bound retries with backoff in BullMQ.
- Track provider, model and usage per call so cost can be reported per organization and meeting.
- Optional local providers (Ollama, local STT) can be enabled for development to avoid paid calls.
