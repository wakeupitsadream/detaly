/**
 * Body of POST /api/checkout (docs/phase-1a-implementation.md section 6.2). Unknown fields are
 * dropped. Hidden technical fields (part, expectedTotalKop, itemsHash, checkoutKey, the ids of
 * the document versions shown, the expected scheme and promised date) that are
 * malformed mean a broken or forged client: 400. Fields the client types or ticks get Russian
 * messages per field: 422 `consent_required` when the offer or the PD consent is not accepted
 * (an order without consent is impossible), otherwise 422 `validation`.
 *
 * Step 6 (docs/garage.md): `vehicle` {make, model, engine, year, vin, mileage} of the optional
 * «Моя машина» block is read only when the caller passes `garage` (GARAGE_ENABLED); otherwise it
 * is dropped like any unknown field, whatever it holds. Blank everywhere: no car. A typed car
 * needs the make and the model; its errors are 422 `validation` on `vehicle<Field>`.
 */
import {
  isIsoDate,
  NOTIFICATION_CHANNELS,
  normalizeMobilePhone,
  parseVehicleInput,
  PAYMENT_SCHEMES,
  type CarMake,
  type CartPart,
  type IsoDate,
  type NotificationChannel,
  type PaymentScheme,
  type VehicleData,
  type VehicleField,
} from '@detaly/domain';
import { z } from 'zod';
import { VEHICLE_FORM_FIELD, type VehicleFormField } from '@/lib/vehicle-form';
import { ITEMS_HASH_RE } from './hash';

export const CART_PARTS = ['all', 'local', 'order'] as const satisfies readonly CartPart[];

/** Longest client name stored in users.name. */
export const MAX_NAME_LENGTH = 60;

export const FIELD_MESSAGES = {
  phone: 'Введите мобильный номер: +7 или 8 и 10 цифр, например 8 912 345-67-89',
  name: `Укажите имя — до ${MAX_NAME_LENGTH} символов`,
  channel: 'Выберите, куда присылать статусы заказа',
  acceptOffer: 'Нужно принять условия оферты',
  consentPd: 'Без согласия на обработку персональных данных оформить заказ нельзя',
} as const;

export type CheckoutField = keyof typeof FIELD_MESSAGES | VehicleFormField;

export interface CheckoutInput {
  part: CartPart;
  /** document_versions.id of the offer shown on the rendered page. */
  offerVersionId: string;
  /** document_versions.id of the PD consent shown on the rendered page. */
  consentPdVersionId: string;
  /** document_versions.id of the marketing consent shown, null when there was none. */
  consentMarketingVersionId: string | null;
  /** Scheme shown on the page (no-shows counted as 0); the server's must match (409). */
  expectedScheme: PaymentScheme;
  /** promisedDate shown on the page; a later fresh date is a 409, an earlier one is fine. */
  expectedPromisedDate: IsoDate | null;
  /** E.164, normalized. */
  phone: string;
  name: string;
  channel: NotificationChannel;
  consentMarketing: boolean;
  expectedTotalKop: number;
  itemsHash: string;
  checkoutKey: string;
  /**
   * Step 6: the car of the «Моя машина» block (null when blank). Absent without GARAGE_ENABLED:
   * the parsed input is then exactly what it was before the step.
   */
  vehicle?: VehicleData | null;
}

/** GARAGE_ENABLED: the makes the block's make is matched against and the client's today. */
export interface CheckoutGarageOptions {
  makes: readonly CarMake[];
  today: IsoDate;
}

export type CheckoutInputResult =
  | { ok: true; input: CheckoutInput }
  | { ok: false; status: 400; error: 'bad_request' }
  | {
      ok: false;
      status: 422;
      error: 'validation' | 'consent_required';
      fields: Partial<Record<CheckoutField, string>>;
    };

const technical = z.object({
  part: z.enum(CART_PARTS).default('all'),
  expectedTotalKop: z.int().min(0).max(2_147_483_647),
  itemsHash: z.string().regex(ITEMS_HASH_RE),
  checkoutKey: z.uuid(),
  offerVersionId: z.uuid(),
  consentPdVersionId: z.uuid(),
  consentMarketingVersionId: z.uuid().nullable(),
  expectedScheme: z.enum(PAYMENT_SCHEMES),
  expectedPromisedDate: z.string().refine(isIsoDate).nullable(),
});

/** Name as stored: control characters removed, whitespace collapsed, trimmed. */
export function cleanName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const clean = value
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (clean.length === 0 || clean.length > MAX_NAME_LENGTH || !/\p{L}/u.test(clean)) return null;
  return clean;
}

function isChannel(value: unknown): value is NotificationChannel {
  return typeof value === 'string' && (NOTIFICATION_CHANNELS as readonly string[]).includes(value);
}

export function parseCheckoutInput(
  body: unknown,
  options: { garage?: CheckoutGarageOptions | null } = {},
): CheckoutInputResult {
  const tech = technical.safeParse(body);
  if (!tech.success) return { ok: false, status: 400, error: 'bad_request' };
  // technical.safeParse succeeded, so the body is a plain object.
  const raw = body as Record<string, unknown>;

  const fields: Partial<Record<CheckoutField, string>> = {};
  // Mobile (9xx) only: SMS is the fallback channel for confirmations (PLAN), and the last four
  // digits of this number confirm a cancellation.
  const phone = typeof raw.phone === 'string' ? normalizeMobilePhone(raw.phone) : null;
  if (phone === null) fields.phone = FIELD_MESSAGES.phone;
  const name = cleanName(raw.name);
  if (name === null) fields.name = FIELD_MESSAGES.name;
  const channel = isChannel(raw.channel) ? raw.channel : null;
  if (channel === null) fields.channel = FIELD_MESSAGES.channel;
  if (raw.acceptOffer !== true) fields.acceptOffer = FIELD_MESSAGES.acceptOffer;
  if (raw.consentPd !== true) fields.consentPd = FIELD_MESSAGES.consentPd;

  // Step 6: without GARAGE_ENABLED `vehicle` is never read (nothing collected).
  let vehicle: VehicleData | null = null;
  if (options.garage) {
    const parsed = parseVehicleInput(raw.vehicle, options.garage);
    if (parsed.kind === 'ok') vehicle = parsed.vehicle;
    if (parsed.kind === 'invalid') {
      for (const [field, message] of Object.entries(parsed.errors) as [VehicleField, string][]) {
        fields[VEHICLE_FORM_FIELD[field]] = message;
      }
    }
  }

  if (phone === null || name === null || channel === null || Object.keys(fields).length > 0) {
    const consentMissing = fields.acceptOffer !== undefined || fields.consentPd !== undefined;
    return {
      ok: false,
      status: 422,
      error: consentMissing ? 'consent_required' : 'validation',
      fields,
    };
  }
  return {
    ok: true,
    input: {
      ...tech.data,
      expectedPromisedDate: tech.data.expectedPromisedDate as IsoDate | null,
      phone,
      name,
      channel,
      consentMarketing: raw.consentMarketing === true,
      ...(options.garage ? { vehicle } : {}),
    },
  };
}
