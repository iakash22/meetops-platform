import { useState, type ReactNode } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Link } from '@tanstack/react-router';
import { Button } from '@/components/ui/button';
import { ErrorState } from '@/components/states/states';
import { ApiError } from '@/lib/api/client';
import { AuthCard } from './forms';
import { Field } from './field';
import {
  resendVerificationSchema,
  resetPasswordSchema,
  type ResendVerificationValues,
  type ResetPasswordValues,
} from './schemas';

/**
 * Pages reached from links in auth emails (apps/api auth-mail.handler.ts):
 * /verify-email?token=, /reset-password?token=, /invitations/accept?token=, plus
 * /resend-verification. Token links never act on page load (mail link scanners and
 * prefetchers would consume single-use tokens): the user confirms with a button.
 */

const isStatus = (err: unknown, status: number) => err instanceof ApiError && err.status === status;

function Status({ children }: { children: ReactNode }) {
  return <p role="status">{children}</p>;
}

function Problem({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div role="alert" className="grid gap-1" data-testid="link-problem">
      <p className="font-medium text-destructive">{title}</p>
      <p className="text-sm text-muted-foreground">{children}</p>
    </div>
  );
}

const backToSignIn = (
  <Link to="/login" className="underline">
    Back to sign in
  </Link>
);

// ---- /verify-email ----

export function VerifyEmailPage({
  token,
  onVerify,
}: {
  token: string | undefined;
  onVerify: (token: string) => Promise<void>;
}) {
  const [state, setState] = useState<'idle' | 'pending' | 'done'>('idle');
  const [error, setError] = useState<unknown>(null);

  const verify = async (t: string) => {
    setState('pending');
    setError(null);
    try {
      await onVerify(t);
      setState('done');
    } catch (err) {
      setError(err);
      setState('idle');
    }
  };

  const resendLink = (
    <Link to="/resend-verification" className="underline">
      Send a new verification link
    </Link>
  );

  let body: ReactNode;
  if (!token) {
    body = (
      <Problem title="This verification link is incomplete">
        Open the link from your email again, or request a new one.
      </Problem>
    );
  } else if (state === 'done') {
    body = (
      <div className="grid gap-4">
        <Status>Your email address is verified.</Status>
        <Button asChild>
          <Link to="/login">Continue to sign in</Link>
        </Button>
      </div>
    );
  } else if (isStatus(error, 400)) {
    body = (
      <Problem title="This verification link is invalid or has expired">
        Verification links can be used once and expire after a while. Request a new one below.
      </Problem>
    );
  } else {
    body = (
      <div className="grid gap-4">
        {error ? <ErrorState title="Verification failed" error={error} /> : null}
        <p className="text-sm text-muted-foreground">
          Confirm that you want to verify the email address for your MeetOps AI account.
        </p>
        <Button disabled={state === 'pending'} onClick={() => void verify(token)}>
          {state === 'pending' ? 'Verifying…' : 'Verify email'}
        </Button>
      </div>
    );
  }

  return (
    <AuthCard
      title="Verify your email"
      description="Finish setting up your account"
      footer={
        <>
          {state === 'done' ? null : resendLink}
          {backToSignIn}
        </>
      }
    >
      {body}
    </AuthCard>
  );
}

// ---- /reset-password ----

export function ResetPasswordForm({
  token,
  onSubmit,
}: {
  token: string | undefined;
  onSubmit: (body: { token: string; password: string }) => Promise<void>;
}) {
  const [done, setDone] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<ResetPasswordValues>({
    resolver: zodResolver(resetPasswordSchema),
    defaultValues: { password: '', confirmPassword: '' },
  });

  const forgotLink = (
    <Link to="/forgot-password" className="underline">
      Request a new reset link
    </Link>
  );

  let body: ReactNode;
  if (!token) {
    body = (
      <Problem title="This reset link is incomplete">
        Open the link from your email again, or request a new one.
      </Problem>
    );
  } else if (done) {
    body = (
      <div className="grid gap-4">
        <Status>Your password was changed. You were signed out on every device.</Status>
        <Button asChild>
          <Link to="/login">Sign in with your new password</Link>
        </Button>
      </div>
    );
  } else if (isStatus(error, 400)) {
    body = (
      <Problem title="This reset link is invalid or has expired">
        Reset links can be used once and expire after a while. Request a new one below.
      </Problem>
    );
  } else {
    body = (
      <form
        noValidate
        className="grid gap-4"
        onSubmit={(e) =>
          void handleSubmit(async ({ password }) => {
            setError(null);
            try {
              await onSubmit({ token, password });
              setDone(true);
            } catch (err) {
              setError(err);
            }
          })(e)
        }
      >
        {error ? <ErrorState title="Password reset failed" error={error} /> : null}
        <Field
          label="New password"
          type="password"
          autoComplete="new-password"
          error={errors.password?.message}
          {...register('password')}
        />
        <Field
          label="Confirm new password"
          type="password"
          autoComplete="new-password"
          error={errors.confirmPassword?.message}
          {...register('confirmPassword')}
        />
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting ? 'Saving…' : 'Set new password'}
        </Button>
      </form>
    );
  }

  return (
    <AuthCard
      title="Choose a new password"
      description="Signing in again will be required on every device"
      footer={
        <>
          {done ? null : forgotLink}
          {backToSignIn}
        </>
      }
    >
      {body}
    </AuthCard>
  );
}

