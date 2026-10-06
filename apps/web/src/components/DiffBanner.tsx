import { formatRub, type LineChange } from '@detaly/domain';
import { plural } from '@/lib/plural';
import { IconChevronDown } from './icons';
import { Notice } from './page/Notice';

/** Signed per-unit price delta: '+53 ₽', '−120 ₽'. */
export function formatDelta(deltaKop: number): string {
  const sign = deltaKop < 0 ? '−' : '+';
  return `${sign}${formatRub(Math.abs(deltaKop))}`;
}

/** One sentence per change (also used by tests and API error bodies). */
export function describeChange(change: LineChange): string {
  switch (change.kind) {
    case 'price':
      return `Цена изменилась: ${change.title} ${formatDelta(change.deltaKop)}`;
    case 'qty':
      return `Осталось меньше: ${change.title} — теперь ${change.newQty} шт.`;
    case 'unavailable':
      return `Больше нет в наличии: ${change.title} — убрали из корзины`;
    case 'excluded':
      return `Не продаём онлайн: ${change.title} — убрали из корзины`;
  }
}

export const CART_CHANGED_TEXT = 'Корзина изменилась — проверьте состав и сумму';

/** «Корзина изменилась: 3 изменения» — the one line over several changes. */
function changesHeadline(count: number): string {
  return `Корзина изменилась: ${count} ${plural(count, 'изменение', 'изменения', 'изменений')}`;
}

/**
 * What changed in the cart since the client last saw it (repricing on open or a 409 from
 * checkout), as one line (docs/design-v2.md, «Корзина»): a single change is that line; several
 * are a headline with the list under a disclosure. With no line changes but `cartChanged` (e.g.
 * a stale total) it shows a general notice; with nothing to say it renders nothing.
 */
export function DiffBanner({
  changes,
  cartChanged = false,
}: {
  changes: readonly LineChange[];
  cartChanged?: boolean;
}) {
  if (changes.length === 0 && !cartChanged) return null;
  const items = changes.map((change) => (
    <li key={`${change.kind}:${change.lineId}`}>{describeChange(change)}</li>
  ));
  return (
    <Notice tone="wait" role="status" data-testid="diff-banner">
      {changes.length === 0 ? (
        <p>{CART_CHANGED_TEXT}</p>
      ) : changes.length === 1 ? (
        <ul>{items}</ul>
      ) : (
        <details className="details-plain group">
          <summary className="-my-2.5 flex min-h-11 items-center justify-between gap-3 font-semibold">
            <span className="min-w-0">{changesHeadline(changes.length)}</span>
            <IconChevronDown
              size={22}
              className="shrink-0 transition-transform duration-150 group-open:rotate-180"
            />
          </summary>
          <ul className="mt-2 space-y-1">{items}</ul>
        </details>
      )}
    </Notice>
  );
}
