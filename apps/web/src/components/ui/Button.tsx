import Link from 'next/link';
import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode } from 'react';
import { cn } from './cn';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'md' | 'lg';

export interface ButtonStyle {
  variant?: ButtonVariant;
  /** md 48 px, lg 52 px (the main action of a screen). */
  size?: ButtonSize;
  /** On the dark panel or the brand header: secondary and ghost switch to white. */
  onDark?: boolean;
  /** Full width. */
  block?: boolean;
}

const BASE =
  'inline-flex min-w-0 select-none items-center justify-center gap-2 rounded-control ' +
  'text-[1.0625rem] leading-tight font-semibold text-center ' +
  'transition-[background-color,color,border-color,transform] duration-150 ' +
  'disabled:cursor-not-allowed aria-disabled:pointer-events-none';

const SIZE: Record<ButtonSize, string> = {
  md: 'min-h-12 px-5',
  lg: 'min-h-13 px-6',
};

/**
 * Primary: the brand fill with white text (6.4:1). Secondary: white with a `line-strong`
 * border. Ghost: brand text. Danger: an outline in the danger colour; a destructive action
 * always says what it does in words too.
 */
function variantClass(variant: ButtonVariant, onDark: boolean): string {
  switch (variant) {
    case 'primary':
      return cn(
        'bg-brand text-on-brand hover:bg-brand-hover active:translate-y-px',
        onDark && 'focus-visible:outline-on-brand',
        'disabled:bg-surface-2 disabled:text-muted',
      );
    case 'secondary':
      return cn(
        'border-[1.5px]',
        onDark
          ? 'border-on-brand/70 text-on-brand hover:border-on-brand hover:bg-on-brand/10 focus-visible:outline-on-brand'
          : 'border-line-strong bg-bg text-ink hover:border-ink hover:bg-surface',
        'disabled:border-line disabled:bg-bg disabled:text-muted',
      );
    case 'ghost':
      return cn(
        'px-2! underline decoration-1 underline-offset-4 hover:decoration-2',
        onDark
          ? 'text-on-brand focus-visible:outline-on-brand'
          : 'text-brand hover:text-brand-hover',
        'disabled:text-muted disabled:no-underline',
      );
    case 'danger':
      return cn(
        'border-[1.5px] border-danger bg-bg text-danger hover:bg-danger-soft',
        'disabled:border-line disabled:text-muted',
      );
  }
}

export function buttonClass({
  variant = 'primary',
  size = 'md',
  onDark = false,
  block = false,
}: ButtonStyle = {}): string {
  return cn(BASE, SIZE[size], variantClass(variant, onDark), block && 'w-full');
}

/** 20 px ring for `pending`: a still arc when motion is reduced. */
export function Spinner({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={20}
      height={20}
      fill="none"
      aria-hidden
      className={cn('shrink-0 animate-spin', className)}
    >
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.3" strokeWidth="2.5" />
      <path
        d="M21 12a9 9 0 0 0-9-9"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function Button({
  variant,
  size,
  onDark,
  block,
  icon,
  pending = false,
  disabledReason,
  className,
  type = 'button',
  disabled,
  children,
  ...rest
}: ButtonStyle &
  ButtonHTMLAttributes<HTMLButtonElement> & {
    /** An icon on the left (20-22 px). */
    icon?: ReactNode;
    /** The action is running: a spinner instead of the icon, the button is disabled. */
    pending?: boolean;
    /** Why the button is disabled, shown next to it (and linked by aria-describedby). */
    disabledReason?: ReactNode;
  }) {
  const reasonId = disabledReason && rest.id ? `${rest.id}-reason` : undefined;
  const button = (
    <button
      type={type}
      disabled={disabled || pending}
      aria-busy={pending || undefined}
      aria-describedby={reasonId}
      className={cn(buttonClass({ variant, size, onDark, block }), className)}
      {...rest}
    >
      {pending ? <Spinner /> : icon}
      {children}
    </button>
  );
  if (!disabledReason || !disabled) return button;
  return (
    <span className={cn('flex min-w-0 flex-col gap-2', block ? 'w-full' : 'items-start')}>
      {button}
      <span id={reasonId} className="text-small text-muted">
        {disabledReason}
      </span>
    </span>
  );
}

/**
 * A link that looks like a button. Internal hrefs go through next/link; `prefetch={false}` for
 * pages that cost something to render (the cart re-prices at the supplier). `external` renders
 * a plain <a> opening in a new tab.
 */
export function ButtonLink({
  href,
  variant,
  size,
  onDark,
  block,
  icon,
  className,
  prefetch,
  external = false,
  children,
  ...rest
}: ButtonStyle &
  Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> & {
    href: string;
    prefetch?: boolean;
    external?: boolean;
    icon?: ReactNode;
    children: ReactNode;
  }) {
  const classes = cn(buttonClass({ variant, size, onDark, block }), className);
  if (external) {
    return (
      <a href={href} className={classes} target="_blank" rel="noopener" {...rest}>
        {icon}
        {children}
      </a>
    );
  }
  return (
    <Link href={href} prefetch={prefetch} className={classes} {...rest}>
      {icon}
      {children}
    </Link>
  );
}
