import { useState, type FormEvent } from 'react';
import { Loader2 } from 'lucide-react';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { AuthError } from './auth-client';
import { AuthLayout, AuthSwitch } from './auth-layout';
import { useSession } from './session';

export const SIGN_IN_FOOTER = 'Preview build: sign-in is mocked and no server is contacted.';

export function SignInScreen({ onCreateAccount }: { onCreateAccount?: () => void }) {
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
    <AuthLayout footer={SIGN_IN_FOOTER}>
      <Card glow className="rounded-xl">
        <CardHeader>
          <CardTitle>Sign in</CardTitle>
          <CardDescription>Use your MeetOps account to continue.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
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
            <Button type="submit" className="w-full" disabled={pending}>
              {pending ? <Loader2 className="animate-spin" aria-hidden /> : null}
              {pending ? 'Signing in…' : 'Sign in'}
            </Button>
          </form>
          {onCreateAccount ? (
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
