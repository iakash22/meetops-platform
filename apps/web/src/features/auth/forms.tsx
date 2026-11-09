import { useState, type ReactNode } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Link } from '@tanstack/react-router';
import { PASSWORD_POLICY_MESSAGE } from '@meetops/contracts/types';
import { ApiError } from '@/lib/api/client';
import { cn } from '@/lib/utils';
import { applyFieldErrors, toastError } from '@/lib/errors/notify';
import { CheckEmail } from './check-email';
import { Field } from './field';
import { PasswordField } from './password';
import {
  forgotPasswordSchema,
  loginSchema,
  signupSchema,
  type ForgotPasswordValues,
  type LoginValues,
  type SignupValues,
} from './schemas';
import { GoogleContinue } from './google';
import { authLinkClass } from './styles';
import { SubmitButton } from './submit-button';

type SubmitHandler<T> = (values: T) => Promise<void> | void;

/** Email input attributes shared by every auth form. */
export const emailInputProps = {
  type: 'email',
  inputMode: 'email',
  autoCapitalize: 'none',
  autoCorrect: 'off',
  spellCheck: false,
  placeholder: 'you@company.com',
} as const;

/** Title block + body + footer for one auth page. The page's only h1 lives here. */
export function AuthCard({
  title,
  description,
  children,
  footer,
}: {
  title: string;
  description: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <section className="grid gap-6">
      <header className="grid gap-2">
        <h1 className="text-h1">{title}</h1>
        <p className="text-base text-muted-foreground">{description}</p>
      </header>
      {children}
      {footer ? (
        <footer className="flex flex-col items-center gap-0 text-sm text-muted-foreground">
          {footer}
        </footer>
      ) : null}
    </section>
  );
}

const FIELD_COPY = {
  name: 'Enter your name.',
  email: 'Enter a valid email address.',
  password: PASSWORD_POLICY_MESSAGE,
} as const;

