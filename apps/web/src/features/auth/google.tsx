import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { authButtonClass } from './styles';

/** Fixed copy. The API never puts Google's error text or the user's email in the URL. */
export const GOOGLE_LOGIN_ERRORS = {
  google: {
    title: "Google sign-in didn't complete",
    description: 'Try again, or use your password.',
  },
  google_unverified: {
    title: 'This email already has an account',
    description: 'Sign in with your password and verify your email, then try Google again.',
  },
  google_link_password: {
    title: 'Confirm it is your account',
    description:
      'This email already has a MeetOps account. Sign in with your password once to link Google.',
  },
} as const;

export type GoogleLoginError = keyof typeof GOOGLE_LOGIN_ERRORS;

export function isGoogleLoginError(value: string): value is GoogleLoginError {
  return value in GOOGLE_LOGIN_ERRORS;
}

/** Full-page navigation to the API. The API sets the PKCE cookie and redirects to Google. */
export function googleStartUrl(apiBase: string, next: string | undefined): string {
  const base = apiBase.replace(/\/$/, '');
  const params = new URLSearchParams();
  if (next && next !== '/') params.set('next', next);
  const query = params.toString();
  return `${base}/auth/google/start${query ? `?${query}` : ''}`;
}

function GoogleMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden focusable="false">
      <path
        fill="#4285F4"
        d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844a4.14 4.14 0 0 1-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.615z"
      />
      <path
        fill="#34A853"
        d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z"
      />
      <path
        fill="#FBBC05"
        d="M3.964 10.71A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.042l3.007-2.332z"
      />
      <path
        fill="#EA4335"
        d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58z"
      />
    </svg>
  );
}

/** Shown only when GET /auth/providers reports google. The password form stays either way. */
export function GoogleContinue({ href }: { href: string }) {
  return (
    <div className="grid gap-3">
      <a href={href} className={cn(buttonVariants({ variant: 'outline' }), authButtonClass)}>
        <GoogleMark />
        Continue with Google
      </a>
      <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-3 text-xs uppercase tracking-wide text-muted-foreground">
        <span className="border-t border-border" aria-hidden />
        or
        <span className="border-t border-border" aria-hidden />
      </div>
    </div>
  );
}
