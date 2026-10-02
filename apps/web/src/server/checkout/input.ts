/**
 * Body of POST /api/checkout (docs/phase-1a-implementation.md section 6.2). Unknown fields are
 * dropped. Hidden technical fields (part, expectedTotalKop, itemsHash, checkoutKey) that are
 * malformed mean a broken or forged client: 400. Fields the client types or ticks get Russian
 * messages per field: 422 `consent_required` when the offer or the PD consent is not accepted
 * (an order without consent is impossible), otherwise 422 `validation`.
 */
import { NOTIFICATION_CHANNELS, normalizePhone, type CartPart } from '@detaly/domain';
import type { NotificationChannel } from '@detaly/domain';
import { z } from 'zod';
import { ITEMS_HASH_RE } from './hash';

export const CART_PARTS = ['all', 'local', 'order'] as const satisfies readonly CartPart[];

/** Longest client name stored in users.name. */
export const MAX_NAME_LENGTH = 60;

export const FIELD_MESSAGES = {
  phone: 'Введите российский номер: +7 или 8 и 10 цифр, например 8 912 345-67-89',
  name: `Укажите имя — до ${MAX_NAME_LENGTH} символов`,
  channel: 'Выберите, куда присылать статусы заказа',
  acceptOffer: 'Нужно принять условия оферты',
  consentPd: 'Без согласия на обработку персональных данных оформить заказ нельзя',
} as const;

export type CheckoutField = keyof typeof FIELD_MESSAGES;

export interface CheckoutInput {
  part: CartPart;
  /** E.164, normalized. */
  phone: string;
  name: string;
  channel: NotificationChannel;
  consentMarketing: boolean;
  expectedTotalKop: number;
  itemsHash: string;
  checkoutKey: string;
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

export function parseCheckoutInput(body: unknown): CheckoutInputResult {
  const tech = technical.safeParse(body);
  if (!tech.success) return { ok: false, status: 400, error: 'bad_request' };
  // technical.safeParse succeeded, so the body is a plain object.
  const raw = body as Record<string, unknown>;

  const fields: Partial<Record<CheckoutField, string>> = {};
  const phone = typeof raw.phone === 'string' ? normalizePhone(raw.phone) : null;
  if (phone === null) fields.phone = FIELD_MESSAGES.phone;
  const name = cleanName(raw.name);
  if (name === null) fields.name = FIELD_MESSAGES.name;
  const channel = isChannel(raw.channel) ? raw.channel : null;
  if (channel === null) fields.channel = FIELD_MESSAGES.channel;
  if (raw.acceptOffer !== true) fields.acceptOffer = FIELD_MESSAGES.acceptOffer;
  if (raw.consentPd !== true) fields.consentPd = FIELD_MESSAGES.consentPd;

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
      phone,
      name,
      channel,
      consentMarketing: raw.consentMarketing === true,
    },
  };
}
