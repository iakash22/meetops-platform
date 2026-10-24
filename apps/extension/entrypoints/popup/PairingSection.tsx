import { useCallback, useEffect, useState } from 'react';
import type { AuthRequest, AuthResponse, AuthStatus } from '../../src/lib/auth/messages.js';

const send = (msg: AuthRequest): Promise<AuthResponse> =>
  chrome.runtime.sendMessage<AuthRequest, AuthResponse>(msg);

const REASONS: Record<NonNullable<AuthStatus['reason']>, string> = {
  unauthorized: 'Your session was rejected.',
  refresh_rejected: 'Your sign-in was revoked.',
  org_switch: 'You switched organization.',
  expired: 'Your pairing expired.',
};

/** ADR-005 pairing state: Pair (user gesture) / pairing in progress / paired (Unpair) / re-pair required. */
export function PairingSection() {
  const [auth, setAuth] = useState<AuthStatus>({ state: 'unpaired' });
  const [error, setError] = useState('');

  const apply = useCallback((res: AuthResponse) => {
    if (res.ok) {
      setAuth({
        state: res.state,
        ...(res.organizationId !== undefined && { organizationId: res.organizationId }),
        ...(res.expiresAt !== undefined && { expiresAt: res.expiresAt }),
        ...(res.reason !== undefined && { reason: res.reason }),
      });
      setError('');
    } else setError(res.error);
  }, []);

  const run = useCallback(
    (msg: AuthRequest) =>
      send(msg).then(apply, (e: unknown) => setError(e instanceof Error ? e.message : String(e))),
    [apply],
  );

  useEffect(() => {
    void run({ target: 'background', type: 'AUTH_STATUS' });
    const t = setInterval(() => void run({ target: 'background', type: 'AUTH_STATUS' }), 2000);
    return () => clearInterval(t);
  }, [run]);

  // Pairing starts only from this click (ADR-005 A1.1.1).
  const onPair = () => void run({ target: 'background', type: 'AUTH_PAIR' });
  const onUnpair = () => void run({ target: 'background', type: 'AUTH_UNPAIR' });

  return (
    <section aria-label="Account pairing">
      {auth.state === 'paired' ? (
        <>
          <p>Paired with your organization.</p>
          <button type="button" onClick={onUnpair}>
            Unpair
          </button>
        </>
      ) : auth.state === 'pairing' ? (
        <>
          <p>Confirm the pairing in the MeetOps tab that just opened.</p>
          <button type="button" onClick={onPair}>
            Restart pairing
          </button>
        </>
      ) : (
        <>
          <p>
            {auth.state === 'repair_required' && auth.reason
              ? `${REASONS[auth.reason]} Pair again to continue.`
              : 'Not paired.'}
          </p>
          <button type="button" onClick={onPair}>
            {auth.state === 'repair_required' ? 'Pair again' : 'Pair with MeetOps'}
          </button>
        </>
      )}
      {error && <p role="alert">Pairing error: {error}</p>}
    </section>
  );
}
