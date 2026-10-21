# Slack channel map

Workspace: **MeetOps Engineering**.

| Channel                  | Purpose                                                              |
| ------------------------ | -------------------------------------------------------------------- |
| `#agent-coordination`    | Coordinator and agent assignments, handoffs, blockers                |
| `#ai-engineering`        | AI core, LLM and speech-to-text providers, prompts, evals            |
| `#backend`               | API, database, workers, queues                                       |
| `#integrations`          | GitHub, Jira, calendar and other third-party integrations            |
| `#devops`                | CI, Docker Compose, infra, deployments                               |
| `#qa-testing`            | Test plans, failures, QA sign-off                                    |
| `#project-updates`       | Phase status and milestone summaries for stakeholders                |
| `#commits-and-branches`  | Branch creation, pushes, PRs and merges                              |
| `#keys-and-requirements` | Credential and access requests (names and status only, never values) |

## Slack app setup

1. Create an app at https://api.slack.com/apps ("From scratch"), in the MeetOps Engineering workspace.
2. Under **OAuth & Permissions**, add bot token scopes as needed, typically `chat:write`, `channels:read`, `channels:history`, and `chat:write.public` to post in channels the bot hasn't joined.
3. Install the app to the workspace and invite the bot to the channels above (`/invite @<app-name>`).
4. Store credentials only in local `.env` or the secret store. Suggested variable names: `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`. (Not yet in `.env.example`; add them there with empty values when the integration lands.)
5. Record the request in `credential-requests.md`. Never record the token values.
