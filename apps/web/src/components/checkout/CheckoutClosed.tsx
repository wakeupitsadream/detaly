import { telHref } from '@/server/brand';

/**
 * Checkout before Roskomnadzor registration or without published documents (decision Д4):
 * the gate's text and the point's phone, and no form at all, so no personal data is collected.
 */
export function CheckoutClosed({ message, phone }: { message: string; phone: string | null }) {
  return (
    <section
      className="space-y-3 rounded-card border border-line bg-card p-6"
      data-testid="checkout-closed"
    >
      <h2 className="text-lg font-semibold">Оформление на сайте пока закрыто</h2>
      <p className="text-muted">{message}</p>
      {phone ? (
        <a
          href={telHref(phone)}
          className="inline-flex h-11 items-center rounded-xl bg-accent px-5 font-semibold whitespace-nowrap text-white hover:bg-accent-strong"
        >
          Позвонить {phone}
        </a>
      ) : null}
      <p>
        <a className="text-sm underline" href="/cart">
          Вернуться в корзину
        </a>
      </p>
    </section>
  );
}
