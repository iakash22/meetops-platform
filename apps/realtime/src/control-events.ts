/**
 * LOCAL SHIM of the @meetops/contracts 0.4.1 realtime control-event names (ARC-2,
 * feat/contracts-v0.4.1-consent-realtime @ 8973ed5). They are not on integration/phase-1 yet. The names and shapes
 * below match ARC-2 exactly; once 0.4.1 lands, replace this file with imports from '@meetops/contracts' (MR-1
 * follow-up) and drop ControlServerToClientEvents, because contracts' ServerToClientEvents then includes them.
 */
export const REALTIME_CONTROL_EVENTS = {
  sessionRevoked: 'session:revoked',
  orgAccessChanged: 'org:access-changed',
  authReauthRequired: 'auth:reauth-required',
} as const;

/** `auth:reauth-required` reasons (ARC-2 REAUTH_REASONS). */
export const REAUTH_REASONS = ['org_switch', 'session_expired', 'revalidation_failed'] as const;
export type ReauthReason = (typeof REAUTH_REASONS)[number];

/** ARC-2 AuthReauthRequiredEvent: `{ reason, at }`, strict, no ids or credentials. */
export type AuthReauthRequiredEvent = { reason: ReauthReason; at: string };

/** The control events this server emits today: session expiry, and failed periodic / revocation-driven re-verification. */
export interface ControlServerToClientEvents {
  'auth:reauth-required': (e: AuthReauthRequiredEvent) => void;
}
