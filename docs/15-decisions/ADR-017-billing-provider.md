# ADR-017: Billing provider

- Status: **Accepted — approved by owner Maddy, 2026-11-01**
- Date: 2026-11-01
- Owner: Architecture (All Rounder Techy); frontend by the Coordinator
- Related: [ADR-002](./ADR-002-provider-interfaces.md), [ADR-016](./ADR-016-secret-manager-kms.md), `docs/12-security/rbac-matrix.md`, `docs/12-security/multi-tenant-isolation.md`

## Context

There is no billing ADR, plan or code (`docs/plans/phase-9-notes.md`: "Billing: no ADR, plan or product decision
exists"). The owner is in India and needs INR billing that follows RBI rules. Stripe has been invite-only for Indian
businesses since May 2024, and its India relaunch is on indefinite hold. `rbac-matrix.md` lets only the owner manage
billing (admin is read-only), and `multi-tenant-isolation.md` requires cross-org billing jobs to use a separate audited
`BYPASSRLS` role.

Options considered (prices checked 2026-11-01): Razorpay Subscriptions (domestic 2%, +0.9% on card subscriptions,
international cards up to 3%, 18% GST on fees, settles in INR); Paddle as merchant of record (5% + $0.50, USD payouts
only); Dodo Payments as merchant of record (4% + 40¢ base plus surcharges).

## Decision

1. Use **Razorpay Subscriptions**, behind a provider-agnostic `BillingProvider` interface (ADR-002 style), so Paddle or
   another merchant of record can be added later without touching domain code.
2. Prices are in INR. Payment methods are UPI AutoPay, e-mandate, domestic cards and eligible international recurring
   cards.
3. RBI e-mandate rules: extra authentication happens at mandate setup and on the first charge. Recurring debits up to
   ₹15,000 need no extra step, and the bank sends a pre-debit alert at least 24 h before each charge. Keep each recurring
   charge at or under ₹15,000; annual and large plans are billed by invoice or payment link.
4. Webhooks are verified with the `X-Razorpay-Signature` HMAC, using a timestamp/replay window, and stored once in an
   idempotent `billing_events` table with org RLS. Unverified or duplicate events change nothing.
5. Entitlements are a `can(plan, feature)` check on API routes and worker jobs (seats, recording minutes via
   `AiUsageCounter`, storage, integrations). An unknown plan is denied by default.
6. Only the org owner manages billing; admins can read it (`rbac-matrix.md`). No card data is stored by MeetOps.
7. Add Paddle behind the same interface if overseas B2C sales or US sales-tax nexus start to matter.

## Consequences

- Unblocks P9 billing items: webhook verifier and event store, entitlements, provider account and keys (on
  `integration/phase-1` these are `docs/p9/remaining-work.md` #5–#8).
- The owner completes Razorpay KYC, GSTIN and an LUT for zero-rated export invoices. Test/live keys and the webhook secret
  live in the secret manager (ADR-016), never in the repo.
- Card and UPI mandates cannot be moved to another provider; a later migration means customers re-authorise.
- MeetOps handles GST invoicing and any foreign indirect tax itself while on Razorpay.
