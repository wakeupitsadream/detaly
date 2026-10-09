/**
 * The «Моя машина» block of the checkout (step 6, docs/garage.md) as the form holds it: plain
 * strings as typed, the names of the inputs and of their errors. Shared by the client form and
 * the server (page data, POST /api/checkout); nothing here imports server code.
 */
import type { VehicleField } from '@detaly/domain';

export interface VehicleFormValues {
  make: string;
  model: string;
  engine: string;
  year: string;
  vin: string;
  mileage: string;
}

export const EMPTY_VEHICLE_FORM: VehicleFormValues = {
  make: '',
  model: '',
  engine: '',
  year: '',
  vin: '',
  mileage: '',
};

/** The 422 field of a vehicle error (the keys of `fields` next to phone, name, …). */
export type VehicleFormField =
  | 'vehicleMake'
  | 'vehicleModel'
  | 'vehicleEngine'
  | 'vehicleYear'
  | 'vehicleVin'
  | 'vehicleMileage';

export const VEHICLE_FORM_FIELD: Readonly<Record<VehicleField, VehicleFormField>> = {
  make: 'vehicleMake',
  model: 'vehicleModel',
  engine: 'vehicleEngine',
  year: 'vehicleYear',
  vin: 'vehicleVin',
  mileage: 'vehicleMileage',
};

/** Where the block's values came from (the cart's own context, never a lookup by phone). */
export type VehiclePrefillSource = 'kit' | 'proposal' | 'bot';

/** What the page fills the block with. */
export interface VehiclePrefillView {
  source: VehiclePrefillSource;
  values: VehicleFormValues;
  /**
   * «Купить снова»: the stored car's VIN is never put back into a page; its last 4 characters
   * say it is kept ('…4567'), null without a VIN.
   */
  vinHint: string | null;
}

/** The sample of DEMO_MODE (a demo kit's car, no VIN): the block renders, nothing is sent. */
export const DEMO_VEHICLE_EXAMPLE: VehicleFormValues = {
  make: 'Lada',
  model: 'Vesta',
  engine: '1.6',
  year: '2019',
  vin: '',
  mileage: '',
};

/** True when no field holds anything. */
export function isEmptyVehicleForm(values: VehicleFormValues): boolean {
  return Object.values(values).every((value) => value.trim() === '');
}

/** «Lada Vesta 1.6, 2019» of what the block holds (the summary line of the folded block). */
export function vehicleFormLabel(values: VehicleFormValues): string {
  const name = [values.make, values.model, values.engine]
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .join(' ');
  const year = values.year.trim();
  if (name === '') return '';
  return year === '' ? name : `${name}, ${year}`;
}
