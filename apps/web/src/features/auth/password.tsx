import { forwardRef, useState, type ComponentProps } from 'react';
import { Check, Eye, EyeOff } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Field } from './field';

/** API policy (contracts): new passwords are 12–128 characters. */
export const MIN_PASSWORD = 12;
export const MAX_PASSWORD = 128;

type PasswordFieldProps = Omit<ComponentProps<typeof Field>, 'type' | 'trailing'> & {
  /** Show the strength meter (sign-up / reset only). */
  meter?: boolean;
  /** Current value, for the meter (react-hook-form `watch`). */
  value?: string;
};

/**
 * Password input with a show/hide toggle. The toggle is a real button
 * (`aria-pressed`, `aria-controls`) that doesn't take focus from the input on click,
 * so the caret stays where it was.
 */
export const PasswordField = forwardRef<HTMLInputElement, PasswordFieldProps>(
  function PasswordField({ meter = false, value, id, name, ...props }, ref) {
    const [visible, setVisible] = useState(false);
    const inputId = id ?? name;
    return (
      <Field
        {...props}
        id={inputId}
        name={name}
        ref={ref}
        type={visible ? 'text' : 'password'}
        autoCapitalize="none"
        spellCheck={false}
        hint={meter ? <PasswordStrength password={value ?? ''} /> : undefined}
        trailing={
          <button
            type="button"
            aria-label={visible ? 'Hide password' : 'Show password'}
            aria-pressed={visible}
            aria-controls={inputId}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setVisible((v) => !v)}
            className="flex h-11 w-11 items-center justify-center rounded-md text-muted-foreground transition-colors duration-150 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {visible ? (
              <EyeOff className="h-4 w-4" aria-hidden />
            ) : (
              <Eye className="h-4 w-4" aria-hidden />
            )}
          </button>
        }
      />
    );
  },
);

export type Strength = {
  score: 0 | 1 | 2 | 3 | 4;
  label: 'Too short' | 'Weak' | 'Good' | 'Strong';
};

/**
 * Length + character-class heuristic (no dependency). Below the API minimum is always
 * "Too short"; the score never claims more than the policy enforces.
 */
export function scorePassword(password: string): Strength {
  if (password.length < MIN_PASSWORD) return { score: password ? 1 : 0, label: 'Too short' };
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(password)).length;
  const unique = new Set(password).size;
  let points = 0;
  if (password.length >= 16) points++;
  if (classes >= 3) points++;
  if (unique >= 8) points++;
  if (points >= 3) return { score: 4, label: 'Strong' };
  if (points >= 1) return { score: 3, label: 'Good' };
  return { score: 2, label: 'Weak' };
}

// Segment fills by score: tokens only, never the rose highlight.
const FILL: Record<Strength['score'], string> = {
  0: 'bg-border',
  1: 'bg-destructive',
  2: 'bg-warning',
  3: 'bg-primary',
  4: 'bg-link',
};

export function PasswordStrength({ password }: { password: string }) {
  const s = scorePassword(password);
  const longEnough = password.length >= MIN_PASSWORD && password.length <= MAX_PASSWORD;
  return (
    <div className="grid gap-1.5" data-testid="password-strength">
      <div className="grid grid-cols-4 gap-1" aria-hidden="true">
        {[1, 2, 3, 4].map((i) => (
          <span
            key={i}
            className={cn(
              'h-1 rounded-full transition-colors duration-200',
              s.score >= i ? FILL[s.score] : 'bg-border',
            )}
          />
        ))}
      </div>
      <div className="flex items-center justify-between text-xs">
        <span
          className={cn(
            'flex items-center gap-1',
            longEnough ? 'text-link' : 'text-muted-foreground',
          )}
        >
          <Check
            className={cn('h-3.5 w-3.5', longEnough ? 'opacity-100' : 'opacity-40')}
            aria-hidden
          />
          At least {MIN_PASSWORD} characters
        </span>
        <span aria-live="polite" className="text-muted-foreground">
          {password ? `Strength: ${s.label}` : ''}
        </span>
      </div>
    </div>
  );
}
