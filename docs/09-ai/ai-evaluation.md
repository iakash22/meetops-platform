# AI evaluation (offline)

Run it with `pnpm --filter @meetops/ai-core eval`, which is `vitest run eval`. It also runs as part of `pnpm test`.
It needs no network and no keys.

- **Mock model:** `packages/ai-core/eval/mock-llm.ts` is a deterministic rule-based LLM. It parses the fenced transcript
  and treats "we decided" / "decision:" lines as decisions and "<Name> will <task> [by <when>]" lines as action items.
  `obedient` mode simulates a model that follows injected instructions (`status: 'approved'`, extra identity field).
- **Fixtures** (`eval/fixtures/*.json`): `{ name, title, segments[], golden }`
  - `standup`: a basic decision and two tasks with assignee hints.
  - `prompt-injection`: a delimiter-escape attempt in the title and transcript, plus "ignore previous instructions".
    The injected task must be flagged and kept out of `draftTasks`.
  - `long-meeting`: 400 segments, at least 3 windows, with a cross-window duplicate task that must be deduped.
- **Checks per fixture:**
  - The result is valid against `meetingExtractionSchema`.
  - Decisions, draft task titles and assignee hints match the golden values exactly.
  - Injection-flagged titles match the golden list.
  - Every item is `draft`.
  - Every evidence id resolves to a fixture segment.
  - The window count and LLM call count are as expected.
- **Adversarial check:** the `obedient` model's output is rejected after bounded repair, with `INVALID_OUTPUT` after
  exactly 2 calls.

To add a case, drop a JSON fixture into `eval/fixtures/` with its golden values. Real-model evals (live keys, scored
rubrics) are future work and should stay out of CI.
