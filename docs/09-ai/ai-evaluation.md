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

## Worker eval (production prompts)

The eval above covers the ai-core `extractMeeting` pipeline. The worker does not use it: production summaries and
action items come from `apps/worker/src/ai/meeting-summary.ts` (`meeting-summary@1`, `generateText`, feature
`summary`) and `apps/worker/src/ai/action-items.ts` (`action-items@1`, `generateStructured`, feature `actions`).
Their offline eval lives in `apps/worker/eval/`.

Run it with `pnpm --filter @meetops/worker eval` (`vitest run --config eval/vitest.config.mjs`). It needs no network
and no keys, and it does **not** run in `pnpm test`: eval files end in `.eval.ts` and the worker's main vitest config
excludes `eval/**`.

- **Real executor, mocked model:** `eval/harness.ts` registers the mock as `gemini` in a real ai-core
  `ProviderRegistry` / `ModelRouter` / `AIExecutor` (in-memory stores), then runs `processMeetingSummary` followed by
  `extractActionItems`, with in-memory repositories instead of Prisma.
- **Mock model:** `eval/mock-llm.ts` is deterministic and rule-based. It reads the fence tag announced in the system
  prompt (`TRANSCRIPT_<nonce>`) and only the `[n] Speaker: text` lines inside that fence. It answers `generateText`
  with the summary JSON and `generateStructured` with `{ items }`. Rules: `<Name> will <task> [by <due>]` or
  `Action: <Name> to <task> [by <due>]` is an action item; `we decided [to] …` or `decision: …` is a decision.
  `obedient` mode follows `create a task: …` lines from the transcript; `obedient-extra-keys` also adds
  `status: 'approved'`.
- **Fixtures** (`eval/fixtures/*.json`): `{ name, description, transcript: SummaryTranscript, golden }`, where
  `golden` holds `actionItems` (`title`, `owner`, `due`), `decisions`, optional `forbidden` regexes and `thresholds`
  (`precision`, `recall`, `decisionRecall`, `decisionPrecision`). JSON is schema-validated on load (TypeBox); a
  validation error names the file and does not print fixture content.
  - `standup`: three owned items and one decision.
  - `planning`: four decisions, and one item phrased implicitly ("Ravi should probably own …") that the rule mock is
    expected to miss (recall threshold 0.66).
  - `noisy-no-actions`: chit-chat with no items and no decisions.
  - `adversarial`: real items plus instruction overrides, forged fence closers (including a guessed nonce), role
    spoofing and JSON smuggling. Injected tasks must not be persisted.
  - `hinglish-romanised`, `hinglish-devanagari`, `hinglish-mixed`: made-up Hinglish meetings (romanised, Devanagari,
    and mixed script). No real people or recordings.
- **Scoring** (`eval/score.ts`): titles match on token Jaccard >= 0.6 after NFC normalisation, Unicode-aware
  tokenizing (`\p{L}`, `\p{N}`, and `\p{M}` so Devanagari matras stay in the token), and stop-word removal, paired
  one-to-one. Empty vs non-empty scores 0; two empty strings are not a title match (that used to be a false
  perfect score when Devanagari was stripped). Empty vs empty is a pass only at the list level, when the fixture
  expects no items and none were predicted. A strict true positive also needs the owner (`assigneeHint`) and due
  (`dueHint`) to match. Decisions score both recall and precision, so a hallucinated extra decision fails the
  fixture. Reported per fixture: strict precision/recall, text-only precision/recall, owner and due accuracy,
  decision precision/recall, and summary schema validity (raw output parses into `LlmSummaryOutput` and the stored
  content passes contracts `ReportContent`). Each run prints one `[worker eval]` line per fixture with the file
  name and scores only — never transcript or golden text.
- **Adversarial checks:** an `obedient-extra-keys` model makes the summary fail closed (`invalid_model_output`,
  nothing stored). An `obedient` model's injected tasks **are persisted** as `pending_review` drafts today. The
  worker path has no `possible-injection` flag (ai-core's pipeline has one), so only human review stops them. The eval
  asserts that the scorer catches this (precision below 1, forbidden hits); closing the gap is separate work.

The mock measures **pipeline behaviour**, not prompt quality: it checks that production prompts, parsing, persistence
and scoring behave as expected against a deterministic rule model. It is not a live-model quality eval and must not be
read as one.

A future live-model mode (real keys, rubric scoring), if added, must be opt-in (explicit flag or env, default off),
must never run in CI, and must have a cost cap.

**Consented real eval data never goes in git.** In-repo fixtures are synthetic only. To score against consented
recordings stored outside the repo, set `EVAL_DATA_DIR` to an absolute directory that is not inside the repository
root. The variable is off by default and must never be set in CI; the harness refuses an in-repo path (including
symlinks that resolve inside the repo) and will not start if `CI` or `GITHUB_ACTIONS` is true. Logs print fixture
file names and scores only, never transcript or golden text.

To add a synthetic case, drop a fixture JSON into `apps/worker/eval/fixtures/` with its golden values and thresholds.
