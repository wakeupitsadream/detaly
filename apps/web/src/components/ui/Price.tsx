import type { HTMLAttributes } from 'react';
import { cn } from './cn';

/**
 * A price already formatted on the server (OfferView.priceText, formatRub): Unbounded 600,
 * tabular digits, never wrapped. `lg` for the cart and order totals.
 */
export function Price({
  size = 'md',
  className,
  ...rest
}: { size?: 'sm' | 'md' | 'lg' } & HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn(
        'text-price',
        size === 'sm' && '[--price-size:1.25rem]',
        size === 'lg' && '[--price-size:2rem]',
        className,
      )}
      {...rest}
    />
  );
}
