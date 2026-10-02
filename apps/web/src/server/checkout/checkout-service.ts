/**
 * POST /api/checkout (docs/phase-1a-implementation.md section 6.2): the one place where an
 * order is created in phase 1A. Pure orchestration over injected dependencies (as
 * search-service.ts); server/checkout/service.ts wires the real ones.
 *
 * Order of checks: Origin (403) -> honeypot (400) -> gate (403) -> input and consents (400/422)
 * -> idempotency by checkout_key (200 with the same order) -> cart part (404) -> fresh supplier
 * search past the cache with priority critical (503) -> repricing and comparison with what the
 * client saw (409, nothing but the cart is written) -> minimums (422) -> one transaction:
 * user, order, consents, items, state-machine transition, event, cart cleanup -> 201.
 *
 * Personal data (phone, name, IP, user agent) goes only to the database: log lines carry the
 * order number, scheme and counts.
 */
import { randomBytes, randomInt } from 'node:crypto';
import type { Env } from '@detaly/config';
import {
  and,
  cartItems,
  carts,
  consents,
  eq,
  inArray,
  orderEvents,
  orderItems,
  orders,
  users,
  type Executor,
} from '@detaly/db';
import {
  cartTotals,
  checkOrderMinimums,
  choosePaymentScheme,
  promisedDate,
  repriceCartLines,
  resolveTransition,
  selectCartPart,
  splitCartLines,
  type CartPart,
  type IsoDate,
  type LineChange,
  type OrderStatus,
  type PaymentScheme,
  type RepricedLine,
  type TransitionContext,
} from '@detaly/domain';
import { RosskoRateLimitError, type RosskoClient } from '@detaly/rossko';
import {
  fetchFreshOffers,
  findActiveCart,
  MAX_CART_SEARCHES,
  persistRepricing,
  removeCartLines,
} from '../cart-store';
import type { CheckoutGate } from '../checkout-gate';
import { getClientIp } from '../client-ip';
import {
  consentIp,
  HONEYPOT_FIELD,
  isHoneypotTripped,
  isSameOrigin,
  userAgentForConsent,
} from '../request-guards';
import type { SearchSettings } from '../settings';
import { itemsHash } from './hash';
import { parseCheckoutInput, type CheckoutInput } from './input';

interface HeaderSource {
  get(name: string): string | null;
}

export interface CheckoutLogger {
  info(details: Record<string, unknown>, message: string): void;
  warn(details: Record<string, unknown>, message: string): void;
  error(details: Record<string, unknown>, message: string): void;
}

export type CheckoutSettings = Pick<
  SearchSettings,
  'markupRules' | 'excludedRules' | 'eta' | 'order'
>;

export interface CheckoutServiceDeps {
  /** The database (transactions are opened on it). */
  db: Executor;
  supplier: { rossko: Pick<RosskoClient, 'search'> };
  loadSettings: () => Promise<CheckoutSettings>;
  /** getCheckoutGate bound to env and db (decision Д4). */
  gate: () => Promise<CheckoutGate>;
  logger: CheckoutLogger;
  env: Pick<Env, 'APP_BASE_URL' | 'TRUSTED_IP_HEADER'>;
  now?: () => Date;
}

export interface CheckoutRequest {
  headers: HeaderSource;
  /** Parsed JSON body; undefined when the body was not JSON. */
  body: unknown;
  /** Token from the `cart` cookie (readCartToken), null without a valid cookie. */
  cartToken: string | null;
}

export interface CheckoutResponse {
  status: number;
  body: Record<string, unknown>;
  headers?: Record<string, string>;
}

export interface CheckoutService {
  checkout(request: CheckoutRequest): Promise<CheckoutResponse>;
}

/** Order page URL of an access token. */
export function orderUrl(accessToken: string): string {
  return `/o/${accessToken}`;
}

/** 32 random bytes, base64url: 43 characters, 256 bits (orders.access_token, >= 128 bits). */
export function newAccessToken(): string {
  return randomBytes(32).toString('base64url');
}

/** 6 digits for the pickup (shown from `ready` on, decision Д13). */
export function newPickupCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

