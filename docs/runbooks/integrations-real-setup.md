# Runbook: connect a real GitHub App and Jira OAuth app (local dev)

Status: dev only. Production wiring (KEK, Redis state/delivery stores, secret manager) is parked under ADR-008 and
is injected as `deps.integrationsRuntime`. The integration-routing RLS migration fix is landing in a separate PR;
webhook delivery to a stored integration depends on it.

All paths below come from `INTEGRATION_PATHS` in `packages/contracts/src/constants.ts` (contracts 0.12.0) and are
served by `apps/api/src/modules/integrations/index.ts`.

## 1. Routes

| Purpose                      | Method and path                                                             | Notes                                                                |
| ---------------------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Provider catalogue + status  | `GET /orgs/:organizationId/integrations/providers`                          | session; CASL read Organization                                      |
| List connections             | `GET /orgs/:organizationId/integrations`                                    | session; read Organization                                           |
| Start connect                | `POST /orgs/:organizationId/integrations/connect` `{ provider, returnTo? }` | session + CSRF + Origin; update Organization; returns `authorizeUrl` |
| OAuth / App-install callback | `GET /integrations/:provider/callback`                                      | `provider` = `jira` or `github`; signed single-use state             |
| Disconnect                   | `DELETE /orgs/:organizationId/integrations/:integrationId`                  | session + CSRF + Origin; wipes secrets                               |
| Push task issue              | `POST /orgs/:organizationId/tasks/:taskId/integration-issues`               | session + CSRF + Origin                                              |
| Webhook receiver             | `POST /webhooks/:provider/:integrationId`                                   | no session; HMAC before org lookup; 1 MiB cap; replay-protected      |

The callback is built as `${INTEGRATIONS_API_ORIGIN}/integrations/<provider>/callback`. The provider app must use
exactly that URL; the server never accepts a user-supplied redirect host. The worker (token refresh, calendar
sync) builds the same URIs. Unless `NODE_ENV` is exactly `development` or `test` (production, staging, an unset
`NODE_ENV` or any other value) it requires `INTEGRATIONS_API_ORIGIN` (bare `https://` origin, no localhost default)
and fails startup with a clear error when it is missing or not https. In development/test an unset value defaults
to `http://localhost:4000`, which is not the API's default port (3000), so set it explicitly for local OAuth.

## 2. Public URL with a free tunnel (cloudflared quick tunnel)

OAuth redirects work on `http://localhost:3000`, but webhooks need a public HTTPS URL.

```bash
# install (Linux x86_64; or: brew install cloudflared)
curl -fsSLo ~/.local/bin/cloudflared https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64
chmod +x ~/.local/bin/cloudflared
# expose the API (PORT=3000 in .env)
cloudflared tunnel --url http://localhost:3000
# prints https://<random>.trycloudflare.com. The name changes every run, so update the provider apps when it does.
```

Then set `INTEGRATIONS_API_ORIGIN=https://<random>.trycloudflare.com` in `.env` and use that origin in the
provider settings below. For a stable hostname, use a named Cloudflare tunnel instead.

## 3. GitHub App

Create it at GitHub → Settings → Developer settings → GitHub Apps → New.

- **Callback URL:** `<API_ORIGIN>/integrations/github/callback`
- **Setup URL (post-install):** `<API_ORIGIN>/integrations/github/callback`. Tick "Redirect on update".
- **Request user authorization (OAuth) during installation:** on. The callback checks that the installing user can
  access the installation.
- **Webhook URL:** `<API_ORIGIN>/webhooks/github/<integrationId>`. **Known gap:** a GitHub App has one webhook URL,
  but the route is per integration. For local testing, connect once, read the `integrationId` from
  `GET /orgs/:organizationId/integrations`, then set the webhook URL to that integration. An App-wide route is a follow-up.
- **Webhook secret:** generate a random value (`openssl rand -hex 32`) and put it in `GITHUB_APP_WEBHOOK_SECRET`.
- **Repository permissions (least privilege):** Issues: Read and write. Metadata: Read-only (mandatory). Nothing else.
- **Account permissions:** none.
- **Subscribe to events:** Issues only (the status sync maps `issues` events; everything else is ignored).
- **Where can it be installed:** "Only on this account" for testing.
- After creating it, note the App ID, Client ID and slug (from `https://github.com/apps/<slug>`), generate a client
  secret, and generate a private key. Save the `.pem` as `./.secrets/github-app.pem` (gitignored).

## 4. Jira (Atlassian OAuth 2.0 3LO)

Create it at https://developer.atlassian.com/console/myapps → Create → OAuth 2.0 integration.

- **Permissions → Jira API, classic scopes:** `read:jira-work`, `write:jira-work`, `read:jira-user`. `offline_access`
  is requested automatically. Do not add more; the server rejects grants outside this set (`JIRA_OAUTH_SCOPES`).
- **Authorization → Callback URL:** `<API_ORIGIN>/integrations/jira/callback`
- Authorize exactly one Jira site during connect.
- **Webhooks (known gap):** the receiver is `POST <API_ORIGIN>/webhooks/jira/<integrationId>`. It verifies
  `X-Hub-Signature: sha256=…` with a per-integration secret that the server generates at connect. That secret is
  not yet registered with Jira or shown anywhere, so real Jira webhooks can't be configured yet. Registering the
  webhook through the Jira REST API at connect is a follow-up. Connect and issue push work without it.

## 5. Supplying config (never commit values)

Put these in `.env` (gitignored) or export them in your shell. `.secrets/` is gitignored for the private key.
They're read only in development/test (`devIntegrationsRuntime(integrationsRuntimeFromEnv())`). Each provider
counts as configured only when all of its variables are set.

```dotenv
INTEGRATIONS_API_ORIGIN=http://localhost:3000        # or the trycloudflare origin
INTEGRATIONS_WEB_ORIGIN=http://localhost:5173        # where the callback redirects the browser
GITHUB_APP_ID=
GITHUB_APP_SLUG=
GITHUB_APP_CLIENT_ID=
GITHUB_APP_CLIENT_SECRET=
GITHUB_APP_PRIVATE_KEY_FILE=./.secrets/github-app.pem
GITHUB_APP_WEBHOOK_SECRET=
JIRA_CLIENT_ID=
JIRA_CLIENT_SECRET=
```

This is one app per deployment, shared by all orgs. Each org then connects its own GitHub installation or Jira site
through the connect flow, and the resulting tokens are encrypted at rest per integration. Tokens are never returned
by the API and are redacted from logs (`REDACT_KEYS`).

In dev, the token-encryption key and state-signing key are random per process, so restarting the API makes
existing dev connections undecryptable. Reconnect after a restart.

## 6. Check

1. `pnpm dev:api`, sign in on the web app, then `GET /orgs/<org>/integrations/providers`. Both providers should
   show `configured: true` and `connectionStatus: "not_connected"`.
2. Connect Jira from the web page (or `POST …/integrations/connect {"provider":"jira"}` with CSRF), approve it,
   and confirm you land on `INTEGRATIONS_WEB_ORIGIN/…?integration=jira&status=connected`.
3. `GET …/providers` should now show `connectionStatus: "active"`.