export function LoginForm({
  onSubmit,
  googleHref,
  next,
}: {
  onSubmit: SubmitHandler<LoginValues>;
  /** Full navigation to GET /auth/google/start. Omitted when Google sign-in is off. */
  googleHref?: string | undefined;
  /** Post-login path. Kept on the sign-up link so switching forms does not drop it. */
  next?: string | undefined;
}) {
  const {
    register,
    handleSubmit,
    setError,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<LoginValues>({
    resolver: zodResolver(loginSchema),
    mode: 'onSubmit',
    shouldFocusError: true,
    defaultValues: { email: '', password: '' },
  });

  return (
    <AuthCard
      title="Welcome back"
      description="Log in to MeetOps AI"
      footer={
        <span>
          New to MeetOps?{' '}
          <Link to="/signup" search={next ? { next } : {}} className={authLinkClass}>
            Create an account
          </Link>
        </span>
      }
    >
      <form
        method="post"
        noValidate
        aria-busy={isSubmitting || undefined}
        className="grid gap-3"
        onSubmit={(e) =>
          void handleSubmit(async (v) => {
            try {
              await onSubmit(v);
            } catch (err) {
              if (err instanceof ApiError && err.code === 'AUTH_FAILED') {
                // Inline under the password: keep the email, clear + focus the password.
                setValue('password', '');
                setError(
                  'password',
                  { type: 'server', message: 'Email or password is incorrect.' },
                  { shouldFocus: true },
                );
              } else if (!applyFieldErrors(setError, err, FIELD_COPY)) {
                toastError(err);
              }
            }
          })(e)
        }
      >
        {googleHref ? <GoogleContinue href={googleHref} /> : null}
        <Field
          label="Email"
          autoComplete="username"
          autoFocus
          error={errors.email?.message}
          {...emailInputProps}
          {...register('email')}
        />
        <PasswordField
          label="Password"
          autoComplete="current-password"
          labelAside={
            <Link to="/forgot-password" className={cn(authLinkClass, 'min-h-0 py-0 text-sm')}>
              Forgot password?
            </Link>
          }
          error={errors.password?.message}
          {...register('password')}
        />
        <SubmitButton busy={isSubmitting} busyLabel="Logging in…">
          Log in
        </SubmitButton>
      </form>
    </AuthCard>
  );
}

/**
 * Sign-up. POST /auth/signup answers 202 `{ message }` with no session (the user must
 * verify their email first), so success shows a "check your inbox" state in place.
 * The response is enumeration-safe; so is the resend action.
 */
export function SignupForm({
  onSubmit,
  onResend,
  next,
  googleHref,
}: {
  onSubmit: SubmitHandler<SignupValues>;
  onResend?: (email: string) => Promise<unknown>;
  next?: string | undefined;
  /** Same Google flow as login. The API creates the account when the Google email is new. */
  googleHref?: string | undefined;
}) {
  const [sentTo, setSentTo] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    setError,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<SignupValues>({
    resolver: zodResolver(signupSchema),
    mode: 'onSubmit',
    shouldFocusError: true,
    defaultValues: { name: '', email: '', password: '' },
  });

  const signInLink = (
    <span>
      {sentTo ? 'Verified already? ' : 'Already have an account? '}
      <Link to="/login" search={next ? { next } : {}} className={authLinkClass}>
        Log in
      </Link>
    </span>
  );

  if (sentTo) {
    return (
      <AuthCard
        title="Verify your email"
        description="One more step to create your workspace"
        footer={signInLink}
      >
        <CheckEmail
          email={sentTo}
          message="to verify your email. Open it to activate your account, then log in"
          onResend={onResend ? () => onResend(sentTo) : undefined}
          // Back to the form with name + email kept (react-hook-form keeps the values).
          onUseDifferentEmail={() => setSentTo(null)}
        />
      </AuthCard>
    );
  }

  return (
    <AuthCard
      title="Create your workspace"
      description="Start turning meetings into action"
      footer={signInLink}
    >
      <form
        method="post"
        noValidate
        aria-busy={isSubmitting || undefined}
        className="grid gap-3"
        onSubmit={(e) =>
          void handleSubmit(async (v) => {
            try {
              await onSubmit(v);
              setSentTo(v.email);
            } catch (err) {
              if (!applyFieldErrors(setError, err, FIELD_COPY)) toastError(err);
            }
          })(e)
        }
      >
        {googleHref ? <GoogleContinue href={googleHref} /> : null}
        <Field
          label="Full name"
          autoComplete="name"
          autoCapitalize="words"
          error={errors.name?.message}
          {...register('name')}
        />
        <Field
          label="Work email"
          autoComplete="email"
          error={errors.email?.message}
          {...emailInputProps}
          {...register('email')}
        />
        <PasswordField
          label="Password"
          autoComplete="new-password"
          meter
          value={watch('password')}
          error={errors.password?.message}
          {...register('password')}
        />
        {/* The page's one shimmer CTA (docs/05-web/auth-pages.md). */}
        <SubmitButton variant="shimmer" busy={isSubmitting} busyLabel="Creating account…">
          Create account
        </SubmitButton>
      </form>
    </AuthCard>
  );
}

export function ForgotPasswordForm({
  onSubmit,
}: {
  onSubmit: SubmitHandler<ForgotPasswordValues>;
}) {
  const [sentTo, setSentTo] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<ForgotPasswordValues>({
    resolver: zodResolver(forgotPasswordSchema),
    mode: 'onSubmit',
    shouldFocusError: true,
    defaultValues: { email: '' },
  });

  const backLink = (
    <Link to="/login" className={authLinkClass}>
      Back to log in
    </Link>
  );

  if (sentTo) {
    return (
      <AuthCard title="Reset your password" description="Check your email" footer={backLink}>
        <CheckEmail
          email={sentTo}
          message="to reset your password"
          onResend={async () => onSubmit({ email: sentTo })}
          onUseDifferentEmail={() => setSentTo(null)}
        />
      </AuthCard>
    );
  }

  return (
    <AuthCard
      title="Reset your password"
      description="We'll email you a link to choose a new one"
      footer={backLink}
    >
      <form
        method="post"
        noValidate
        aria-busy={isSubmitting || undefined}
        className="grid gap-4"
        onSubmit={(e) =>
          void handleSubmit(async (v) => {
            // The API answers 202 whether or not the account exists, so an error here is a
            // real failure (network, 429, 5xx), never an enumeration signal.
            try {
              await onSubmit(v);
              setSentTo(v.email);
            } catch (err) {
              if (!applyFieldErrors(setError, err, { email: FIELD_COPY.email })) toastError(err);
            }
          })(e)
        }
      >
        <Field
          label="Email"
          autoComplete="email"
          autoFocus
          error={errors.email?.message}
          {...emailInputProps}
          {...register('email')}
        />
        <SubmitButton busy={isSubmitting} busyLabel="Sending…">
          Send reset link
        </SubmitButton>
      </form>
    </AuthCard>
  );
}
