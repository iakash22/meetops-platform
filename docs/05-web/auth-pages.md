# Auth pages (login, signup, forgot, reset, verify) and error handling

Status: implemented in `apps/web/src/features/auth/**` (branch `feat/web-auth-brand`).
Source spec: auth UI research, 25 Oct 2026. Section 1 is copied as-is. Section 2 describes what
was built and Section 4 lists where we chose to differ from the spec.

## 1. References

- [Supabase: Sign in](https://supabase.com/dashboard/sign-in): the split-screen layout to copy. The form column sits on the left (SSO buttons → "or" divider → email + password with a **show/hide eye** and an inline "Forgot password?" next to the label). The right panel is a large customer-quote testimonial with an avatar, and the legal line is pinned at the bottom.
- [Resend: Log in](https://resend.com/login): a dark, centered, minimal layout with moody ambient art bleeding in from the corners. This is the closest match to our BrandBackground glow idea. It has a single email field, a CTA that stays disabled until input is valid, a top-left "‹ Home" link, and the Terms line under the CTA.
- [Vercel: Log in](https://vercel.com/login): the email-first pattern. The email field and a "Continue with Email" primary button sit on top, other methods are stacked below a divider, extra options hide behind "Show other options", and a Sign Up pill sits top-right. Pure black background with high contrast.
- [Linear: Log in](https://linear.app/login) / [Sign up](https://linear.app/signup): very restrained. It's a narrow 280px column, a logo mark, one headline, pill buttons, and a subtle vertical dark gradient. Good reference for type scale and spacing discipline on a near-black background.
- [Cal.com: Sign up](https://app.cal.com/signup): the best "signup sells the product" panel. The right side shows a framed product UI preview, award/rating badges, and three value props with icons. The left side is a short form with a "Free for individuals" subline. "Already have an account? Sign in" is pinned bottom-left.
- [shadcn/ui Blocks: login-01…05](https://ui.shadcn.com/blocks/login) & [signup blocks](https://ui.shadcn.com/blocks/signup): the code base to start from, in our exact stack. `login-02` is the two-column layout with a cover panel (`grid lg:grid-cols-2`, panel `hidden lg:block`). `login-04` is a card with a form plus an image inside one `md:max-w-4xl` card. Install with `npx shadcn add login-02`.
- [Watermelon UI: Login Page 1 (auth-01)](https://ui.watermelon.sh/block/auth-01): free shadcn-registry auth blocks (auth-01…13, sign in / sign up / reset) plus [Form components](https://ui.watermelon.sh/components/form) wired with react-hook-form + zod + sonner. Useful for validation and toast patterns. Install: `npx shadcn@latest add https://registry.watermelon.sh/r/auth-01.json`.
- [21st.dev: Sign-in components](https://21st.dev/s/sign-in) (also [/s/sign-up](https://21st.dev/s/sign-up)): about 80 community shadcn sign-in components, e.g. "Sign In Split Screen", "Modern Animated Sign In", "Magic Link and OTP Code Login Form", "Identifier First Login", "Auth Divider". Good for borrowing micro-interactions. Every one installs through the shadcn CLI.
- [Aceternity UI: Signup Form](https://ui.aceternity.com/components/signup-form): a shadcn input + label with framer-motion. Inputs get a **cursor-following radial glow on hover/focus**, and the CTA has a gradient underline that appears on hover. This is the "focus glow" interaction to copy with cerulean. Install: `npx shadcn@latest add @aceternity/signup-form-demo`.
- [Mobbin: Web login screens](https://mobbin.com/explore/web/screens/login) (+ [Logging-in flows](https://mobbin.com/explore/web/flows/logging-in)): more than 1,100 real login screens, including error states, verification, and SSO (Notion, Slack, ElevenLabs, Runway, Neon, Better Stack magic-link). Use it to benchmark error and "check your email" states. Some content is behind a free login.

Also useful:

- [Page Flows: web signing-up flows](https://pageflows.com/web/flows/signing-up/) and [logging-in flows](https://pageflows.com/web/flows/logging-in/): full video recordings of flows.
- [Tailwind Plus sign-in forms](https://tailwindcss.com/plus/ui-blocks/application-ui/forms/sign-in-forms): split-screen and card variants.
- [Magic UI Shimmer Button](https://www.magicui.design/docs/components/shimmer-button) / [Border Beam](https://www.magicui.design/docs/components/border-beam): CTA shimmer and an animated card border.
- [Animate UI components](https://animate-ui.com/docs/components): ripple/liquid buttons, shimmering text, and an animated `input-otp`.

Dropped or not used:

- raycast.com/login returns a 404, so I dropped it.
- land-book.com/design/login returns a 404. Land-book has no public login category URL; the `?category=` URL just returns the homepage.
- Clerk sign-in timed out in headless Chrome. It's live (200), but I couldn't visually verify it, so it isn't in the list.

## 2. What the API supports

- **Email and password only.** There is no OAuth, SSO, magic-link or passkey, so the UI shows no
  SSO buttons and no "or" divider. `forms.tsx` keeps a commented `<SocialAuth/>` slot.
- **Password rules.** Signup and reset require 12–128 characters. Login only checks that the
  password is non-empty, so the policy isn't revealed.
- **Enumeration-safe endpoints.** Signup, forgot-password and resend-verification are
  enumeration-safe (202), so each one ends on a "Check your inbox" state.
- **CSRF.** The API client fetches `/auth/csrf`. On `CSRF_INVALID` it refetches and retries once.
  If the retry also fails, the UI shows the toast "Session expired, please try again".

## 3. Design (as built)

### Layout: `AuthLayout` (`auth-layout.tsx`)

All auth and public pages share this layout: login, signup, forgot, reset, verify, resend and
invitation.

- **Split grid.** `grid min-h-svh lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]`. At 1440px the
  brand panel fills the right side, so the form no longer looks like a small card on an empty
  page.
- **Form column.**
  - Top-left: the MeetOps mark and wordmark (`logo.tsx`). This is an inline SVG with
    `aria-hidden`; the link's accessible name is "MeetOps AI home".
  - Top-right: a "Sign in" link on /signup and a "Sign up" link on /login.
  - The form block is `max-w-[26rem]`, vertically centred.
  - Entrance animation is fade + rise, applied with the `motion-safe:` prefix.
- **Brand panel.** `<aside aria-label="About MeetOps AI">`, `hidden lg:flex`.
  - Background: `BrandBackground` (hero variant on signup).
  - Headline "Every meeting, turned into action." at `text-display` (36→60px).
  - On signup only, a `SpotlightCard` with a mock summary and 3 drafted tasks. It is labelled
    "Example summary" and contains no live data.
  - Value props: Record & transcribe · AI summaries · Draft tasks from action items.
  - A testimonial slot that renders nothing until a real quote exists (TODO).
  - Login uses the same shell with a quieter panel: headline and value props only.
- **Mobile (< lg).** A subtle glow, a one-line value prop under the logo, full-width form.

### Forms

- **Headings.**
  - One `<h1>` per page: `text-h1` (30→36px, 600, −0.02em) from the typography scale.
  - Login: "Welcome back" / "Log in to MeetOps AI".
  - Signup: "Create your workspace" / "Start turning meetings into action".
- **Field order.**
  - Login: Email → Password (with "Forgot password?" in the label row) → "Log in".
  - Signup: Full name → Work email → Password with strength meter → "Create account". This is
    the only shimmer CTA in the app's auth pages.
  - Signup has no confirm-password field.
- **Password toggle** (`PasswordField`).
  - An icon button with `type="button"`, `aria-label` "Show password" / "Hide password",
    `aria-pressed` and `aria-controls`.
  - Clicking it doesn't take focus from the input (mousedown is prevented).
- **Strength meter** (signup and reset).
  - 4 segments and an "At least 12 characters" checklist row.
  - The label is announced with `aria-live="polite"` ("Strength: Weak" and so on).
  - Never uses rose.
- **Validation.** react-hook-form + zod with `mode: "onTouched"`. Contract-matching schemas.
  On submit, focus moves to the first invalid field.
- **Form markup.**
  - Forms use `<form method="post" noValidate>`.
  - Fields have `name` and `autocomplete` set: name, username / email, current-password /
    new-password.
  - Email inputs use `inputMode="email"` with autocapitalise and spellcheck off.
- **Sizing and focus.**
  - Inputs and buttons are `h-11` (44px) and inputs use 16px text.
  - Focus glow on inputs: `border-primary ring-4 ring-primary/20` plus a cerulean shadow.
- **Submit button.** While submitting it is disabled, has `aria-busy` and shows a spinner and a
  "…ing" label.
- **Links.** `text-link`, underlined on hover, with a visible focus ring and a 44px minimum
  height.

### "Check your inbox" (`check-email.tsx`)

- Replaces the form in place.
- The container has `role="status"`, and focus moves to its heading.
- Copy is enumeration-safe: "If {email} can receive it, we sent a link…".
- Buttons: "Open Gmail" and "Open Outlook".
- "Didn't get it? Resend" has a 60-second cooldown.
- "Use a different email" goes back to the form with the fields still filled in.

## 3a. Error handling (app-wide rule)

**Errors tied to a field are shown under that field. Every other error is a toast.**

| Error                                                                      | Where              | How                                                                                                                           |
| -------------------------------------------------------------------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `VALIDATION_FAILED` / `BAD_REQUEST` with `details` mapped to a field       | Under the field    | `applyFieldErrors(setError, err, { email: 'email', … })`: sets `aria-invalid` and `aria-describedby`, focuses the first field |
| `AUTH_FAILED` (login)                                                      | Under **password** | Keep the email, clear the password, focus it: "Email or password is incorrect."                                               |
| Network / 5xx                                                              | Toast              | "Can't reach MeetOps right now" · "Check your connection and try again."                                                      |
| `CSRF_INVALID` after the client's single retry                             | Toast              | "Session expired, please try again"                                                                                           |
| `RATE_LIMITED` (429)                                                       | Toast              | "Too many attempts" plus the server message                                                                                   |
| `UNAUTHENTICATED`                                                          | Toast              | "Your session has ended"                                                                                                      |
| Anything else                                                              | Toast              | "Something went wrong" plus `describeError(err)`                                                                              |
| Link problems (expired or invalid token on verify, reset or invite)        | Inline panel       | Shows the problem and the next step (resend or request a new link)                                                            |
| Success (email verified, password changed, email re-sent, member invited…) | Toast              | `notify.success(...)`                                                                                                         |

Helpers live in `apps/web/src/lib/errors/notify.ts`:

- `notify.success` / `notify.info` / `notify.error`
- `toastError(err, { title? })`
- `applyFieldErrors(setError, err, fieldMap)`, which returns `true` if it handled the error

Use them on every screen, not only auth. Never put a raw `err.message` in the UI without
`describeError`.

- Error toasts use `role="alert"` and stay for at least 8 seconds. Success toasts use
  `role="status"`.
- Inline error text is `#F87171`, which is 6.65:1 on the `#141416` card and passes AA 4.5:1.
  The stronger `#EF4444` (`--destructive`, 4.89:1) is kept for invalid borders, icons and meter
  segments.

## 4. Deviations from the spec and follow-ups

- **No SSO, testimonials, logos, ratings, security claims or "14-day trial".** None of these
  exist yet, so nothing is invented. The testimonial slot renders nothing (TODO).
- **No Terms/Privacy line.** There are no legal pages yet (`TODO(legal)` in `auth-layout.tsx`).
- **Login CTA uses the default cerulean button instead of a `highlight` variant.** This lane
  doesn't touch `components/ui`.
- **No amber token.** Strength score 2 ("Weak") uses `bg-destructive/60`. Follow-up: add a
  warning token.
- **No light-red text token.** `#F87171` lives in `authErrorTextClass` (`features/auth/styles.ts`).
  Follow-up: add a `--destructive-foreground-text` token to the theme.
- **No logo asset in the repo.** The inline SVG mark in `logo.tsx` is a placeholder until design
  ships the final asset.
- **Rate limiting.** There is no `Retry-After` countdown on the CTA; a 429 shows a toast.
- **Toasts.** The toast "Retry" action and swipe-to-dismiss arrive with the sonner swap
  (`feat/web-sonner-toast`, waiting for the lockfile slot).
- **CSRF.** There is no separate CSRF prefetch call; the client fetches the token lazily and
  retries once.
