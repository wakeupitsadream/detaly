'use client';

import { useEffect, useState } from 'react';
import { IconMinus, IconPlus } from '@/components/icons';
import { buttonClass } from '@/components/ui/Button';
import { cn } from '@/components/ui/cn';

const ROUND =
  'grid size-11 shrink-0 place-items-center rounded-full text-brand transition-colors duration-150 ' +
  'hover:bg-surface disabled:cursor-not-allowed disabled:text-faint disabled:hover:bg-transparent';

/**
 * Quantity of a cart line (docs/design-v2.md, «Корзина»): «−» and «+» are round 44 px buttons,
 * each the submit button of its own hidden form (`form=` attribute) that posts the next
 * quantity; the number in the middle is a real field of the main form for typing any amount.
 * Everything is a plain POST to /api/cart/items/<id> with `_method=patch`, so it works without
 * JavaScript. «Изменить» applies a typed number: always shown without JavaScript, with it only
 * once the number differs from the cart.
 */
export function QtyStepper({
  action,
  lineId,
  qty,
  step,
  maxQty,
  title,
}: {
  action: string;
  lineId: string;
  qty: number;
  step: number;
  maxQty: number;
  /** «Knecht OC 90»: names the field and the buttons for a screen reader. */
  title: string;
}) {
  const [value, setValue] = useState(String(qty));
  const [enhanced, setEnhanced] = useState(false);
  useEffect(() => setEnhanced(true), []);
  useEffect(() => setValue(String(qty)), [qty]);

  const inputId = `qty-${lineId}`;
  const decId = `qty-dec-${lineId}`;
  const incId = `qty-inc-${lineId}`;
  const less = qty - step;
  const more = qty + step;
  const showApply = !enhanced || value !== String(qty);

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-2">
      <form id={decId} method="post" action={action} hidden>
        <input type="hidden" name="_method" value="patch" />
        <input type="hidden" name="qty" value={less} />
      </form>
      <form id={incId} method="post" action={action} hidden>
        <input type="hidden" name="_method" value="patch" />
        <input type="hidden" name="qty" value={more} />
      </form>
      <form method="post" action={action} className="flex min-w-0 items-center gap-2">
        <input type="hidden" name="_method" value="patch" />
        {/* faint: the frame of a control holds 3:1 (docs/design-v2.md, «Форма»). */}
        <div className="flex items-center rounded-full border-[1.5px] border-faint bg-bg">
          <button
            type="submit"
            form={decId}
            disabled={less < step}
            className={ROUND}
            aria-label={`Меньше: ${title}`}
          >
            <IconMinus size={22} strokeWidth={2} />
          </button>
          <label className="sr-only" htmlFor={inputId}>
            Количество: {title}
          </label>
          <input
            id={inputId}
            type="number"
            name="qty"
            inputMode="numeric"
            min={step}
            max={maxQty}
            step={step}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            required
            className={cn(
              'h-11 w-12 min-w-0 bg-transparent text-center text-[1.1875rem] font-bold text-ink tabular-nums',
              'appearance-none focus-visible:rounded-control focus-visible:outline-3 focus-visible:outline-brand',
              '[&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none',
              '[-moz-appearance:textfield]',
            )}
          />
          <button
            type="submit"
            form={incId}
            disabled={more > maxQty}
            className={ROUND}
            aria-label={`Больше: ${title}`}
          >
            <IconPlus size={22} strokeWidth={2} />
          </button>
        </div>
        {showApply ? (
          <button type="submit" className={buttonClass({ variant: 'ghost' })}>
            Изменить
          </button>
        ) : null}
      </form>
    </div>
  );
}
