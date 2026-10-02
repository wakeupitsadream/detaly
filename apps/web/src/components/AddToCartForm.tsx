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
}: {
  /** Normalized article of the search query (cart_items.search_article_norm). */
  q: string;
  /** OfferView.id. */
  offerId: string;
  /** Units to add: the offer's multiplicity. */
  qty: number;
  /** Brand and article for the accessible name. */
  title: string;
}) {
  return (
    <form method="post" action="/api/cart/items" className="min-w-0" data-testid="add-to-cart">
      <input type="hidden" name="q" value={q} />
      <input type="hidden" name="offerId" value={offerId} />
      <input type="hidden" name="qty" value={qty} />
      <button
        type="submit"
        className="inline-flex h-11 min-w-11 items-center justify-center rounded-xl bg-accent px-4 font-semibold whitespace-nowrap text-white hover:bg-accent-strong"
        aria-label={`В корзину: ${title}`}
      >
        В корзину
      </button>
    </form>
  );
}
