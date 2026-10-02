import Link from 'next/link';
import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode } from 'react';
import { cn } from './cn';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'md' | 'lg';

export interface ButtonStyle {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** On graphite sections: secondary and ghost switch to light ink, the hard shadow to paper. */
  onDark?: boolean;
  /** Full width. */
  block?: boolean;
}

const BASE =
  'inline-flex min-w-0 select-none items-center justify-center gap-2 font-semibold leading-tight ' +
  'transition-[background-color,color,box-shadow,transform,border-color] duration-150 ' +
  'disabled:cursor-not-allowed aria-disabled:pointer-events-none';

const SIZE: Record<ButtonSize, string> = {
  md: 'min-h-11 px-5 text-[0.9375rem]',
  lg: 'min-h-13 px-7 text-base',
};

/**
 * Primary: signal orange with ink text (white on orange fails AA), a hard 3px shadow on hover
 * like a stamped plate, pressed in on active. The focus ring is ink on orange.
 */
function variantClass(variant: ButtonVariant, onDark: boolean): string {
  switch (variant) {
    case 'primary':
      return cn(
        'rounded bg-accent text-ink hover:bg-accent-hover hover:-translate-x-px hover:-translate-y-px',
        onDark
          ? 'hover:shadow-[3px_3px_0_var(--color-paper)]'
          : 'hover:shadow-[3px_3px_0_var(--color-ink)]',
        'active:translate-x-px active:translate-y-px active:shadow-none focus-visible:outline-ink',
        onDark && 'focus-visible:outline-paper',
        'disabled:translate-0 disabled:bg-paper-2 disabled:text-faint disabled:shadow-none',
      );
    case 'secondary':
      return cn(
        'rounded border-[1.5px]',
        onDark
          ? 'border-paper text-paper hover:bg-paper hover:text-ink'
          : 'border-ink text-ink hover:bg-ink hover:text-paper',
        'disabled:border-line disabled:bg-transparent disabled:text-faint',
      );
    case 'ghost':
      return cn(
        'px-0! underline decoration-1 underline-offset-4 hover:decoration-2',
        onDark ? 'text-paper' : 'text-ink',
        'disabled:text-faint disabled:no-underline',
      );
    case 'danger':
      return cn(
        'rounded border-[1.5px] border-danger text-danger hover:bg-danger hover:text-card',
        'disabled:border-line disabled:bg-transparent disabled:text-faint',
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

export function Button({
  variant,
  size,
  onDark,
  block,
  className,
  type = 'button',
  ...rest
}: ButtonStyle & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type={type}
      className={cn(buttonClass({ variant, size, onDark, block }), className)}
      {...rest}
    />
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
    children: ReactNode;
  }) {
  const classes = cn(buttonClass({ variant, size, onDark, block }), className);
  if (external) {
    return (
      <a href={href} className={classes} target="_blank" rel="noopener" {...rest}>
        {children}
      </a>
    );
  }
  return (
    <Link href={href} prefetch={prefetch} className={classes} {...rest}>
      {children}
    </Link>
  );
}
