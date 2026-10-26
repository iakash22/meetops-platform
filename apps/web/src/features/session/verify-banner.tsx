import { useEffect, useState } from 'react';
import { MailWarning } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useApi } from '@/lib/api/context';
import { notify, toastError } from '@/lib/errors/notify';
import { RESEND_COOLDOWN_SECONDS } from '@/features/auth/check-email';
import { useSession } from './use-session';

/**
 * BACKEND DEPENDENCY (All Rounder): contracts 0.4.x `User` has no verification field. The API stores
 * `emailVerifiedAt`; once the session user exposes it, `null` means unverified. Until then the field is absent and
 * the banner stays hidden (never a false alarm).
 */
export function isEmailUnverified(user: unknown): boolean {
  return (
    typeof user === 'object' &&
    user !== null &&
    'emailVerifiedAt' in user &&
    user.emailVerifiedAt === null
  );
}

/** In-app "verify your email" state with a rate-limited resend. Dismissal lasts for this page load only. */
export function VerifyEmailBanner() {
  const { data } = useSession();
  const api = useApi();
  const [hidden, setHidden] = useState(false);
  const [sending, setSending] = useState(false);
  const [cooldown, setCooldown] = useState(0);

  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  if (hidden || !data || !isEmailUnverified(data.user)) return null;
  const email = data.user.email;

  const resend = async () => {
    setSending(true);
    try {
      await api.auth.resendVerification({ email });
      notify.success('Verification email sent', `Check ${email} for the link.`);
      setCooldown(RESEND_COOLDOWN_SECONDS);
    } catch (err) {
      toastError(err, { title: "Couldn't send the email" });
    } finally {
      setSending(false);
    }
  };

  return (
    <div
      role="status"
      data-testid="verify-email-banner"
      className="flex flex-wrap items-center gap-3 border-b bg-card px-4 py-2 text-sm"
    >
      <MailWarning className="h-4 w-4 text-highlight" aria-hidden />
      <span className="flex-1">
        Verify your email address. We sent a link to <strong>{email}</strong>.
      </span>
      <Button
        size="sm"
        onClick={() => void resend()}
        disabled={sending || cooldown > 0}
        aria-busy={sending}
      >
        {sending ? 'Sending…' : cooldown > 0 ? `Resend in ${cooldown}s` : 'Resend link'}
      </Button>
      <Button size="sm" variant="ghost" onClick={() => setHidden(true)}>
        Dismiss
      </Button>
    </div>
  );
}
