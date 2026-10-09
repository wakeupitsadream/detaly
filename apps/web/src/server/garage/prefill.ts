/**
 * What the «Моя машина» block of the checkout is filled with (step 6, docs/garage.md): only the
 * cart's own context, never a lookup of the client's cars by a typed phone (that would show a
 * stranger's car to whoever types a number). In this order:
 *
 * 1. `bot` — the cart came from a «Купить снова» proposal (carts.repeat_order_id): the car of the
 *    repeated order. Its VIN is not put back into the page, only its last 4 characters as a hint;
 *    the merge rules keep it on the stored car;
 * 2. `proposal` — the cart came from the master's proposal of a VIN request: the VIN and the
 *    «Марка и модель» the client typed there, read by parseCarText (no known make or no model:
 *    no prefill — a field the client never typed must not make the order fail);
 * 3. `kit` — «Весь набор в корзину» filled it (carts.kit_id): the kit's make, model and engine.
 *
 * Only with GARAGE_ENABLED (the callers check it).
 */
import { carts, eq, kits, orders, userVehicles, vinRequests, type Executor } from '@detaly/db';
import {
  parseCarText,
  vinTail,
  type IsoDate,
  type VehicleData,
  type VehicleSource,
} from '@detaly/domain';
import { CAR_MAKES, carMakeName } from '@/lib/brands';
import { EMPTY_VEHICLE_FORM, type VehiclePrefillView } from '@/lib/vehicle-form';

/** The prefill with the identity the checkout compares the submitted car with. */
export interface VehiclePrefill extends VehiclePrefillView {
  identity: Pick<VehicleData, 'makeSlug' | 'make' | 'model'> & { source: VehicleSource };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The engine of a kit as a car field: the part before the comma («1.6 16V, 106 л.с.» -> «1.6 16V»). */
export function kitEngine(engine: string): string {
  return (engine.split(',')[0] ?? '').trim();
}

export async function loadVehiclePrefill(
  db: Executor,
  cartId: string,
  today: IsoDate,
): Promise<VehiclePrefill | null> {
  if (!UUID_RE.test(cartId)) return null;
  const [cart] = await db
    .select({
      kitId: carts.kitId,
      vinRequestId: carts.vinRequestId,
      repeatOrderId: carts.repeatOrderId,
    })
    .from(carts)
    .where(eq(carts.id, cartId));
  if (!cart) return null;

  if (cart.repeatOrderId !== null) {
    const [row] = await db
      .select({ vehicle: userVehicles })
      .from(orders)
      .innerJoin(userVehicles, eq(userVehicles.id, orders.vehicleId))
      .where(eq(orders.id, cart.repeatOrderId));
    if (row) {
      const { vehicle } = row;
      return {
        source: 'bot',
        values: {
          ...EMPTY_VEHICLE_FORM,
          make: vehicle.make,
          model: vehicle.model,
          engine: vehicle.engine ?? '',
          year: vehicle.year === null ? '' : String(vehicle.year),
        },
        vinHint: vehicle.vin === null ? null : vinTail(vehicle.vin),
        identity: {
          makeSlug: vehicle.makeSlug,
          make: vehicle.make,
          model: vehicle.model,
          source: 'bot',
        },
      };
    }
  }

  if (cart.vinRequestId !== null) {
    const [request] = await db
      .select({ vin: vinRequests.vin, carText: vinRequests.carText })
      .from(vinRequests)
      .where(eq(vinRequests.id, cart.vinRequestId));
    const car = request ? parseCarText(request.carText, CAR_MAKES, today) : null;
    if (request && car !== null) {
      return {
        source: 'proposal',
        values: {
          ...EMPTY_VEHICLE_FORM,
          make: car.make,
          model: car.model,
          engine: car.engine ?? '',
          year: car.year === null ? '' : String(car.year),
          vin: request.vin ?? '',
        },
        vinHint: null,
        identity: { makeSlug: car.makeSlug, make: car.make, model: car.model, source: 'proposal' },
      };
    }
  }

  if (cart.kitId !== null) {
    const [kit] = await db
      .select({ makeSlug: kits.makeSlug, model: kits.model, engine: kits.engine })
      .from(kits)
      .where(eq(kits.id, cart.kitId));
    if (kit) {
      const make = carMakeName(kit.makeSlug) ?? kit.makeSlug;
      return {
        source: 'kit',
        values: {
          ...EMPTY_VEHICLE_FORM,
          make,
          model: kit.model,
          engine: kitEngine(kit.engine),
        },
        vinHint: null,
        identity: { makeSlug: kit.makeSlug, make, model: kit.model, source: 'kit' },
      };
    }
  }
  return null;
}

/** The client-safe part of a prefill (page data: no identity, nothing else). */
export function prefillView(prefill: VehiclePrefill | null): VehiclePrefillView | null {
  if (prefill === null) return null;
  return { source: prefill.source, values: prefill.values, vinHint: prefill.vinHint };
}
