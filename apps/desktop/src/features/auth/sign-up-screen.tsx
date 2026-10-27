import { useState, type FormEvent } from 'react';

export type PasswordStrength = 'too-short' | 'weak' | 'fair' | 'strong';

/** Advisory meter (docs/references.md section 5); only length 12..128 is enforced. */
export function passwordStrength(password: string, min = 12): PasswordStrength {
  if (password.length < min) return 'too-short';
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(password)).length;
  const score = classes + (password.length >= 16 ? 1 : 0) + (password.length >= 20 ? 1 : 0);
  return score >= 4 ? 'strong' : score >= 2 ? 'fair' : 'weak';
}

const STRENGTH: Record<PasswordStrength, { label: string; bars: number; bar: string }> = {
  'too-short': { label: 'Too short', bars: 0, bar: 'bg-border' },
  weak: { label: 'Weak', bars: 1, bar: 'bg-destructive' },
  fair: { label: 'Fair', bars: 2, bar: 'bg-amber-500' },
  strong: { label: 'Strong', bars: 3, bar: 'bg-primary' },
};
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

type Field = 'name' | 'email' | 'password';
const FIELD_ORDER: Field[] = ['name', 'email', 'password'];
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
  return errors;
}

export function SignUpScreen({ onSignIn }: { onSignIn: () => void }) {
  const { signUp } = useSession();
  const [values, setValues] = useState<Record<Field, string>>({
    name: '',
    email: '',
    password: '',
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
    const first = FIELD_ORDER.find((f) => found[f]);
    if (first) {
      document.getElementById(`signup-${first}`)?.focus();
      return;
    }
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
      // Enumeration-safe: an existing email ends on the same "Check your email" state.
      if (err instanceof AuthError && err.reason === 'EMAIL_TAKEN') {
        setSentTo(values.email.trim());
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
  const strength = passwordStrength(values.password, MIN_PASSWORD_LENGTH);

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
                  aria-controls="signup-password"
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
              <div
                className="flex items-center gap-1.5"
                role="img"
                aria-label={`Password strength: ${STRENGTH[strength].label}`}
                data-testid="signup-strength"
              >
                {[0, 1, 2].map((i) => (
                  <span
                    key={i}
                    aria-hidden
                    className={cn(
                      'h-1 flex-1 rounded-full',
                      i < STRENGTH[strength].bars ? STRENGTH[strength].bar : 'bg-border',
                    )}
                  />
                ))}
                <span className="ml-2 min-w-16 text-xs text-muted-foreground" aria-hidden>
                  {STRENGTH[strength].label}
                </span>
              </div>
            </div>
            <Button type="submit" className="w-full" disabled={pending} aria-busy={pending}>
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
