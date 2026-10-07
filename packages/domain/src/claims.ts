/**
 * Client claims (PLAN section 3, row «Претензия»; docs/phase-1c-implementation.md decisions
 * С7–С10). Pure: the clock and the zone are passed in.
 *
 * Terms:
 * - the answer is due 10 days after the claim was opened (art. 22 ЗоЗПП); the database checks
 *   claims.deadline_at = opened_at + 10 days;
 * - refusal of a proper part and «не подошла» — within 7 days after the handover (art. 26.1
 *   ЗоЗПП for distance selling): the period starts the next calendar day in the client's zone
 *   and ends at the end of the 7th day;
 * - a defect may be claimed any time after the handover (the warranty is checked by the master);
 * - a delay — after a handover later than the promised date, or before the handover when the
 *   client's money is held and the order arrived after the promised date (or has not arrived
 *   and the promised date has passed).
 */
import { addDays, CLIENT_TIME_ZONE, localDate } from './dates';
import { REFUSABLE_STATUSES } from './state-machine/transitions';
import type {
  ClaimDecision,
  ClaimKind,
  OrderStatus,
  PaymentScheme,
  RefundReason,
} from './statuses';
import type { IsoDate } from './types';

/** Days to answer a claim (art. 22 ЗоЗПП). */
export const CLAIM_ANSWER_DAYS = 10;
/** Days after the handover to refuse a proper part (art. 26.1 ЗоЗПП). */
export const REFUSAL_DAYS = 7;
/** claims.client_text, characters (CHECK in the database). */
export const CLAIM_TEXT_MAX = 1000;
/** claims.decision_text, characters (CHECK in the database). */
export const CLAIM_DECISION_TEXT_MAX = 2000;
/** Photos the client may attach to a claim. */
export const CLAIM_PHOTOS_MAX = 3;

const DAY_MS = 86_400_000;

/** claims.deadline_at: opened_at + 10 days (exactly 240 hours, as the database checks it). */
export function claimDeadline(openedAt: Date): Date {
  if (!(openedAt instanceof Date) || Number.isNaN(openedAt.getTime())) {
    throw new RangeError('invalid openedAt');
  }
  return new Date(openedAt.getTime() + CLAIM_ANSWER_DAYS * DAY_MS);
}

/** The last calendar day (client zone) to refuse a proper part or claim «не подошла». */
export function refusalLastDay(handedAt: Date, timeZone: string = CLIENT_TIME_ZONE): IsoDate {
  return addDays(localDate(handedAt, timeZone), REFUSAL_DAYS);
}

export interface ClaimKindsInput {
  status: OrderStatus;
  scheme: PaymentScheme;
  /**
   * The order holds the client's money (prepay paid, or a succeeded handover payment): the
   * engine's `moneyHeld`. A delay claim before the handover is a refund, so it needs money.
   */
  moneyHeld: boolean;
  /** orders.handed_at */
  handedAt: Date | null;
  /** orders.promised_date */
  promisedDate: IsoDate | null;
  /**
   * orders.received_at: the order arrived at the pickup point (the storage window started).
   * Once it is set, a delay before the handover is judged by the arrival day, not by today: a
   * part that came on time is not late because the client comes for it later.
   */
  receivedAt?: Date | null;
  now: Date;
  timeZone?: string;
}

const AFTER_HANDOVER: readonly OrderStatus[] = ['handed', 'completed'];

/**
 * Claim kinds the client (or staff on their behalf) may open now, in CLAIM_KINDS order
 * (decision С7). Empty when no claim is possible in this status.
 */
export function claimKindsAvailable(input: ClaimKindsInput): ClaimKind[] {
  const timeZone = input.timeZone ?? CLIENT_TIME_ZONE;
  const today = localDate(input.now, timeZone);
  const kinds = new Set<ClaimKind>();

  if (AFTER_HANDOVER.includes(input.status)) {
    if (input.handedAt === null) return [];
    if (today <= refusalLastDay(input.handedAt, timeZone)) {
      kinds.add('refusal');
      kinds.add('not_fit');
    }
    kinds.add('defect');
    const handedDay = localDate(input.handedAt, timeZone);
    if (input.promisedDate !== null && handedDay > input.promisedDate) kinds.add('delay');
  } else if ((REFUSABLE_STATUSES as readonly OrderStatus[]).includes(input.status)) {
    const receivedAt = input.receivedAt ?? null;
    const late =
      input.promisedDate !== null &&
      (receivedAt === null
        ? input.promisedDate < today
        : localDate(receivedAt, timeZone) > input.promisedDate);
    if (input.moneyHeld && late) kinds.add('delay');
  }
  return (['refusal', 'not_fit', 'defect', 'delay'] as const).filter((kind) => kinds.has(kind));
}

/** refunds.reason of a claim refund: the claim kind itself. */
export function claimRefundReason(kind: ClaimKind): RefundReason {
  return kind;
}

/** Short names of claim kinds (admin, bot cards, the order page). */
export const CLAIM_KIND_LABELS: Readonly<Record<ClaimKind, string>> = {
  refusal: 'Отказ от товара',
  not_fit: 'Не подошла',
  defect: 'Брак',
  delay: 'Просрочка',
};

/** Plain-words explanations for the claim form (the client chooses the kind). */
export const CLAIM_KIND_HINTS: Readonly<Record<ClaimKind, string>> = {
  refusal: 'Деталь исправна, но больше не нужна — в течение 7 дней после получения',
  not_fit: 'Не подошла к машине — в течение 7 дней после получения',
  defect: 'Брак или неисправность — после получения, в пределах гарантии',
  delay: 'Деталь выдали позже обещанной даты или её до сих пор нет',
};

export const CLAIM_DECISION_LABELS: Readonly<Record<ClaimDecision, string>> = {
  refund: 'Возврат денег',
  replace: 'Замена',
  reject: 'Отказ',
};
