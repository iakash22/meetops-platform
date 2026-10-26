import { useState, type FormEvent } from 'react';
import { ExternalLink, Loader2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Toast } from '@/components/ui/toast';
import { AuthError } from './auth-client';
import { AuthLayout, AuthSwitch, FieldError } from './auth-layout';
import { useSession } from './session';

export const SIGN_IN_FOOTER = 'Preview build: sign-in is mocked and no server is contacted.';

export const BROWSER_SIGN_IN_PENDING =
  'Browser sign-in (ADR-012) is not available yet. It will open your default browser once the decision is signed off.';

export const BROWSER_SIGN_IN_HINT =
  'Opens your default browser. Sign in there and confirm this device; your password never enters the app.';

interface SignInScreenProps {
  onCreateAccount?: () => void;
  /** Show the mocked email/password preview form. Off in production builds (see isMockAuthEnabled). */
  mockAuth?: boolean;
}

export function SignInScreen({ onCreateAccount, mockAuth = false }: SignInScreenProps) {
  // `import.meta.env.DEV` first so production builds drop the mock form entirely.
  const showMock = import.meta.env.DEV && mockAuth;
  const { signIn, signInWithBrowser } = useSession();
  const [browserPending, setBrowserPending] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  async function browserSignIn() {
    if (!signInWithBrowser) return;
    setToast(null);
    setBrowserPending(true);
    try {
      await signInWithBrowser();
    } catch (err) {
      setToast(err instanceof AuthError ? err.message : 'Sign-in failed. Try again.');
      setBrowserPending(false);
    }
  }
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [fieldErrors, setFieldErrors] = useState<{ email?: string; password?: string }>({});
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const found: { email?: string; password?: string } = {};
    if (!email.trim()) found.email = 'Enter your email.';
    if (!password) found.password = 'Enter your password.';
    setFieldErrors(found);
    if (found.email || found.password) {
      document.getElementById(found.email ? 'email' : 'password')?.focus();
      return;
    }
    setToast(null);
    setPending(true);
    try {
      await signIn({ email, password });
    } catch (err) {
      // Non-field error (e.g. invalid credentials): toast, per docs/references.md.
      setToast(err instanceof AuthError ? err.message : 'Sign-in failed. Try again.');
      setPending(false);
    }
  }

  return (
    <AuthLayout footer={showMock ? SIGN_IN_FOOTER : undefined}>
      <Card glow className="rounded-xl">
        <CardHeader>
          <CardTitle>Sign in</CardTitle>
          <CardDescription>Use your MeetOps account to continue.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* ADR-012 Option A: the desktop app never collects a password in production; it hands off to the
              system browser (PKCE + loopback). Disabled until the ADR is signed off, so no auth is faked. */}
          <Button
            type="button"
            variant={signInWithBrowser ? 'default' : 'outline'}
            className="h-11 w-full"
            disabled={!signInWithBrowser || browserPending}
            aria-describedby="browser-sign-in-note"
            onClick={() => void browserSignIn()}
          >
            {browserPending ? (
              <Loader2 className="motion-safe:animate-spin" aria-hidden />
            ) : (
              <ExternalLink aria-hidden />
            )}
            {browserPending ? 'Waiting for your browser…' : 'Sign in with your browser'}
          </Button>
          <p id="browser-sign-in-note" className="text-xs text-muted-foreground">
            {signInWithBrowser ? BROWSER_SIGN_IN_HINT : BROWSER_SIGN_IN_PENDING}
          </p>
          {showMock ? (
            <form
              className="space-y-4"
              onSubmit={(e) => void submit(e)}
              noValidate
              aria-label="Sign in"
            >
              <div className="space-y-2">
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  type="email"
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  aria-invalid={fieldErrors.email ? true : undefined}
                  aria-describedby={fieldErrors.email ? 'email-error' : undefined}
                  disabled={pending}
                />
                <FieldError id="email-error" message={fieldErrors.email} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="password">Password</Label>
                <Input
                  id="password"
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  aria-invalid={fieldErrors.password ? true : undefined}
                  aria-describedby={fieldErrors.password ? 'password-error' : undefined}
                  disabled={pending}
                />
                <FieldError id="password-error" message={fieldErrors.password} />
              </div>
              <Button type="submit" className="h-11 w-full" disabled={pending} aria-busy={pending}>
                {pending ? <Loader2 className="motion-safe:animate-spin" aria-hidden /> : null}
                {pending ? 'Signing in…' : 'Sign in'}
              </Button>
            </form>
          ) : null}
          {showMock && onCreateAccount ? (
            <AuthSwitch
              prompt="New to MeetOps?"
              action="Create an account"
              onClick={onCreateAccount}
            />
          ) : null}
        </CardContent>
      </Card>
      <Toast message={toast} onDismiss={() => setToast(null)} />
    </AuthLayout>
  );
}
