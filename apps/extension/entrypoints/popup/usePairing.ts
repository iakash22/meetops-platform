import { useCallback, useEffect, useState } from 'react';
import type { AuthRequest, AuthResponse, AuthStatus } from '../../src/lib/auth/messages.js';

const send = (msg: AuthRequest): Promise<AuthResponse> =>
  chrome.runtime.sendMessage<AuthRequest, AuthResponse>(msg);

/** Pairing state from the background (ADR-005). `auth` is undefined until the first AUTH_STATUS reply. */
export function usePairing() {
  const [auth, setAuth] = useState<AuthStatus>();
  const [error, setError] = useState('');

  const apply = useCallback((res: AuthResponse | undefined) => {
    if (!res) return;
    if (res.ok) {
      setAuth({
        state: res.state,
        ...(res.organizationId !== undefined && { organizationId: res.organizationId }),
        ...(res.expiresAt !== undefined && { expiresAt: res.expiresAt }),
        ...(res.reason !== undefined && { reason: res.reason }),
      });
      setError('');
    } else setError(`Pairing error: ${res.error}`);
  }, []);

  const run = useCallback(
    (msg: AuthRequest) =>
      send(msg).then(apply, (e: unknown) =>
        setError(`Pairing error: ${e instanceof Error ? e.message : String(e)}`),
      ),
    [apply],
  );

  useEffect(() => {
    void run({ target: 'background', type: 'AUTH_STATUS' });
    const t = setInterval(() => void run({ target: 'background', type: 'AUTH_STATUS' }), 2000);
    return () => clearInterval(t);
  }, [run]);

  return {
    auth,
    /** Raw error text; the popup maps it through popupErrorMessage before showing it. */
    error,
    // Pairing starts only from this click (ADR-005 A1.1.1).
    onPair: () => void run({ target: 'background', type: 'AUTH_PAIR' }),
    onUnpair: () => void run({ target: 'background', type: 'AUTH_UNPAIR' }),
  };
}
