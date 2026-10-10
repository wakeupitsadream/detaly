/**
 * Step 8 (docs/rossko-automation.md): the database side of the pure rules of
 * @detaly/domain/rossko-automation — the settings of the step over their defaults, and the lines
 * of an order as the shadow auto-order sees them (where each part came from: a VIN selection of
 * the master, a fit check the client asked for).
 */
import { eq, fitChecks, inArray, settings, vinRequests, type Executor } from '@detaly/db';
import {
  AUTO_ORDER_MAX_TOTAL_KEY,
  resolveRosskoAutomationSettings,
  ROSSKO_CUTOFF_TIMES_KEY,
  ROSSKO_ORDER_WITHIN_KEY,
  ROSSKO_POLL_ENABLED_KEY,
  ROSSKO_STATUS_MAP_KEY,
  samePart,
  type AutoOrderLine,
  type FitPart,
  type RosskoAutomationSettings,
} from '@detaly/domain';
import { isLiveState } from './context';
import type { OrderItemRow, OrderSnapshot } from './types';

/** The settings keys of step 8. */
export const ROSSKO_SETTINGS_KEYS = [
  ROSSKO_STATUS_MAP_KEY,
  ROSSKO_POLL_ENABLED_KEY,
  ROSSKO_ORDER_WITHIN_KEY,
  AUTO_ORDER_MAX_TOTAL_KEY,
  ROSSKO_CUTOFF_TIMES_KEY,
] as const;

/** `settings` rows of step 8 over the defaults; a malformed value falls back to its default. */
export async function loadRosskoSettings(db: Executor): Promise<RosskoAutomationSettings> {
  const rows = await db
    .select({ key: settings.key, value: settings.value })
    .from(settings)
    .where(inArray(settings.key, [...ROSSKO_SETTINGS_KEYS]));
  return resolveRosskoAutomationSettings(new Map(rows.map((row) => [row.key, row.value])));
}

/**
 * The live lines of the order for shouldAutoOrder:
 * - fromVinSelection: the order was checked out from a VIN proposal (orders.vin_request_id) and
 *   the part is one of the `ok` lines of the master's answer (all lines when the answer is gone);
 * - fitCheck: `confirmed` when checkout carried the master's check into the item
 *   (order_items.fit_check_id: «Подходит» about this very part, or his analog the client took);
 *   `unconfirmed` when the order's cart had a check about this part (or with it as the analog)
 *   that did not end in such a confirmation — no answer, «Не подходит», «Нужен звонок», the analog
 *   offered but the part kept; null when nobody asked.
 */
export async function loadAutoOrderLines(
  db: Executor,
  snapshot: Pick<OrderSnapshot, 'order' | 'items'>,
): Promise<AutoOrderLine[]> {
  const { order } = snapshot;
  const live = snapshot.items.filter((item) => isLiveState(item.state));

  let vinParts: FitPart[] | null = null;
  if (order.vinRequestId !== null) {
    const [request] = await db
      .select({ preview: vinRequests.preview })
      .from(vinRequests)
      .where(eq(vinRequests.id, order.vinRequestId));
    const lines = request?.preview?.lines ?? null;
    vinParts =
      lines === null
        ? null
        : lines.flatMap((line) =>
            line.status === 'ok' ? [{ brand: line.brand, article: line.article }] : [],
          );
  }

  const checks =
    order.cartId === null
      ? []
      : await db
          .select({
            brand: fitChecks.brand,
            article: fitChecks.article,
            analogBrand: fitChecks.analogBrand,
            analogArticle: fitChecks.analogArticle,
          })
          .from(fitChecks)
          .where(eq(fitChecks.cartId, order.cartId));

  const asked = (item: OrderItemRow): boolean => {
    const part = { brand: item.brand, article: item.article };
    return checks.some(
      (check) =>
        samePart(check, part) ||
        (check.analogBrand !== null &&
          check.analogArticle !== null &&
          samePart({ brand: check.analogBrand, article: check.analogArticle }, part)),
    );
  };

  return live.map((item) => {
    const part = { brand: item.brand, article: item.article };
    const fromVinSelection =
      order.vinRequestId !== null &&
      (vinParts === null || vinParts.some((vinPart) => samePart(vinPart, part)));
    const fitCheck = item.fitCheckId !== null ? 'confirmed' : asked(item) ? 'unconfirmed' : null;
    return {
      orderItemId: item.id,
      qty: item.qty,
      priceClientKop: item.priceClientKop,
      fromVinSelection,
      fitCheck,
    };
  });
}
