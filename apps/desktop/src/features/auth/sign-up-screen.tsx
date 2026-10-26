import { useState, type FormEvent } from 'react';
import { Check, Eye, EyeOff, Loader2, MailCheck } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Toast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';
import {
  AuthError,
  MAX_NAME_LENGTH,
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
} from './auth-client';
import { AuthLayout, AuthSwitch, FieldError } from './auth-layout';
import { useSession } from './session';

type Field = 'name' | 'email' | 'password' | 'confirm';
type FieldErrors = Partial<Record<Field, string>>;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const SIGN_UP_FOOTER = 'Preview build: sign-up is mocked and no server is contacted.';

/** Client-side checks that mirror contracts SignupRequest (name 1-200, email, password 12-128). */
export function validateSignUp(values: Record<Field, string>): FieldErrors {
  const errors: FieldErrors = {};
  if (!values.name.trim()) errors.name = 'Enter your name.';
  else if (values.name.length > MAX_NAME_LENGTH)
    errors.name = `Use at most ${MAX_NAME_LENGTH} characters.`;
  if (!values.email.trim()) errors.email = 'Enter your email.';
  else if (!EMAIL_RE.test(values.email.trim())) errors.email = 'Enter a valid email address.';
  if (!values.password) errors.password = 'Create a password.';
  else if (values.password.length < MIN_PASSWORD_LENGTH)
    errors.password = `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
  else if (values.password.length > MAX_PASSWORD_LENGTH)
    errors.password = `Use at most ${MAX_PASSWORD_LENGTH} characters.`;
  if (!values.confirm) errors.confirm = 'Confirm your password.';
  else if (values.confirm !== values.password) errors.confirm = 'Passwords do not match.';
  return errors;
}

export function SignUpScreen({ onSignIn }: { onSignIn: () => void }) {
  const { signUp } = useSession();
  const [values, setValues] = useState<Record<Field, string>>({
    name: '',
    email: '',
    password: '',
    confirm: '',
  });
  const [errors, setErrors] = useState<FieldErrors>({});
  const [toast, setToast] = useState<string | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  const [pending, setPending] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);

  const set = (field: Field) => (value: string) => {
    setValues((v) => ({ ...v, [field]: value }));
    if (errors[field]) setErrors((e) => ({ ...e, [field]: undefined }));
  };

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const found = validateSignUp(values);
    setErrors(found);
    if (Object.values(found).some(Boolean)) return;
    setToast(null);
    setPending(true);
    try {
      const result = await signUp({
        name: values.name.trim(),
        email: values.email.trim(),
        password: values.password,
      });
      setSentTo(result.email);
    } catch (err) {
      if (err instanceof AuthError && err.reason === 'EMAIL_TAKEN') {
        setErrors({ email: err.message });
      } else {
        setToast(err instanceof AuthError ? err.message : 'Sign-up failed. Try again.');
      }
    } finally {
      setPending(false);
    }
  }

  if (sentTo) {
    return (
      <AuthLayout footer={SIGN_UP_FOOTER}>
        <Card glow className="rounded-xl" role="status" aria-label="Check your email">
          <CardHeader className="items-center text-center">
            <span
              aria-hidden
              className="mb-2 flex size-10 items-center justify-center rounded-full bg-primary/15 text-link"
            >
              <MailCheck className="size-5" />
            </span>
            <CardTitle>Check your email</CardTitle>
            <CardDescription>
              We sent a verification link to <span className="text-foreground">{sentTo}</span>. Open
              it to activate your account, then sign in.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button type="button" className="w-full" onClick={onSignIn}>
              Back to sign in
            </Button>
          </CardContent>
        </Card>
      </AuthLayout>
    );
  }

  const describedBy = (field: Field, extra?: string) =>
    [errors[field] ? `${field}-error` : null, extra].filter(Boolean).join(' ') || undefined;
  const longEnough = values.password.length >= MIN_PASSWORD_LENGTH;
  const passwordType = showPassword ? 'text' : 'password';

  return (
    <AuthLayout footer={SIGN_UP_FOOTER}>
      <Card glow className="rounded-xl">
        <CardHeader>
          <CardTitle>Create your account</CardTitle>
          <CardDescription>Sign up with your work email and a password.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <form
            className="space-y-4"
            onSubmit={(e) => void submit(e)}
            noValidate
            aria-label="Sign up"
          >
            <div className="space-y-2">
              <Label htmlFor="signup-name">Name</Label>
              <Input
                id="signup-name"
                autoComplete="name"
                value={values.name}
                onChange={(e) => set('name')(e.target.value)}
                aria-invalid={errors.name ? true : undefined}
                aria-describedby={describedBy('name')}
                disabled={pending}
              />
              <FieldError id="name-error" message={errors.name} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="signup-email">Email</Label>
              <Input
                id="signup-email"
                type="email"
                autoComplete="email"
                value={values.email}
                onChange={(e) => set('email')(e.target.value)}
                aria-invalid={errors.email ? true : undefined}
                aria-describedby={describedBy('email')}
                disabled={pending}
              />
              <FieldError id="email-error" message={errors.email} />
            </div>
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="signup-password">Password</Label>
                <button
                  type="button"
                  onClick={() => setShowPassword((s) => !s)}
                  aria-pressed={showPassword}
                  aria-controls="signup-password signup-confirm"
                  className="inline-flex items-center gap-1 rounded-sm text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {showPassword ? (
                    <EyeOff className="size-3.5" aria-hidden />
                  ) : (
                    <Eye className="size-3.5" aria-hidden />
                  )}
                  {showPassword ? 'Hide password' : 'Show password'}
                </button>
              </div>
              <Input
                id="signup-password"
                type={passwordType}
                autoComplete="new-password"
                value={values.password}
                onChange={(e) => set('password')(e.target.value)}
                aria-invalid={errors.password ? true : undefined}
                aria-describedby={describedBy('password', 'password-hint')}
                disabled={pending}
              />
              <FieldError id="password-error" message={errors.password} />
              <p
                id="password-hint"
                className={cn(
                  'flex items-center gap-1.5 text-xs transition-colors',
                  longEnough ? 'text-link' : 'text-muted-foreground',
                )}
              >
                <Check
                  className={cn('size-3.5', longEnough ? 'opacity-100' : 'opacity-40')}
                  aria-hidden
                />
                {MIN_PASSWORD_LENGTH}+ characters
                <span className="sr-only">{longEnough ? '(met)' : '(not met yet)'}</span>
                <span className="ml-auto tabular-nums" aria-hidden>
                  {Math.min(values.password.length, MIN_PASSWORD_LENGTH)}/{MIN_PASSWORD_LENGTH}
                </span>
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="signup-confirm">Confirm password</Label>
              <Input
                id="signup-confirm"
                type={passwordType}
                autoComplete="new-password"
                value={values.confirm}
                onChange={(e) => set('confirm')(e.target.value)}
                aria-invalid={errors.confirm ? true : undefined}
                aria-describedby={describedBy('confirm')}
                disabled={pending}
              />
              <FieldError id="confirm-error" message={errors.confirm} />
            </div>
            <Button type="submit" className="w-full" disabled={pending}>
              {pending ? <Loader2 className="motion-safe:animate-spin" aria-hidden /> : null}
              {pending ? 'Creating account…' : 'Create account'}
            </Button>
          </form>
          <AuthSwitch prompt="Already have an account?" action="Sign in" onClick={onSignIn} />
        </CardContent>
      </Card>
      <Toast message={toast} onDismiss={() => setToast(null)} />
    </AuthLayout>
  );
}
