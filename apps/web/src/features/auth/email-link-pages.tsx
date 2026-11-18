import { PASSWORD_POLICY_MESSAGE } from '@meetops/contracts/types';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Link } from '@tanstack/react-router';
import { Button } from '@/components/ui/button';
import { ApiError } from '@/lib/api/client';
import { applyFieldErrors, notify, toastError } from '@/lib/errors/notify';
import { CheckEmail } from './check-email';
import { AuthCard, emailInputProps } from './forms';
import { Field } from './field';
import { PasswordField } from './password';
import { authButtonClass, authErrorTextClass, authLinkClass } from './styles';
import { SubmitButton } from './submit-button';
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

/** A problem with the link itself (page-level, inline): not a toast. */
function Problem({ title, children }: { title: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);

  return (
    <div
      ref={ref}
      role="alert"
      tabIndex={-1}
      className="grid gap-1 rounded-md border border-destructive/40 bg-destructive/10 p-4 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 focus:ring-offset-background"
      data-testid="link-problem"
    >
      <p className={`font-medium ${authErrorTextClass}`}>{title}</p>
      <p className="text-sm text-muted-foreground">{children}</p>
    </div>
  );
}

const backToSignIn = (
  <Link to="/login" className={authLinkClass}>
    Back to log in
  </Link>
);

// ---- /verify-email ----

export function VerifyEmailPage({
  token,
  onVerify,
}: {
  token: string | undefined;
  onVerify: (token: string) => Promise<{ passwordReset?: boolean; setPassword?: boolean } | void>;
}) {
  const [state, setState] = useState<
    'idle' | 'pending' | 'done' | 'password_reset' | 'set_password'
  >('idle');
  const [error, setError] = useState<unknown>(null);

  const verify = async (t: string) => {
    setState('pending');
    setError(null);
    try {
      const r = await onVerify(t);
      if (r?.setPassword) {
        // The mailbox owner took over an account that never had a password: nothing was removed.
        setState('set_password');
        notify.success('Email verified', 'Set a password with the link we just emailed you.');
      } else if (r?.passwordReset) {
        // UX-1: the mailbox owner took the account over; the old password no longer works.
        setState('password_reset');
        notify.success('Email verified', 'Set a password with the link we just emailed you.');
      } else {
        setState('done');
        notify.success('Email verified', 'You can log in now.');
      }
    } catch (err) {
      setError(err);
      setState('idle');
      if (!isStatus(err, 400)) toastError(err);
    }
  };

  const resendLink = (
    <Link to="/resend-verification" className={authLinkClass}>
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
  } else if (state === 'set_password') {
    body = (
      <div className="grid gap-4">
        <Status>
          Your email address is verified. To sign in with a password, set one with the link we just
          emailed you.
        </Status>
        <Button asChild className={authButtonClass}>
          <Link to="/forgot-password">Send a new set-password link</Link>
        </Button>
      </div>
    );
  } else if (state === 'password_reset') {
    body = (
      <div className="grid gap-4">
        <Status>
          Your email address is verified. For your security, the password on this account was
          removed. Set a new one with the link we just emailed you.
        </Status>
        <Button asChild className={authButtonClass}>
          <Link to="/forgot-password">Send a new set-password link</Link>
        </Button>
      </div>
    );
  } else if (state === 'done') {
    body = (
      <div className="grid gap-4">
        <Status>Your email address is verified.</Status>
        <Button asChild className={authButtonClass}>
          <Link to="/login">Continue to log in</Link>
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
        <p className="text-sm text-muted-foreground">
          Confirm that you want to verify the email address for your MeetOps AI account.
        </p>
        <SubmitButton
          type="button"
          busy={state === 'pending'}
          busyLabel="Verifying…"
          onClick={() => void verify(token)}
        >
          Verify email
        </SubmitButton>
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
    setError: setFieldError,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<ResetPasswordValues>({
    resolver: zodResolver(resetPasswordSchema),
    mode: 'onSubmit',
    shouldFocusError: true,
    defaultValues: { password: '', confirmPassword: '' },
  });

  const forgotLink = (
    <Link to="/forgot-password" className={authLinkClass}>
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
        <Button asChild className={authButtonClass}>
          <Link to="/login">Log in with your new password</Link>
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
        method="post"
        noValidate
        aria-busy={isSubmitting || undefined}
        className="grid gap-4"
        onSubmit={(e) =>
          void handleSubmit(async ({ password }) => {
            setError(null);
            try {
              await onSubmit({ token, password });
              setDone(true);
              notify.success('Password changed', 'Log in with your new password.');
            } catch (err) {
              // A 400 with field details is the password policy; a bare 400 is the token.
              if (applyFieldErrors(setFieldError, err, { password: PASSWORD_POLICY_MESSAGE }))
                return;
              setError(err);
              if (!isStatus(err, 400)) toastError(err);
            }
          })(e)
        }
      >
        <PasswordField
          label="New password"
          autoComplete="new-password"
          autoFocus
          meter
          value={watch('password')}
          error={errors.password?.message}
          {...register('password')}
        />
        <PasswordField
          label="Confirm new password"
          autoComplete="new-password"
          error={errors.confirmPassword?.message}
          {...register('confirmPassword')}
        />
        <SubmitButton busy={isSubmitting} busyLabel="Saving…">
          Set new password
        </SubmitButton>
      </form>
    );
  }

  return (
    <AuthCard
      title="Choose a new password"
      description="You'll need to log in again on every device"
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
  const [sentTo, setSentTo] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<ResendVerificationValues>({
    resolver: zodResolver(resendVerificationSchema),
    mode: 'onSubmit',
    shouldFocusError: true,
    defaultValues: { email: defaultEmail ?? '' },
  });

  return (
    <AuthCard
      title="Resend verification email"
      description="We'll email you a new verification link"
      footer={backToSignIn}
    >
      {sentTo ? (
        <CheckEmail
          email={sentTo}
          message="to verify your email"
          onResend={() => onSubmit({ email: sentTo })}
          onUseDifferentEmail={() => setSentTo(null)}
        />
      ) : (
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
                const copy = { email: 'Enter a valid email address.' };
                if (!applyFieldErrors(setError, err, copy)) toastError(err);
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
            Send verification link
          </SubmitButton>
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
      if (![401, 403, 404, 409].some((st) => isStatus(err, st))) toastError(err);
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
          Log in with the email address the invitation was sent to, then accept it.
        </p>
        <Button asChild className={authButtonClass}>
          <Link to="/login" search={here ? { next: here } : {}}>
            Log in to accept
          </Link>
        </Button>
        <Link
          to="/signup"
          search={here ? { next: here } : {}}
          className={`${authLinkClass} text-sm`}
        >
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
        <Link to="/resend-verification" className={`${authLinkClass} text-sm`}>
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
        <Button asChild className={authButtonClass}>
          <Link to="/">Go to MeetOps AI</Link>
        </Button>
      </div>
    );
  } else {
    body = (
      <div className="grid gap-4">
        <p className="text-sm text-muted-foreground">
          Signed in as <strong>{signedInAs}</strong>.
        </p>
        <SubmitButton
          type="button"
          busy={pending}
          busyLabel="Joining…"
          onClick={() => void accept(token)}
        >
          Accept invitation
        </SubmitButton>
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
