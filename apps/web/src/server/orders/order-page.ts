/**
 * Everything /o/<token> shows about the order, read from one snapshot (readSnapshot: REPEATABLE
 * READ, READ ONLY): the order view (order-view.ts) and the phase 1C blocks next to it
 * (order-services.ts). The blocks are derived from the view (its status, items and money), so
 * they read the same snapshot: a payment, claim or binding committed while the page loads is
 * either in all of them or in none.
 *
 * The 1C blocks keep their own failure rule: they read inside a savepoint, and a failure rolls
 * back to it and hides only the blocks (EMPTY_SERVICES), never the order.
 */
import { readSnapshot, type Executor } from '@detaly/db';
import {
  EMPTY_SERVICES,
  loadOrderServices,
  type LoadOrderServicesOptions,
  type OrderServicesView,
} from './order-services';
import { loadOrderView, type LoadOrderViewOptions, type OrderView } from './order-view';

export interface OrderPageData {
  view: OrderView;
  services: OrderServicesView;
}

export interface LoadOrderPageOptions {
  view: LoadOrderViewOptions;
  /**
   * Options of the 1C blocks, built when the view is loaded: a failure to build them (the photo
   * store's configuration) hides the blocks like a failed read.
   */
  services: () => LoadOrderServicesOptions;
  /** The 1C blocks failed (they are hidden): the page logs a warning. */
  onServicesError?: (error: unknown) => void;
}

/** The order of this link token with its 1C blocks, or null for an unknown token. */
export async function loadOrderPage(
  db: Executor,
  token: string,
  options: LoadOrderPageOptions,
): Promise<OrderPageData | null> {
  return readSnapshot(db, async (tx) => {
    const view = await loadOrderView(tx, token, options.view);
    if (view === null) return null;
    let services: OrderServicesView;
    try {
      const servicesOptions = options.services();
      // A savepoint: a failed read here rolls back to it, and the snapshot stays usable.
      services = await tx.transaction((blocks) => loadOrderServices(blocks, view, servicesOptions));
    } catch (error) {
      options.onServicesError?.(error);
      services = EMPTY_SERVICES;
    }
    return { view, services };
  });
}
