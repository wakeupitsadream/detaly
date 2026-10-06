import type { HTMLAttributes } from 'react';
import { cn } from './cn';

/**
 * A price already formatted on the server (OfferView.priceText, formatRub): Manrope 800,
 * tabular digits, ₽ in the same weight, never wrapped. md 24/28 px, `sm` 18/20 px for lines
 * inside a list, `lg` 28/36 px for the cart and order totals.
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
        size === 'sm' && '[--price-size-lg:1.25rem] [--price-size:1.125rem]',
        size === 'lg' && '[--price-size-lg:2.25rem] [--price-size:1.75rem]',
        className,
      )}
      {...rest}
    />
  );
}
