import { useEffect, useRef, useState } from 'react';
import { MailCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { notify, toastError } from '@/lib/errors/notify';
import { authButtonClass } from './styles';

export const RESEND_COOLDOWN_SECONDS = 60;

/**
 * "Check your inbox" state that replaces a form in place (sign-up, forgot password,
 * resend verification). Copy stays enumeration-safe: it never says whether the address
 * has an account. Focus moves to the heading so screen readers announce the change.
 */
export function CheckEmail({
  email,
  message,
  onResend,
  onUseDifferentEmail,
}: {
  email: string;
  /** What the link does, e.g. "to verify your email" / "to reset your password". */
  message: string;
  onResend?: (() => Promise<unknown>) | undefined;
  onUseDifferentEmail?: (() => void) | undefined;
}) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [cooldown, setCooldown] = useState(RESEND_COOLDOWN_SECONDS);
  const [sending, setSending] = useState(false);

  useEffect(() => headingRef.current?.focus(), []);
  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  const resend = async () => {
    if (!onResend) return;
    setSending(true);
    try {
      await onResend();
      notify.success('Email sent again', `If ${email} can receive it, a new link is on its way.`);
      setCooldown(RESEND_COOLDOWN_SECONDS);
    } catch (err) {
      // Enumeration-safe endpoints only fail for transport/rate reasons: not field errors.
      toastError(err);
    } finally {
      setSending(false);
    }
  };

  return (
    <div
      role="status"
      data-testid="check-email"
      className="grid gap-5 text-center motion-safe:duration-200 motion-safe:animate-in motion-safe:fade-in-0"
    >
      <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-full border border-primary/40 bg-primary/10 shadow-[0_0_24px_-4px_hsl(var(--primary))]">
        <MailCheck className="h-6 w-6 text-link" aria-hidden />
      </span>
      <div className="grid gap-2">
        <h2
          ref={headingRef}
          tabIndex={-1}
          className="text-xl font-semibold tracking-tight focus:outline-none"
        >
          Check your inbox
        </h2>
        <p className="text-sm text-muted-foreground">
          If <strong className="text-foreground">{email}</strong> can receive it, we sent a link{' '}
          {message}. It can take a minute to arrive.
        </p>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Button asChild variant="outline" className="h-11">
          <a href="https://mail.google.com/" target="_blank" rel="noopener noreferrer">
            Open Gmail
          </a>
        </Button>
        <Button asChild variant="outline" className="h-11">
          <a href="https://outlook.live.com/mail/" target="_blank" rel="noopener noreferrer">
            Open Outlook
          </a>
        </Button>
      </div>
      {onResend ? (
        <Button
          type="button"
          variant="ghost"
          className={authButtonClass}
          disabled={sending || cooldown > 0}
          aria-busy={sending || undefined}
          onClick={() => void resend()}
        >
          {sending
            ? 'Sending…'
            : cooldown > 0
              ? `Didn't get it? Resend in ${cooldown}s`
              : "Didn't get it? Resend"}
        </Button>
      ) : null}
      {onUseDifferentEmail ? (
        <Button type="button" variant="link" className="h-11" onClick={onUseDifferentEmail}>
          Use a different email
        </Button>
      ) : null}
    </div>
  );
}
