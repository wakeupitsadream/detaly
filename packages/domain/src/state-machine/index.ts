/**
 * Pure resolution of order transitions. Persisting the transition (row lock, order_events,
 * receipts, notifications) is the caller's job; this module only decides.
 */
import type { OrderStatus } from '../statuses';
import { failedGuards, type TransitionContext } from './guards';
import { type OrderEvent, ORDER_EVENTS, TRANSITIONS, type TransitionRule } from './transitions';

export * from './guards';
export * from './transitions';

export type TransitionResult =
  | { ok: true; rule: TransitionRule }
  | {
      ok: false;
      reason: 'no_rule' | 'guard_failed';
      /** For guard_failed: names of failing guards ('actor' when the actor is not allowed). */
      failed: string[];
    };

function key(status: OrderStatus, event: OrderEvent): string {
  return `${status}|${event}`;
}

function indexRules(rules: readonly TransitionRule[]): Map<string, TransitionRule[]> {
  const map = new Map<string, TransitionRule[]>();
  for (const rule of rules) {
    for (const from of rule.from) {
      const k = key(from, rule.event);
      const list = map.get(k);
      if (list === undefined) map.set(k, [rule]);
      else list.push(rule);
    }
  }
  return map;
}

const RULES_BY_KEY = indexRules(TRANSITIONS);

/** Rules registered for (status, event), regardless of guards. */
export function rulesFor(status: OrderStatus, event: OrderEvent): readonly TransitionRule[] {
  return RULES_BY_KEY.get(key(status, event)) ?? [];
}

/** Why a rule does not apply to `ctx` (empty array when it applies). */
export function ruleFailures(rule: TransitionRule, ctx: TransitionContext): string[] {
  const failed: string[] = [];
  if (!rule.actors.includes(ctx.actor)) failed.push('actor');
  if (rule.guard !== undefined) failed.push(...failedGuards(rule.guard, ctx));
  return failed;
}

/**
 * Finds the rule for (status, event) whose actor list and guard accept `ctx`.
 * - no rule registered for the pair -> { ok: false, reason: 'no_rule' };
 * - rules exist but none accepts ctx -> { ok: false, reason: 'guard_failed', failed }.
 * Unknown event strings (e.g. read from the database) resolve to 'no_rule'.
 */
export function resolveTransition(
  status: OrderStatus,
  event: OrderEvent | string,
  ctx: TransitionContext,
): TransitionResult {
  const rules = RULES_BY_KEY.get(`${status}|${event}`);
  if (rules === undefined || rules.length === 0) {
    return { ok: false, reason: 'no_rule', failed: [] };
  }
  const failed = new Set<string>();
  for (const rule of rules) {
    const failures = ruleFailures(rule, ctx);
    if (failures.length === 0) return { ok: true, rule };
    for (const f of failures) failed.add(f);
  }
  return { ok: false, reason: 'guard_failed', failed: [...failed] };
}

/** Events that would succeed now; used to decide which buttons to show. */
export function availableEvents(status: OrderStatus, ctx: TransitionContext): OrderEvent[] {
  return ORDER_EVENTS.filter((event) => resolveTransition(status, event, ctx).ok);
}

export function isOrderEvent(value: unknown): value is OrderEvent {
  return typeof value === 'string' && (ORDER_EVENTS as readonly string[]).includes(value);
}
