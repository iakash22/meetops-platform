import { createContext, useContext, type ReactNode } from 'react';

import type { ApiClient, SignupAccepted } from '../api/client';

/** The one API call the sign-up screen needs: `POST /auth/signup` from the typed API client. */
export type SignupApi = Pick<ApiClient, 'signup'>;

const SignupApiContext = createContext<SignupApi | null>(null);

export function SignupApiProvider({ value, children }: { value: SignupApi; children: ReactNode }) {
  return <SignupApiContext.Provider value={value}>{children}</SignupApiContext.Provider>;
}

export function useSignupApi(): SignupApi {
  const api = useContext(SignupApiContext);
  if (!api) throw new Error('useSignupApi must be used inside <SignupApiProvider>.');
  return api;
}

/**
 * Demo-mode stand-in with the same signature as `ApiClient.signup`. Nothing leaves the device. Like the real
 * route it always "accepts" (enumeration-safe 202) and never starts a session.
 */
export function createDemoSignupApi({ latencyMs = 0 }: { latencyMs?: number } = {}): SignupApi {
  return {
    async signup(): Promise<SignupAccepted> {
      if (latencyMs > 0) await new Promise((r) => setTimeout(r, latencyMs));
      return { message: 'Check your email to verify your account.' };
    },
  };
}