export const MESSAGES = {
  forbiddenOrigin: 'Запрос отклонён: откройте страницу оформления на сайте и попробуйте ещё раз',
  rejected: 'Запрос отклонён',
  badRequest: 'Форма устарела — обновите страницу и попробуйте ещё раз',
  validation: 'Проверьте поля формы',
  consentRequired:
    'Без принятия оферты и согласия на обработку персональных данных заказ не оформить',
  cartEmpty: 'Корзина пуста — добавьте детали из поиска',
  cartTooLarge: `В заказе слишком много разных запросов — не больше ${MAX_CART_SEARCHES}. Разделите заказ`,
  supplierUnavailable: 'Не удалось проверить цены у поставщика — попробуйте через минуту',
  stale: 'Корзина изменилась — проверьте состав и сумму',
  keyConflict: 'Форма устарела — обновите страницу и попробуйте ещё раз',
  internal: 'Не удалось оформить заказ — попробуйте ещё раз или позвоните нам',
} as const;

const NO_STORE = { 'Cache-Control': 'no-store' };

/** Status after checkout for a payment scheme (the rule's `set_scheme_*` effect must agree). */
const STATUS_FOR_SCHEME: Record<PaymentScheme, OrderStatus> = {
  pay_on_handover: 'awaiting_confirmation',
  prepay: 'awaiting_payment',
};

