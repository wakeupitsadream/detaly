import { formatRub, type LineChange } from '@detaly/domain';
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

/**
 * What changed in the cart since the client last saw it (repricing on open or a 409 from
 * checkout). With no line changes but `cartChanged` (e.g. a stale total) it shows a general
 * notice; with nothing to say it renders nothing.
 */
export function DiffBanner({
  changes,
  cartChanged = false,
}: {
  changes: readonly LineChange[];
  cartChanged?: boolean;
}) {
  if (changes.length === 0 && !cartChanged) return null;
  return (
    <Notice tone="wait" role="status" data-testid="diff-banner">
      {changes.length === 0 ? (
        <p>{CART_CHANGED_TEXT}</p>
      ) : (
        <ul className="space-y-1">
          {changes.map((change) => (
            <li key={`${change.kind}:${change.lineId}`}>{describeChange(change)}</li>
          ))}
        </ul>
      )}
    </Notice>
  );
}
