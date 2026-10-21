import { useState, type ReactNode } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Link } from '@tanstack/react-router';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { ErrorState } from '@/components/states/states';
import {
  forgotPasswordSchema,
  loginSchema,
  signupSchema,
  type ForgotPasswordValues,
  type LoginValues,
  type SignupValues,
} from './schemas';
import { Field } from './field';

type SubmitHandler<T> = (values: T) => Promise<void> | void;

function AuthCard({
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
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle>
          <h1>{title}</h1>
        </CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>{children}</CardContent>
      {footer ? <CardFooter className="flex flex-col gap-1 text-sm">{footer}</CardFooter> : null}
    </Card>
  );
}

function useSubmitError() {
  const [error, setError] = useState<unknown>(null);
  return { error, setError };
}

export function LoginForm({ onSubmit }: { onSubmit: SubmitHandler<LoginValues> }) {
  const { error, setError } = useSubmitError();
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<LoginValues>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: '', password: '' },
  });

  return (
    <AuthCard
      title="Sign in"
      description="Welcome back to MeetOps AI"
      footer={
        <>
          <Link to="/forgot-password" className="underline">
            Forgot password?
          </Link>
          <Link to="/signup" className="underline">
            Create an account
          </Link>
        </>
      }
    >
      <form
        noValidate
        className="grid gap-4"
        onSubmit={(e) =>
          void handleSubmit(async (v) => {
            setError(null);
            try {
              await onSubmit(v);
            } catch (err) {
              setError(err);
            }
          })(e)
        }
      >
        {error ? <ErrorState title="Sign in failed" error={error} /> : null}
        <Field
          label="Email"
          type="email"
          autoComplete="email"
          error={errors.email?.message}
          {...register('email')}
        />
        <Field
          label="Password"
          type="password"
          autoComplete="current-password"
          error={errors.password?.message}
          {...register('password')}
        />
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting ? 'Signing in…' : 'Sign in'}
        </Button>
      </form>
    </AuthCard>
  );
}

export function SignupForm({ onSubmit }: { onSubmit: SubmitHandler<SignupValues> }) {
  const { error, setError } = useSubmitError();
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<SignupValues>({
    resolver: zodResolver(signupSchema),
    defaultValues: { name: '', email: '', password: '', confirmPassword: '' },
  });

  return (
    <AuthCard
      title="Create account"
      description="Start turning meetings into action"
      footer={
        <Link to="/login" className="underline">
          Already have an account? Sign in
        </Link>
      }
    >
      <form
        noValidate
        className="grid gap-4"
        onSubmit={(e) =>
          void handleSubmit(async (v) => {
            setError(null);
            try {
              await onSubmit(v);
            } catch (err) {
              setError(err);
            }
          })(e)
        }
      >
        {error ? <ErrorState title="Sign up failed" error={error} /> : null}
        <Field
          label="Name"
          autoComplete="name"
          error={errors.name?.message}
          {...register('name')}
        />
        <Field
          label="Email"
          type="email"
          autoComplete="email"
          error={errors.email?.message}
          {...register('email')}
        />
        <Field
          label="Password"
          type="password"
          autoComplete="new-password"
          error={errors.password?.message}
          {...register('password')}
        />
        <Field
          label="Confirm password"
          type="password"
          autoComplete="new-password"
          error={errors.confirmPassword?.message}
          {...register('confirmPassword')}
        />
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting ? 'Creating account…' : 'Create account'}
        </Button>
      </form>
    </AuthCard>
  );
}

export function ForgotPasswordForm({
  onSubmit,
}: {
  onSubmit: SubmitHandler<ForgotPasswordValues>;
}) {
  const [sent, setSent] = useState(false);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<ForgotPasswordValues>({
    resolver: zodResolver(forgotPasswordSchema),
    defaultValues: { email: '' },
  });

  return (
    <AuthCard
      title="Reset password"
      description="We'll email you a reset link"
      footer={
        <Link to="/login" className="underline">
          Back to sign in
        </Link>
      }
    >
      {sent ? (
        <p role="status">If an account exists for that email, a reset link is on its way.</p>
      ) : (
        <form
          noValidate
          className="grid gap-4"
          onSubmit={(e) =>
            void handleSubmit(async (v) => {
              // Enumeration-safe: same outcome regardless of result.
              try {
                await onSubmit(v);
              } catch {
                /* intentionally ignored */
              }
              setSent(true);
            })(e)
          }
        >
          <Field
            label="Email"
            type="email"
            autoComplete="email"
            error={errors.email?.message}
            {...register('email')}
          />
          <Button type="submit" disabled={isSubmitting}>
            {isSubmitting ? 'Sending…' : 'Send reset link'}
          </Button>
        </form>
      )}
    </AuthCard>
  );
}