/** postgres-js error (code, constraint) found in a drizzle error's cause chain. */
function pgErrorOf(error: unknown): { code?: string; constraint_name?: string } | null {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    if (typeof current === 'object' && current !== null && 'code' in current) {
      return current as { code?: string; constraint_name?: string };
    }
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

function isCheckoutKeyConflict(error: unknown): boolean {
  const pg = pgErrorOf(error);
  return pg?.code === '23505' && pg.constraint_name === 'orders_checkout_key_unique';
}

/** Log-safe description of an error: names and SQLSTATE only (drizzle messages carry params). */
function errorInfo(error: unknown): Record<string, unknown> {
  const pg = pgErrorOf(error);
  return {
    err: error instanceof Error ? error.name : typeof error,
    ...(pg?.code ? { pgCode: pg.code } : {}),
    ...(pg?.constraint_name ? { constraint: pg.constraint_name } : {}),
  };
}

class CheckoutInvariantError extends Error {
  override name = 'CheckoutInvariantError';
}

function respond(
  status: number,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): CheckoutResponse {
  return { status, body, headers: { ...NO_STORE, ...headers } };
}

function staleResponse(
  changes: readonly LineChange[],
  totalKop: number | null,
  hash: string | null,
): CheckoutResponse {
  return respond(409, {
    error: 'stale',
    message: MESSAGES.stale,
    changes,
    totalKop,
    itemsHash: hash,
  });
}

type TxOutcome =
  | { kind: 'created'; accessToken: string; number: string; scheme: PaymentScheme }
  | { kind: 'replay'; accessToken: string; number: string }
  | { kind: 'cart_changed' };

export function createCheckoutService(deps: CheckoutServiceDeps): CheckoutService {
  const now = deps.now ?? (() => new Date());
  const { db, logger } = deps;

  /** The order created with this key from this browser's cart (any cart status), if any. */
  async function replayOf(
    exec: Executor,
    checkoutKey: string,
    cartToken: string | null,
  ): Promise<CheckoutResponse | null> {
    const order = await exec.query.orders.findFirst({
      columns: { accessToken: true, number: true, cartId: true },
      where: (t, { eq: equals }) => equals(t.checkoutKey, checkoutKey),
    });
    if (!order) return null;
    const cart =
      cartToken === null
        ? undefined
        : await exec.query.carts.findFirst({
            columns: { id: true },
            where: (t, { eq: equals }) => equals(t.anonToken, cartToken),
          });
    // A key seen with another browser's cart never reveals that order's URL.
    if (!cart || cart.id !== order.cartId) {
      return respond(409, { error: 'checkout_key_conflict', message: MESSAGES.keyConflict });
    }
    return respond(200, { orderUrl: orderUrl(order.accessToken), number: order.number });
  }

  async function createOrder(args: {
    input: CheckoutInput;
    part: CartPart;
    cartId: string;
    lines: readonly RepricedLine[];
    settings: CheckoutSettings;
    gate: Extract<CheckoutGate, { open: true }>;
    headers: HeaderSource;
    hash: string;
    at: Date;
  }): Promise<TxOutcome> {
    const { input, part, cartId, lines, settings, gate, hash, at } = args;
    const totals = cartTotals(lines);
    const allItemsLocal = lines.every((l) => l.isLocal);
    const etaDates = lines.map((l) => l.etaDate).filter((d): d is IsoDate => d !== null);
    const promised = promisedDate(etaDates, settings.eta);
    const ip = consentIp(getClientIp(args.headers, deps.env.TRUSTED_IP_HEADER));
    const userAgent = userAgentForConsent(args.headers);

    return db.transaction(async (tx) => {
      // Serializes submits of one cart: a parallel double submit waits here and then finds
      // the order created by the first one.
      const [locked] = await tx
        .select({ id: carts.id, status: carts.status })
        .from(carts)
        .where(eq(carts.id, cartId))
        .for('update');
      const existing = await tx.query.orders.findFirst({
        columns: { accessToken: true, number: true, cartId: true },
        where: (t, { eq: equals }) => equals(t.checkoutKey, input.checkoutKey),
      });
      if (existing && existing.cartId === cartId) {
        return { kind: 'replay', accessToken: existing.accessToken, number: existing.number };
      }
      if (!locked || locked.status !== 'active') return { kind: 'cart_changed' };

      // The lines must still be exactly what was repriced (no edit in another tab meanwhile).
      const ids = lines.map((l) => l.id);
      const current = await tx
        .select({ id: cartItems.id, qty: cartItems.qty, price: cartItems.priceClientKop })
        .from(cartItems)
        .where(and(eq(cartItems.cartId, cartId), inArray(cartItems.id, ids)));
      const byId = new Map(current.map((row) => [row.id, row]));
      const intact = lines.every((l) => {
        const row = byId.get(l.id);
        return row !== undefined && row.qty === l.qty && row.price === l.priceClientKop;
      });
      if (!intact) return { kind: 'cart_changed' };

      // 1. users: upsert by phone; the latest checkout name wins (decision Д14).
      const [user] = await tx
        .insert(users)
        .values({ phone: input.phone, name: input.name })
        .onConflictDoUpdate({
          target: users.phone,
          set: { name: input.name, updatedAt: at },
        })
        .returning({ id: users.id, noShowCount: users.noShowCount });
      if (!user) throw new CheckoutInvariantError('user upsert returned nothing');

      const decision = choosePaymentScheme({
        allItemsLocal,
        totalKop: totals.subtotalKop,
        noShowCount: user.noShowCount,
        noShowLimit: settings.order.noShowLimit,
        onPickupMaxTotalKop: settings.order.onPickupMaxTotalKop,
        fulfillment: 'pickup',
      });
      const courierFeeKop = 0;
      const totalKop = totals.subtotalKop + courierFeeKop;
      const accessToken = newAccessToken();

      // 2. orders: draft first, the transition below moves it (decision Д11 for expires_at).
      const [order] = await tx
        .insert(orders)
        .values({
          userId: user.id,
          accessToken,
          status: 'draft',
          paymentScheme: decision.scheme,
          fulfillment: 'pickup',
          subtotalKop: totals.subtotalKop,
          courierFeeKop,
          totalKop,
          itemsHash: hash,
          promisedDate: promised,
          pickupCode: newPickupCode(),
          offerVersionId: gate.docs.offer.id,
          preferredChannel: input.channel,
          checkoutKey: input.checkoutKey,
          cartId,
          expiresAt:
            decision.scheme === 'pay_on_handover'
              ? new Date(at.getTime() + settings.order.onPickupConfirmTtlH * 3_600_000)
              : null,
        })
        .returning({ id: orders.id, number: orders.number });
      if (!order) throw new CheckoutInvariantError('order insert returned nothing');

      // 3. consents: PD always, marketing when ticked and the document exists (decision Д5).
      const consentRows: (typeof consents.$inferInsert)[] = [
        {
          userId: user.id,
          documentVersionId: gate.docs.consentPd.id,
          kind: 'pd',
          givenAt: at,
          channel: 'web',
          ip,
          userAgent,
          textSha256: gate.docs.consentPd.sha256,
          orderId: order.id,
        },
      ];
      const marketingDoc = gate.docs.consentMarketing;
      if (input.consentMarketing && marketingDoc) {
        consentRows.push({
          userId: user.id,
          documentVersionId: marketingDoc.id,
          kind: 'marketing',
          givenAt: at,
          channel: 'web',
          ip,
          userAgent,
          textSha256: marketingDoc.sha256,
          orderId: order.id,
        });
      }
      await tx.insert(consents).values(consentRows);

      // 4. order_items with the snapshot the price was computed from.
      await tx.insert(orderItems).values(
        lines.map((l) => ({
          orderId: order.id,
          offerKey: l.offerKey,
          searchArticleNorm: l.searchArticleNorm,
          brand: l.offer.brand,
          article: l.offer.article,
          name: l.offer.name,
          qty: l.qty,
          stockId: l.offer.stock.stockId,
          isLocal: l.isLocal,
          priceSupplierAtOrderKop: l.priceSupplierKop,
          priceClientKop: l.priceClientKop,
          markupBp: l.markupBp,
          etaDate: l.etaDate,
          offerSnapshot: l.offer,
          state: 'pending' as const,
        })),
      );

      // 5. The state machine decides; the scheme computed above must agree with it.
      const ctx: TransitionContext = {
        actor: 'client',
        hasPdConsent: true,
        allItemsLocal,
        totalKop,
        minOrderTotalKop: settings.order.minOrderTotalKop,
        orderMarginKop: totals.marginKop,
        minMarginKop: settings.order.minMarginKop,
        onPickupMaxTotalKop: settings.order.onPickupMaxTotalKop,
        noShowCount: user.noShowCount,
        noShowLimit: settings.order.noShowLimit,
        fulfillment: 'pickup',
      };
      const transition = resolveTransition('draft', 'checkout', ctx);
      if (!transition.ok) {
        throw new CheckoutInvariantError(
          `checkout transition ${transition.reason}: ${transition.failed.join(',')}`,
        );
      }
      const { rule } = transition;
      const effects = typeof rule.effects === 'function' ? rule.effects(ctx) : (rule.effects ?? []);
      if (
        rule.to !== STATUS_FOR_SCHEME[decision.scheme] ||
        !effects.includes(`set_scheme_${decision.scheme}`)
      ) {
        throw new CheckoutInvariantError(
          `checkout rule ${rule.to} disagrees with ${decision.scheme}`,
        );
      }

      // 6. Status and the journal entry (no phone, no name).
      await tx
        .update(orders)
        .set({ status: rule.to, updatedAt: at })
        .where(eq(orders.id, order.id));
      // Effects that 1A does not run yet (decision Д12): the payment is created in 1B.
      const deferredEffects = effects.filter((e) => e === 'create_payment');
      await tx.insert(orderEvents).values({
        orderId: order.id,
        type: 'checkout',
        fromStatus: 'draft',
        toStatus: rule.to,
        actorType: 'client',
        actorId: user.id,
        payload: {
          part,
          scheme: decision.scheme,
          items: lines.length,
          ...(deferredEffects.length > 0 ? { deferredEffects } : {}),
        },
        createdAt: at,
      });

      // 7. The checked-out lines leave the cart; an empty cart is converted.
      await removeCartLines(tx, cartId, ids);
      const left = await tx
        .select({ id: cartItems.id })
        .from(cartItems)
        .where(eq(cartItems.cartId, cartId))
        .limit(1);
      await tx
        .update(carts)
        .set(
          left.length === 0
            ? { status: 'converted', userId: user.id, updatedAt: at }
            : { updatedAt: at },
        )
        .where(eq(carts.id, cartId));

      return { kind: 'created', accessToken, number: order.number, scheme: decision.scheme };
    });
  }

  async function run(request: CheckoutRequest): Promise<CheckoutResponse> {
    const { headers, body, cartToken } = request;

    if (!isSameOrigin(headers, deps.env.APP_BASE_URL)) {
      return respond(403, { error: 'forbidden_origin', message: MESSAGES.forbiddenOrigin });
    }
    const honeypot =
      typeof body === 'object' && body !== null
        ? (body as Record<string, unknown>)[HONEYPOT_FIELD]
        : undefined;
    if (isHoneypotTripped(honeypot)) {
      logger.warn({}, 'checkout honeypot');
      return respond(400, { error: 'rejected', message: MESSAGES.rejected });
    }
    const gate = await deps.gate();
    if (!gate.open) {
      return respond(403, { error: 'checkout_closed', message: gate.message });
    }

    const parsed = parseCheckoutInput(body);
    if (!parsed.ok) {
      if (parsed.status === 400) {
        return respond(400, { error: 'bad_request', message: MESSAGES.badRequest });
      }
      return respond(422, {
        error: parsed.error,
        message:
          parsed.error === 'consent_required' ? MESSAGES.consentRequired : MESSAGES.validation,
        fields: parsed.fields,
      });
    }
    const { input } = parsed;

    const replay = await replayOf(db, input.checkoutKey, cartToken);
    if (replay) return replay;

    const active = cartToken === null ? null : await findActiveCart(db, cartToken);
    if (!active) return respond(404, { error: 'cart_empty', message: MESSAGES.cartEmpty });
    const partLines = selectCartPart(active.lines, input.part);
    if (partLines.length === 0) {
      return respond(404, { error: 'cart_empty', message: MESSAGES.cartEmpty });
    }
    const part: CartPart = splitCartLines(active.lines).mixed ? input.part : 'all';
    const articles = new Set(partLines.map((l) => l.searchArticleNorm));
    if (articles.size > MAX_CART_SEARCHES) {
      return respond(422, { error: 'cart_too_large', message: MESSAGES.cartTooLarge });
    }

    const settings = await deps.loadSettings();
    let fresh;
    try {
      fresh = await fetchFreshOffers(deps.supplier.rossko, articles, {
        priority: 'critical',
        bypassCache: true,
      });
    } catch (error) {
      const cause = (error as { cause?: unknown }).cause ?? error;
      logger.warn(
        { ...errorInfo(cause), lines: partLines.length },
        'checkout supplier unavailable',
      );
      const retry =
        cause instanceof RosskoRateLimitError
          ? { 'Retry-After': String(Math.max(1, Math.ceil(cause.retryAfterMs / 1000))) }
          : undefined;
      return respond(
        503,
        { error: 'supplier_unavailable', message: MESSAGES.supplierUnavailable },
        retry,
      );
    }

    const at = now();
    const repriced = repriceCartLines(partLines, fresh, {
      markupRules: settings.markupRules,
      excludedRules: settings.excludedRules,
      eta: settings.eta,
      now: at,
    });
    const okLines = repriced.lines.filter((l) => l.status === 'ok');
    const totals = cartTotals(okLines);
    const hash = itemsHash(okLines);
    if (
      repriced.changes.length > 0 ||
      okLines.length === 0 ||
      hash !== input.itemsHash ||
      totals.subtotalKop !== input.expectedTotalKop
    ) {
      await persistRepricing(db, active.cart.id, repriced.lines, { now: at });
      logger.info({ changes: repriced.changes.length, lines: partLines.length }, 'checkout stale');
      return staleResponse(repriced.changes, totals.subtotalKop, hash);
    }

    const minimums = checkOrderMinimums({
      subtotalKop: totals.subtotalKop,
      marginKop: totals.marginKop,
      minOrderTotalKop: settings.order.minOrderTotalKop,
      minMarginKop: settings.order.minMarginKop,
    });
    if (!minimums.ok) {
      return respond(422, {
        error: 'below_minimum',
        code: minimums.code,
        message: minimums.message,
      });
    }

    let outcome: TxOutcome;
    try {
      outcome = await createOrder({
        input,
        part,
        cartId: active.cart.id,
        lines: okLines,
        settings,
        gate,
        headers,
        hash,
        at,
      });
    } catch (error) {
      if (isCheckoutKeyConflict(error)) {
        const again = await replayOf(db, input.checkoutKey, cartToken);
        if (again) return again;
      }
      logger.error(errorInfo(error), 'checkout failed');
      return respond(500, { error: 'internal', message: MESSAGES.internal });
    }

    if (outcome.kind === 'cart_changed') {
      logger.info({ lines: partLines.length }, 'checkout stale: cart changed meanwhile');
      return staleResponse([], null, null);
    }
    if (outcome.kind === 'replay') {
      return respond(200, { orderUrl: orderUrl(outcome.accessToken), number: outcome.number });
    }
    logger.info(
      { number: outcome.number, scheme: outcome.scheme, items: okLines.length, part },
      'order created',
    );
    return respond(201, { orderUrl: orderUrl(outcome.accessToken), number: outcome.number });
  }

  return {
    async checkout(request) {
      try {
        return await run(request);
      } catch (error) {
        // Database or settings failure outside the order transaction: no order was created.
        logger.error(errorInfo(error), 'checkout failed');
        return respond(500, { error: 'internal', message: MESSAGES.internal });
      }
    },
  };
}
