import type { ReactNode } from 'react';
import { IconAlert } from '@/components/icons';
import { cn } from './cn';

/** ids for aria-describedby of the control inside a Field. */
export function fieldDescribedBy(
  id: string,
  { hint, error }: { hint?: ReactNode; error?: ReactNode },
): string | undefined {
  const ids = [hint ? `${id}-hint` : null, error ? `${id}-error` : null].filter(Boolean);
  return ids.length > 0 ? ids.join(' ') : undefined;
}

/**
 * Label above, hint and error below. The control is passed as children and wires itself with
 * `id={id}` and `aria-describedby={fieldDescribedBy(id, { hint, error })}`.
 */
export function Field({
  id,
  label,
  hint,
  error,
  className,
  children,
}: {
  id: string;
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn('min-w-0', className)}>
      <label htmlFor={id} className="mb-1.5 block text-sm font-medium text-ink">
        {label}
      </label>
      {children}
      {hint ? (
        <p id={`${id}-hint`} className="mt-1.5 text-sm text-muted">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={`${id}-error`} className="mt-1.5 flex items-start gap-1.5 text-sm text-danger">
          <IconAlert size={16} className="mt-0.5 shrink-0" />
          <span className="min-w-0">{error}</span>
        </p>
      ) : null}
    </div>
  );
}
