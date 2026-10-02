// SMS limits, budget and cost accounting around the SMS driver (decision Б21).
//
// - Rate: 1 SMS per number in 10 minutes and 3 a day (createSmsGuard of @detaly/notify, keys
//   HMAC(SESSION_SECRET, phone) under deps.keyPrefix). The guard records a grant per
//   notifications.dedupe_key, so a queue retry of the same notification (and the driver's own
//   guard, if worker-core gave it one with the same prefix) does not count twice.
// - Budget: api_calls.cost_kop of source 'sms' in the calendar month (Asia/Yekaterinburg);
//   at 100% of SMS_MONTHLY_BUDGET_RUB SMS stop (`sms_budget_exhausted`).
// - Every gateway call writes api_calls (source 'sms'): a sent SMS costs SMS_PRICE_KOP
//   (VERIFY: provider tariff), a failure costs 0 and keeps only the error code.
import { and, apiCalls, eq, lt, sql, type Executor } from '@detaly/db';
import {
  ChannelSkippedError,
  createSmsGuard,
  SmsGatewayError,
  smsBudgetPeriod,
  smsBudgetState,
  UnrecoverableSmsError,
  type ChannelDriver,
  type SmsBudgetState,
} from '@detaly/notify';
import type { WorkerDeps } from '../../deps';

export interface SmsSpending {
  month: string;
  spentKop: number;
  budgetRub: number | null;
  state: SmsBudgetState;
}

/** SMS spending of the budget month of `now` (api_calls source 'sms'). */
export async function smsSpending(
  db: Executor,
  budgetRub: number | null | undefined,
  now: Date,
): Promise<SmsSpending> {
  const period = smsBudgetPeriod(now);
  const [row] = await db
    .select({ spent: sql<string>`coalesce(sum(${apiCalls.costKop}), 0)` })
    .from(apiCalls)
    .where(
      and(
        eq(apiCalls.source, 'sms'),
        // [from, to): created_at >= from is "not (created_at < from)".
        sql`not (${lt(apiCalls.createdAt, period.from)})`,
        lt(apiCalls.createdAt, period.to),
      ),
    );
  const spentKop = Number(row?.spent ?? 0);
  return {
    month: period.month,
    spentKop,
    budgetRub: budgetRub ?? null,
    state: smsBudgetState({ spentKop, budgetRub }),
  };
}

/** Error code for api_calls / notifications.error: never the number or the text. */
export function smsErrorCode(error: unknown): string {
  if (error instanceof UnrecoverableSmsError || error instanceof SmsGatewayError) {
    return `${error.provider}:${error.code}`;
  }
  return error instanceof Error ? error.name : 'unknown';
}

async function recordSmsCall(
  db: Executor,
  input: { ok: boolean; durationMs: number; costKop: number; error: string | null; at: Date },
): Promise<void> {
  await db.insert(apiCalls).values({
    source: 'sms',
    method: 'send',
    durationMs: Math.max(0, Math.round(input.durationMs)),
    ok: input.ok,
    error: input.error,
    costKop: input.costKop,
    createdAt: input.at,
  });
}

/**
 * The SMS driver of deps behind the rate limit and the budget, with api_calls accounting.
 * A refusal is a ChannelSkippedError: the Notifier turns it into `skipped` with the reason.
 */
export function guardedSmsDriver(
  deps: Pick<WorkerDeps, 'db' | 'redis' | 'env' | 'keyPrefix' | 'now'>,
  inner: ChannelDriver,
): ChannelDriver {
  const guard = createSmsGuard({
    redis: deps.redis,
    secret: deps.env.SESSION_SECRET,
    keyPrefix: deps.keyPrefix,
    budget: async () =>
      (await smsSpending(deps.db, deps.env.SMS_MONTHLY_BUDGET_RUB, deps.now())).state,
    now: deps.now,
  });
  return {
    channel: 'sms',
    async send(address, message, options = {}) {
      const verdict = await guard.check(
        address,
        options.dedupeKey === undefined ? {} : { dedupeKey: options.dedupeKey },
      );
      if (!verdict.allowed) throw new ChannelSkippedError('sms', verdict.reason);
      const started = Date.now();
      try {
        const sent = await inner.send(address, message, options);
        await recordSmsCall(deps.db, {
          ok: true,
          durationMs: Date.now() - started,
          costKop: deps.env.SMS_PRICE_KOP,
          error: null,
          at: deps.now(),
        });
        return sent;
      } catch (error) {
        if (!(error instanceof ChannelSkippedError)) {
          await recordSmsCall(deps.db, {
            ok: false,
            durationMs: Date.now() - started,
            costKop: 0,
            error: smsErrorCode(error),
            at: deps.now(),
          });
        }
        throw error;
      }
    },
  };
}
