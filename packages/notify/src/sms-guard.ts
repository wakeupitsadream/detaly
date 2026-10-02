/**
 * SMS limits and budget (decision Б21, PLAN sections 1 and 4).
 *
 * - Rate: at most 1 SMS per number in 10 minutes and 3 in 24 hours (sliding windows in Redis
 *   through slidingWindowHit). Keys hold HMAC(secret, phone digits), never the number.
 * - Budget: SMS_MONTHLY_BUDGET_RUB per calendar month in Asia/Yekaterinburg; 80% -> one alert,
 *   100% -> SMS stop (`sms_budget_exhausted`). Spending is summed by the worker from
 *   api_calls.cost_kop (source 'sms'); smsBudgetState is the pure threshold check.
 */
import { createHmac } from 'node:crypto';
import { slidingWindowHit, type Redis } from '@detaly/config';
import { CLIENT_TIME_ZONE } from '@detaly/domain';
import { FALLBACK_REASONS } from './notifier';

export interface SmsLimits {
  perTenMin: number;
  perDay: number;
}

export const DEFAULT_SMS_LIMITS: SmsLimits = { perTenMin: 1, perDay: 3 };

const TEN_MIN_MS = 10 * 60_000;
const DAY_MS = 24 * 3_600_000;
/** A granted notification stays granted for its queue retries (5 attempts with backoff). */
const GRANT_TTL_MS = DAY_MS;

export type SmsBudgetState = 'ok' | 'alert' | 'exhausted';

export type SmsGuardResult =
  | { allowed: true }
  | {
      allowed: false;
      reason: typeof FALLBACK_REASONS.smsRateLimited | typeof FALLBACK_REASONS.smsBudgetExhausted;
      /** For the rate limit: ms until the oldest SMS leaves the window. */
      retryAfterMs?: number;
    };

export interface SmsGuard {
  /**
   * Checks and records one SMS to `phone`. `dedupeKey` (notifications.dedupe_key) makes a
   * retry of an already granted notification pass without consuming the limit again.
   */
  check(phone: string, options?: { dedupeKey?: string }): Promise<SmsGuardResult>;
}

export interface SmsGuardOptions {
  redis: Redis;
  /** SESSION_SECRET: keys are HMAC(secret, phone) so Redis holds no numbers. */
  secret: string;
  /** Redis key prefix (`detaly:` in production, `test:<uuid>:` in tests). */
  keyPrefix: string;
  limits?: SmsLimits;
  /** Current month's budget state; 'exhausted' stops SMS before the rate windows are hit. */
  budget?: () => Promise<SmsBudgetState> | SmsBudgetState;
  now?: () => Date | number;
}

function hmac(secret: string, value: string): string {
  return createHmac('sha256', secret).update(value).digest('base64url');
}

/**
 * Digits only with the trunk prefix 8 read as 7, so '+7 999 123-45-67', '8 999 123-45-67' and
 * '79991234567' share one key.
 */
function phoneKeyPart(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  return digits.length === 11 && digits.startsWith('8') ? `7${digits.slice(1)}` : digits;
}

export function createSmsGuard(options: SmsGuardOptions): SmsGuard {
  const { redis, secret, keyPrefix, limits = DEFAULT_SMS_LIMITS } = options;
  if (secret.length === 0) throw new Error('sms guard: empty secret');
  const now = options.now ?? (() => Date.now());

  return {
    async check(phone, { dedupeKey } = {}) {
      const digits = phoneKeyPart(phone);
      if (digits.length === 0) throw new Error('sms guard: empty phone');

      const grantKey =
        dedupeKey === undefined ? null : `${keyPrefix}sms:grant:${hmac(secret, dedupeKey)}`;
      if (grantKey !== null && (await redis.exists(grantKey)) === 1) return { allowed: true };

      if (options.budget !== undefined && (await options.budget()) === 'exhausted') {
        return { allowed: false, reason: FALLBACK_REASONS.smsBudgetExhausted };
      }

      const id = hmac(secret, digits);
      const at = now();
      // Ten minutes first: a refusal there does not spend the daily allowance.
      const short = await slidingWindowHit(redis, {
        key: `${keyPrefix}sms:rl:10m:${id}`,
        limit: limits.perTenMin,
        windowMs: TEN_MIN_MS,
        now: at,
      });
      if (!short.allowed) {
        return {
          allowed: false,
          reason: FALLBACK_REASONS.smsRateLimited,
          retryAfterMs: short.retryAfterMs,
        };
      }
      const day = await slidingWindowHit(redis, {
        key: `${keyPrefix}sms:rl:1d:${id}`,
        limit: limits.perDay,
        windowMs: DAY_MS,
        now: at,
      });
      if (!day.allowed) {
        return {
          allowed: false,
          reason: FALLBACK_REASONS.smsRateLimited,
          retryAfterMs: day.retryAfterMs,
        };
      }
      if (grantKey !== null) await redis.set(grantKey, '1', 'PX', GRANT_TTL_MS);
      return { allowed: true };
    },
  };
}

/**
 * Monthly budget thresholds: >= 80% -> 'alert', >= 100% -> 'exhausted'. No budget configured
 * (SMS_MONTHLY_BUDGET_RUB unset) -> 'ok'; a zero budget is exhausted from the start.
 * Integer arithmetic in kopecks.
 */
export function smsBudgetState({
  spentKop,
  budgetRub,
}: {
  spentKop: number;
  budgetRub: number | null | undefined;
}): SmsBudgetState {
  if (budgetRub === null || budgetRub === undefined) return 'ok';
  const budgetKop = budgetRub * 100;
  if (spentKop >= budgetKop) return 'exhausted';
  if (spentKop * 10 >= budgetKop * 8) return 'alert';
  return 'ok';
}

/**
 * Asia/Yekaterinburg has been UTC+5 without DST since 2014; the budget month is the client
 * calendar month (decision Б21).
 */
const BUDGET_TZ_OFFSET_MS = 5 * 3_600_000;
const MONTH_FORMAT = new Intl.DateTimeFormat('en-CA', {
  timeZone: CLIENT_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
});

/**
 * The budget month of `now`: key 'YYYY-MM' (alert dedupe) and the UTC range [from, to) for
 * summing api_calls.cost_kop.
 */
export function smsBudgetPeriod(now: Date): { month: string; from: Date; to: Date } {
  const parts: Record<string, string> = {};
  for (const part of MONTH_FORMAT.formatToParts(now)) parts[part.type] = part.value;
  const year = Number(parts.year);
  const month = Number(parts.month);
  const from = new Date(Date.UTC(year, month - 1, 1) - BUDGET_TZ_OFFSET_MS);
  const to = new Date(Date.UTC(year, month, 1) - BUDGET_TZ_OFFSET_MS);
  return { month: `${parts.year}-${parts.month}`, from, to };
}
