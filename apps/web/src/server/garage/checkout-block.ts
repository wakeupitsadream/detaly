/**
 * The «Моя машина» block of the demo checkout (step 6, docs/garage.md): GARAGE_ENABLED is off on
 * the demo by default; switched on there, the block renders over a sample car and, like every
 * field of the demo form, sends nothing (the demo button submits an empty separate form and
 * POST /api/checkout answers 403 in the demo). Off: no block.
 */
import type { Env } from '@detaly/config';
import { DEMO_VEHICLE_EXAMPLE, type VehicleFormValues } from '@/lib/vehicle-form';

export function demoVehicleBlock(
  env: Pick<Env, 'GARAGE_ENABLED'>,
): { prefill: null; demoValues: VehicleFormValues } | null {
  return env.GARAGE_ENABLED ? { prefill: null, demoValues: DEMO_VEHICLE_EXAMPLE } : null;
}
