import { IconCart } from './icons';
import { buttonClass } from './ui/Button';
import { cn } from './ui/cn';

/**
 * "В корзину" on a search row: a plain form POST to /api/cart/items (works without
 * JavaScript, answers 303 → /cart). The client sends the query article, the offer id and the
 * quantity step — never a price.
 */
export function AddToCartForm({
  q,
  offerId,
  qty,
  title,
  className,
}: {
  /** Normalized article of the search query (cart_items.search_article_norm). */
  q: string;
  /** OfferView.id. */
  offerId: string;
  /** Units to add: the offer's multiplicity. */
  qty: number;
  /** Brand and article for the accessible name. */
  title: string;
  className?: string;
}) {
  return (
    <form
      method="post"
      action="/api/cart/items"
      className={cn('min-w-0', className)}
      data-testid="add-to-cart"
    >
      <input type="hidden" name="q" value={q} />
      <input type="hidden" name="offerId" value={offerId} />
      <input type="hidden" name="qty" value={qty} />
      <button
        type="submit"
        className={cn(buttonClass({ variant: 'primary', block: true }), 'h-11 whitespace-nowrap')}
        aria-label={`В корзину: ${title}`}
      >
        <IconCart size={19} strokeWidth={2} />В корзину
      </button>
    </form>
  );
}
