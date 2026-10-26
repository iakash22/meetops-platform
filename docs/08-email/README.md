# Email templates

All product email is rendered by `@meetops/notifications` (`packages/notifications/src/email`). Templates are
hand-written, email-client-safe HTML with a plain-text twin. No MJML/react-email, no extra dependencies.

## Catalogue

| Name                     | Kind    | Trigger                                              | Unsubscribe |
| ------------------------ | ------- | ---------------------------------------------------- | ----------- |
| `verification`           | Auth    | Sign-up / resend verification (`email_verification`) | No          |
| `password-reset`         | Auth    | Forgot password (`password_reset`)                   | No          |
| `invitation`             | Auth    | Org invitation (`invitation`)                        | No          |
| `account-exists`         | Auth    | Sign-up with a registered email (`account_exists`)   | No          |
| `login-lockout`          | Auth    | Lockout after failed sign-ins (`login_lockout`)      | No          |
| `password-changed`       | Auth    | Password changed or reset                            | No          |
| `member-added`           | Product | Added to an organization                             | Yes         |
| `member-removed`         | Product | Removed from an organization                         | Yes         |
| `meeting-summary`        | Product | Meeting processed, summary ready                     | Yes         |
| `tasks-ready-for-review` | Product | Extracted tasks waiting for approval                 | Yes         |
| `task-assigned`          | Product | Task assigned to the recipient                       | Yes         |
| `integration-error`      | Product | GitHub/Jira connection failing                       | Yes         |

`renderEmail(name, variables)` renders any of them. The queue registry (`renderTemplate`) still covers exactly the
`@meetops/contracts` `EMAIL_TEMPLATE_IDS` and delegates to the same renderers.

## Rules (from `docs/references.md` section 1 and 9)

- Dark theme matching `apps/web/src/index.css`: `#0A0A0A` page, `#141416` card, `#1C1C1F` raised panels,
  `#2A2A2E` borders, `#F5F5F7` text, `#A1A1AA` muted, radii 6/8/12/16px. Cerulean `#007BA7` is a **fill only**
  (CTA button, top accent bar, panel accent); links and overlines are `#3AB0E0`; errors use `#EF4444`, never
  rose. Rose isn't used in email.
- Layout: logo + "MeetOps AI" header, overline label, 28px hero heading, 46px cerulean CTA, link fallback,
  footer with tagline. Meeting summary uses date/count chips, a summary panel and numbered action items.
- WCAG AA: every text/background pair is asserted >= 4.5:1 in `test/email-catalog.test.ts`.
- A `prefers-color-scheme: light` block swaps to a light palette for clients that force light; every colour is also
  inlined, so clients that strip `<style>` still get the dark theme.
- Table layout, inline styles, no external CSS/JS, no remote images, no tracking pixels. The logo (rasterised from `apps/web/src/features/auth/logo.tsx`,
  `src/email/logo.ts`) is the only image: an inline CID attachment returned in `RenderedEmail.attachments` and
  sent by the SMTP transport. Gmail and Outlook block SVG and `data:` images, and there is no public asset URL yet.
- Bulletproof 44px CTA button plus a copy-paste link fallback.
- Hidden preheader on every mail.
- All user data is HTML-escaped; links must be absolute `http(s)` (`safeUrl`); subjects are stripped of CR/LF.
- Copy lives in `strings.ts` (`EmailMessages`); add a locale by adding an object of the same type.
- Non-auth mail requires `preferencesUrl` (and should pass a one-click `unsubscribeUrl`). Auth/security mail has
  no unsubscribe.

## Previews

```sh
EMAIL_PREVIEW_DIR=/tmp/email-previews pnpm --filter @meetops/notifications test -- previews
```
