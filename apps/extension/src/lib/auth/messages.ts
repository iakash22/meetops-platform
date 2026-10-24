/** popup -> background messages for pairing (ADR-005). Handled only when the sender is the extension popup. */
export type AuthRequest =
  | { target: 'background'; type: 'AUTH_STATUS' }
  /** Must be sent from a click handler in the popup (ADR-005 A1.1.1). */
  | { target: 'background'; type: 'AUTH_PAIR' }
  | { target: 'background'; type: 'AUTH_UNPAIR' };

export type RepairReason = 'unauthorized' | 'refresh_rejected' | 'org_switch' | 'expired';

export interface AuthStatus {
  state: 'unpaired' | 'pairing' | 'paired' | 'repair_required';
  organizationId?: string;
  /** Epoch ms of the access token expiry. Never the token itself. */
  expiresAt?: number;
  reason?: RepairReason;
}

export type AuthResponse = ({ ok: true } & AuthStatus) | { ok: false; error: string };

export function isAuthRequest(msg: unknown): msg is AuthRequest {
  if (typeof msg !== 'object' || msg === null) return false;
  const m = msg as Record<string, unknown>;
  return (
    m.target === 'background' &&
    (m.type === 'AUTH_STATUS' || m.type === 'AUTH_PAIR' || m.type === 'AUTH_UNPAIR')
  );
}
