import type { ReactNode } from 'react';
import { Link, useRouterState } from '@tanstack/react-router';
import { CheckSquare, FileText, Mic } from 'lucide-react';
import { BrandBackground } from '@/components/brand/brand-background';
import { SpotlightCard } from '@/components/ui/spotlight-card';
import { MeetOpsLogo } from './logo';
import { authLinkClass } from './styles';

/**
 * Shared shell for every signed-out page (login, signup, forgot/reset password, verify and
 * resend, invitation accept). Split screen from `lg`: the form column on the left, the brand
 * panel on the right; below `lg` the panel is hidden and a slim glow sits behind the form.
 * Spec: docs/05-web/auth-pages.md.
 */
/** Keep `?next=` when switching between log in and sign up. Drop anything that is not a same-app path. */
function accountSearch(search: unknown): { next: string } | undefined {
  if (!search || typeof search !== 'object' || !('next' in search)) return undefined;
  const next = (search as { next?: unknown }).next;
  if (typeof next !== 'string' || !next.startsWith('/') || next.startsWith('//')) return undefined;
  return { next };
}

export function AuthLayout({ children }: { children: ReactNode }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const nextSearch = useRouterState({ select: (s) => accountSearch(s.location.search) });
  const onSignup = pathname === '/signup';
  return (
    <div
      data-testid="auth-layout"
      className="grid min-h-svh bg-background text-foreground lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]"
    >
      <div className="relative isolate flex min-h-svh flex-col px-6 py-4 sm:px-10">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 top-0 -z-10 lg:hidden"
        >
          <BrandBackground intensity="subtle" grid={false} className="h-[40vh]" />
        </div>
        <header className="flex items-center justify-between gap-4">
          <Link
            to="/"
            aria-label="MeetOps AI home"
            className="inline-flex min-h-11 items-center rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <MeetOpsLogo />
          </Link>
          {onSignup ? (
            <Link to="/login" search={nextSearch ?? {}} className={authLinkClass}>
              Sign in
            </Link>
          ) : pathname === '/login' ? (
            <Link to="/signup" search={nextSearch ?? {}} className={authLinkClass}>
              Sign up
            </Link>
          ) : null}
        </header>
        <p className="text-sm text-muted-foreground lg:hidden">{HEADLINE}</p>
        <main className="flex flex-1 flex-col items-center py-6">
          <div className="my-auto w-full max-w-[26rem] motion-safe:duration-200 motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-2">
            {children}
          </div>
        </main>
        <LegalLine />
      </div>
      <BrandPanel rich={onSignup} />
    </div>
  );
}

const HEADLINE = 'Every meeting, turned into action.';

const VALUE_PROPS = [
  {
    icon: Mic,
    title: 'Record & transcribe',
    body: 'Capture meetings and get a searchable transcript.',
  },
  {
    icon: FileText,
    title: 'AI summaries',
    body: 'Decisions and key points, ready when the call ends.',
  },
  {
    icon: CheckSquare,
    title: 'Task drafts',
    body: 'Action items drafted as tasks for your team to review.',
  },
] as const;

/**
 * Optional real testimonial. TODO(testimonial): pass one here ONLY once a real customer has
 * agreed to be quoted (quote + name/role/company, avatar optional). Never invent one; no
 * ratings, customer logos or security claims either (see docs/05-web/auth-pages.md).
 */
export type Testimonial = { quote: string; name: string; role: string; company: string };
const realTestimonial = (): Testimonial | null => null;

function BrandPanel({ rich }: { rich: boolean }) {
  const testimonial = realTestimonial();
  return (
    <aside
      aria-label="About MeetOps AI"
      className="m-3 hidden overflow-hidden rounded-2xl border border-border lg:flex"
    >
      <BrandBackground
        intensity={rich ? 'hero' : 'default'}
        className="flex w-full flex-col justify-center gap-8 p-10 xl:p-14"
      >
        <h2 className="max-w-lg text-display">{HEADLINE}</h2>
        {rich ? <MockSummary /> : null}
        <ul className="grid max-w-md gap-4">
          {VALUE_PROPS.map(({ icon: Icon, title, body }) => (
            <li key={title} className="flex gap-3">
              <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border bg-card">
                <Icon className="h-4 w-4 text-link" aria-hidden />
              </span>
              <span className="grid gap-0.5">
                <span className="font-medium">{title}</span>
                <span className="text-sm text-muted-foreground">{body}</span>
              </span>
            </li>
          ))}
        </ul>
        {testimonial ? (
          <figure className="max-w-md border-l-2 border-primary pl-4">
            <blockquote className="text-sm">“{testimonial.quote}”</blockquote>
            <figcaption className="mt-2 text-xs text-muted-foreground">
              {testimonial.name}, {testimonial.role} · {testimonial.company}
            </figcaption>
          </figure>
        ) : null}
      </BrandBackground>
    </aside>
  );
}

/** Static illustration of a summary + drafted tasks. Not live data; labelled as an example. */
function MockSummary() {
  return (
    <SpotlightCard data-testid="mock-summary" className="max-w-md p-5">
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>Example summary</span>
        <span>Product sync · 30 min</span>
      </div>
      <p className="mt-3 text-sm">
        The team agreed to ship the onboarding checklist next sprint and to revisit pricing copy
        after user interviews.
      </p>
      <p className="mt-4 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Drafted tasks
      </p>
      <ul className="mt-2 grid gap-2 text-sm">
        {[
          'Finalize onboarding checklist copy',
          'Schedule five user interviews',
          'Draft pricing page update',
        ].map((t) => (
          <li
            key={t}
            className="flex items-center gap-2 rounded-md border border-border bg-background/60 px-3 py-2"
          >
            <CheckSquare className="h-4 w-4 text-link" aria-hidden />
            {t}
          </li>
        ))}
      </ul>
    </SpotlightCard>
  );
}

/**
 * Legal line pinned under the form (Supabase/Resend pattern, docs/references.md §5).
 * The Terms/Privacy pages are owned outside this repo, so their URLs come from build env
 * (VITE_TERMS_URL / VITE_PRIVACY_URL). Until both are set, nothing renders: we never link
 * to a page that doesn't exist.
 */
export function LegalLine({
  termsUrl = import.meta.env.VITE_TERMS_URL,
  privacyUrl = import.meta.env.VITE_PRIVACY_URL,
}: {
  termsUrl?: string | undefined;
  privacyUrl?: string | undefined;
}) {
  const safe = (u: string | undefined) => (u && /^(https:\/\/|\/)/.test(u) ? u : undefined);
  const terms = safe(termsUrl);
  const privacy = safe(privacyUrl);
  if (!terms || !privacy) return null;
  return (
    <p className="pb-2 text-caption text-muted-foreground">
      By continuing, you agree to the{' '}
      <a href={terms} className={authLinkClass} target="_blank" rel="noopener noreferrer">
        Terms of Service
        <span className="sr-only"> (opens in a new tab)</span>
      </a>{' '}
      and{' '}
      <a href={privacy} className={authLinkClass} target="_blank" rel="noopener noreferrer">
        Privacy Policy
        <span className="sr-only"> (opens in a new tab)</span>
      </a>
      .
    </p>
  );
}
