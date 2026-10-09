import { IconShield } from '@/components/icons';
import { cn } from '@/components/ui/cn';
import { telHref } from '@/server/brand';
import { fitClosedText } from '@/server/fit-checks/texts';
import { FitClosed } from './FitClosed';
import { FitSheet } from './FitSheet';

// One line in the 13.5rem column of a desktop card: 14 px and no side padding from lg.
const LINK =
  'inline-flex min-h-12 w-full min-w-0 items-center justify-center gap-2 rounded-control px-2 ' +
  'text-[0.9375rem] leading-tight font-semibold whitespace-nowrap text-brand underline ' +
  'decoration-1 underline-offset-4 hover:text-brand-hover hover:decoration-2 ' +
  'lg:gap-1.5 lg:px-0 lg:text-sm';

/**
 * «Проверить под мою машину» on an offer card (step 4, docs/fit-check.md): adds the offer to the
 * cart and opens the cart with the fit check form of its line. A plain form post to
 * /api/cart/items with `then=check` (works without JavaScript: 303 -> /cart?check=<line id>).
 * While the checkout gate is closed there is no cart: the same words open a sheet that says
 * checks open together with online orders and gives the phone (as the closed /vin).
 */
export function FitSearchLink({
  q,
  offerId,
  qty,
  title,
  open,
  phone,
  className,
}: {
  /** Normalized article of the search query. */
  q: string;
  offerId: string;
  qty: number;
  /** Brand and article for the accessible name. */
  title: string;
  /** The checkout gate is open (the offer can go to the cart). */
  open: boolean;
  phone: string | null;
  className?: string;
}) {
  if (!open) {
    return (
      <div className={cn('min-w-0', className)}>
        <FitSheet
          title="Проверим, подойдёт ли"
          triggerLabel="Проверить под мою машину"
          triggerIcon={<IconShield size={20} className="shrink-0" />}
          triggerVariant="ghost"
          triggerClassName="w-full text-[0.9375rem]"
          testId="fit-search"
        >
          <FitClosed
            message={fitClosedText(phone)}
            phone={phone ? { text: phone, href: telHref(phone) } : null}
          />
        </FitSheet>
      </div>
    );
  }
  return (
    <form
      method="post"
      action="/api/cart/items"
      className={cn('min-w-0', className)}
      data-testid="fit-search-form"
    >
      <input type="hidden" name="q" value={q} />
      <input type="hidden" name="offerId" value={offerId} />
      <input type="hidden" name="qty" value={qty} />
      <input type="hidden" name="then" value="check" />
      <button
        type="submit"
        className={LINK}
        aria-label={`Проверить под мою машину: ${title}`}
        data-testid="fit-search"
      >
        <IconShield size={18} className="shrink-0" />
        Проверить под мою машину
      </button>
    </form>
  );
}
