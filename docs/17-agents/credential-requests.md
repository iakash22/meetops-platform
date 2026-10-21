# Credential requests

Track every credential an agent needs. **Never record secret values** here, in commits, PRs, issues, Slack or logs. Record variable names and status only; values go in local `.env` files or the deployment secret store.

Variable names match `.env.example`.

| Service | Variables | Reason | Setup link | Scopes | Blocking? | What can continue | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| GitHub | `GITHUB_TOKEN` (used by `gh auth`) | Push branches, open PRs, read repo | https://github.com/settings/tokens | `repo` | No (provided) | Everything | Provided |
| Google Gemini | `GEMINI_API_KEY` (plus `AI_LLM_PROVIDER`, `GEMINI_MODEL`) | Primary LLM for reports and action extraction | https://aistudio.google.com/app/apikey | API key (no OAuth scopes) | No | Contracts, adapters with mocks, tests | Pending |
| AssemblyAI | `ASSEMBLYAI_API_KEY` (plus `AI_STT_PROVIDER`) | Primary speech-to-text | https://www.assemblyai.com/dashboard | API key (no OAuth scopes) | No | Transcription contracts, mocked tests, media pipeline | Pending |
| Gmail SMTP | `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD`, `EMAIL_FROM` | Dev email (verification, invites, notifications) | https://myaccount.google.com/apppasswords | Google App Password (requires 2-Step Verification) | No | `EmailService` interface, queue, templates with a mock transport | Pending |

## How to add a request

Add a row, set status to `Pending`, and post the request in `#keys-and-requirements`. When provided, change status to `Provided` and log the date in `progress-log.md`. Never paste the value.
