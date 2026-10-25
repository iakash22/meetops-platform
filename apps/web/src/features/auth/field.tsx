import { forwardRef, type InputHTMLAttributes, type ReactNode } from 'react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import { authErrorTextClass, authInputClass } from './styles';

type FieldProps = InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  name: string;
  error?: string | undefined;
  /** Rendered at the right of the label row (e.g. "Forgot password?"). */
  labelAside?: ReactNode;
  /** Rendered inside the input on the right (e.g. the password toggle). */
  trailing?: ReactNode;
  /** Extra content under the input, before the error (e.g. strength meter); give it `${id}-hint`. */
  hint?: ReactNode;
};

/**
 * Labelled input with inline error: `aria-invalid` + `aria-describedby` point at the
 * error (and hint) so screen readers announce them with the field.
 */
export const Field = forwardRef<HTMLInputElement, FieldProps>(function Field(
  { label, error, id, name, labelAside, trailing, hint, className, ...props },
  ref,
) {
  const inputId = id ?? name;
  const errorId = `${inputId}-error`;
  const hintId = `${inputId}-hint`;
  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(' ');
  return (
    <div className="grid gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor={inputId}>{label}</Label>
        {labelAside}
      </div>
      <div className="relative">
        <Input
          id={inputId}
          name={name}
          ref={ref}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy || undefined}
          className={cn(
            authInputClass,
            error ? 'border-destructive' : null,
            trailing ? 'pr-12' : null,
            className,
          )}
          {...props}
        />
        {trailing ? (
          <div className="absolute inset-y-0 right-0 flex items-center">{trailing}</div>
        ) : null}
      </div>
      {hint ? <div id={hintId}>{hint}</div> : null}
      {error ? (
        <p id={errorId} role="alert" className={cn('text-sm font-medium', authErrorTextClass)}>
          {error}
        </p>
      ) : null}
    </div>
  );
});
