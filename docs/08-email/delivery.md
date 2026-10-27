# Email delivery (auth mail)

The api sends auth mail (verification, password reset, account exists, invitation, login lockout,
password changed) through `createAuthMailTransport(createEmailService(loadEmailConfig(env)))` from
`@meetops/notifications`. Jobs still run on the in-process `InlineAuthMailQueue`; moving them to the
BullMQ worker is a follow-up (production still needs an injected `mailQueue` until then).

## Provider selection

| Environment      | No email variables set               | Valid config   | Invalid config                |
| ---------------- | ------------------------------------ | -------------- | ----------------------------- |
| `test`           | console sender (env ignored)         | console sender | console sender                |
| `development`    | console sender (stores/logs nothing) | SMTP or Resend | `EmailConfigError` at startup |
| production/other | refuses to start (`mailTransport`)   | SMTP or Resend | `EmailConfigError` at startup |

"Email variables set" means any of `EMAIL_PROVIDER`, `SMTP_HOST`, `RESEND_API_KEY` is non-empty.
Error messages name the bad variables, never their values.

### SMTP (e.g. Gmail)

```
EMAIL_PROVIDER=smtp
SMTP_HOST=smtp.gmail.com
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=<gmail address>
SMTP_PASSWORD=<16-character app password>
EMAIL_FROM="MeetOps AI <same gmail address>"
```

Gmail app password:

1. Turn on 2-Step Verification for the Google account (Google Account > Security).
2. Open Google Account > Security > 2-Step Verification > App passwords (or search "App passwords").
3. Create one named e.g. "MeetOps dev" and copy the 16-character password (spaces are optional).
4. Put it in `SMTP_PASSWORD` (local `.env`) or `infra/compose/secrets/smtp_password.txt` (compose).
   Never commit it.
5. `EMAIL_FROM` should be the same Gmail address (or a verified "Send mail as" alias); Gmail rewrites
   other senders. Workspace accounts may need an admin to allow app passwords.

### Resend

```
EMAIL_PROVIDER=resend
RESEND_API_KEY=<key>          # compose: infra/compose/secrets/resend_api_key.txt
EMAIL_FROM="MeetOps AI <no-reply@your-verified-domain>"
```

Uses the HTTP API (`POST https://api.resend.com/emails`) with `fetch`; no SDK. The `EMAIL_FROM` domain
must be verified in Resend (SPF/DKIM DNS records). 429 and 5xx errors are marked retryable, other 4xx
permanent; error messages carry only the status and Resend's error name.

## Failure handling

Delivery failures never change an HTTP response: `InlineAuthMailQueue.enqueue` catches the error and
logs `auth mail delivery failed` with the job kind and the error's class/code/status only (no message,
recipient, link or provider body). Signup and resend-verification therefore return the same 202 whether
or not the mail went out. Jobs dropped because the token row or user is gone are logged at `warn`.
Because the queue is inline, the response still waits for the send attempt (timing is not hidden);
the BullMQ follow-up removes that.