// ---- /resend-verification ----

export function ResendVerificationForm({
  defaultEmail,
  onSubmit,
}: {
  defaultEmail?: string | undefined;
  onSubmit: (values: ResendVerificationValues) => Promise<void>;
}) {
  const [sent, setSent] = useState(false);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<ResendVerificationValues>({
    resolver: zodResolver(resendVerificationSchema),
    defaultValues: { email: defaultEmail ?? '' },
  });

  return (
    <AuthCard
      title="Resend verification email"
      description="We'll email you a new verification link"
      footer={backToSignIn}
    >
      {sent ? (
        <Status>If that account still needs verifying, a new link is on its way.</Status>
      ) : (
        <form
          noValidate
          className="grid gap-4"
          onSubmit={(e) =>
            void handleSubmit(async (v) => {
              // Enumeration-safe (API always answers 202): same outcome regardless of result.
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
            {isSubmitting ? 'Sending…' : 'Send verification link'}
          </Button>
        </form>
      )}
    </AuthCard>
  );
}

// ---- /invitations/accept ----

export function AcceptInvitationPage({
  token,
  signedInAs,
  sessionLoading,
  onAccept,
}: {
  token: string | undefined;
  /** Display name/email of the signed-in user, or null when signed out. */
  signedInAs: string | null;
  sessionLoading: boolean;
  onAccept: (token: string) => Promise<void>;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const here = token ? `/invitations/accept?token=${encodeURIComponent(token)}` : undefined;

  const accept = async (t: string) => {
    setPending(true);
    setError(null);
    try {
      await onAccept(t);
    } catch (err) {
      setError(err);
      setPending(false);
    }
  };

  let body: ReactNode;
  if (!token) {
    body = (
      <Problem title="This invitation link is incomplete">
        Open the link from your invitation email again.
      </Problem>
    );
  } else if (sessionLoading) {
    body = <Status>Checking your session…</Status>;
  } else if (!signedInAs || isStatus(error, 401)) {
    body = (
      <div className="grid gap-4">
        <p className="text-sm text-muted-foreground">
          Sign in with the email address the invitation was sent to, then accept it.
        </p>
        <Button asChild>
          <Link to="/login" search={here ? { next: here } : {}}>
            Sign in to accept
          </Link>
        </Button>
        <Link to="/signup" search={here ? { next: here } : {}} className="text-sm underline">
          New here? Create an account
        </Link>
      </div>
    );
  } else if (isStatus(error, 404)) {
    body = (
      <Problem title="This invitation can't be used">
        It may have expired, been revoked or already used, or it was sent to a different email
        address than the one you're signed in with ({signedInAs}). Ask an admin for a new
        invitation.
      </Problem>
    );
  } else if (isStatus(error, 403)) {
    body = (
      <div className="grid gap-4">
        <Problem title="Verify your email first">
          You need a verified email address to join an organization.
        </Problem>
        <Link to="/resend-verification" className="text-sm underline">
          Send a new verification link
        </Link>
      </div>
    );
  } else if (isStatus(error, 409)) {
    body = (
      <div className="grid gap-4">
        <Problem title="You're already a member">
          You already belong to this organization, so nothing changed.
        </Problem>
        <Button asChild>
          <Link to="/">Go to MeetOps AI</Link>
        </Button>
      </div>
    );
  } else {
    body = (
      <div className="grid gap-4">
        {error ? <ErrorState title="Could not accept the invitation" error={error} /> : null}
        <p className="text-sm text-muted-foreground">
          Signed in as <strong>{signedInAs}</strong>.
        </p>
        <Button disabled={pending} onClick={() => void accept(token)}>
          {pending ? 'Joining…' : 'Accept invitation'}
        </Button>
      </div>
    );
  }

  return (
    <AuthCard
      title="Join an organization"
      description="You've been invited to MeetOps AI"
      footer={backToSignIn}
    >
      {body}
    </AuthCard>
  );
}
