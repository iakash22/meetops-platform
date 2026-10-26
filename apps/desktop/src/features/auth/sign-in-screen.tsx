import { useState, type FormEvent } from 'react';
import { ExternalLink, Loader2 } from 'lucide-react';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { AuthError } from './auth-client';
import { AuthLayout, AuthSwitch } from './auth-layout';
import { useSession } from './session';

export const SIGN_IN_FOOTER = 'Preview build: sign-in is mocked and no server is contacted.';

export const BROWSER_SIGN_IN_PENDING =
  'Browser sign-in (ADR-012) is not available yet. It will open your default browser once the decision is signed off.';

interface SignInScreenProps {
  onCreateAccount?: () => void;
  /** Show the mocked email/password preview form. Off in production builds (see isMockAuthEnabled). */
  mockAuth?: boolean;
}

export function SignInScreen({ onCreateAccount, mockAuth = false }: SignInScreenProps) {
  // `import.meta.env.DEV` first so production builds drop the mock form entirely.
  const showMock = import.meta.env.DEV && mockAuth;
  const { signIn } = useSession();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!email.trim() || !password) {
      setError('Enter your email and password.');
      return;
    }
    setError(null);
    setPending(true);
    try {
      await signIn({ email, password });
    } catch (err) {
      setError(err instanceof AuthError ? err.message : 'Sign-in failed. Try again.');
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
            variant="outline"
            className="h-11 w-full"
            disabled
            aria-describedby="browser-sign-in-note"
          >
            <ExternalLink aria-hidden />
            Sign in with your browser
          </Button>
          <p id="browser-sign-in-note" className="text-xs text-muted-foreground">
            {BROWSER_SIGN_IN_PENDING}
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
                  aria-invalid={error ? true : undefined}
                  disabled={pending}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="password">Password</Label>
                <Input
                  id="password"
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  aria-invalid={error ? true : undefined}
                  disabled={pending}
                />
              </div>
              {error ? <Alert variant="destructive">{error}</Alert> : null}
              <Button type="submit" className="h-11 w-full" disabled={pending}>
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
    </AuthLayout>
  );
}
