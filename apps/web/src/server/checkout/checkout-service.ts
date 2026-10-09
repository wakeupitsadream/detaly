/**
 * POST /api/checkout (docs/phase-1a-implementation.md section 6.2): the one place where an
 * order is created in phase 1A. Pure orchestration over injected dependencies (as
 * search-service.ts); server/checkout/service.ts wires the real ones.
 *
 * Order of checks: Origin (403) -> honeypot (400) -> gate (403) -> input and consents (400/422)
 * -> idempotency by checkout_key (200 with the same order) -> document versions shown on the
 * page (409 documents_changed) -> cart part (404) -> settings read from the database (503) ->
 * fresh supplier search past the cache with priority critical (503) -> repricing and
 * comparison with what the client saw: lines, total, a later promised date (409, nothing but
 * the cart is written) -> minimums and the maximum (422) -> one transaction: user, order,
 * consents, items, state-machine transition, event, cart cleanup; a payment scheme other than
 * the one shown rolls it back (409 scheme_changed) -> 201.
 *
 * Phase 1B (section 14.5): the `checkout` transition is written by the order engine
 * (persistTransition) inside the order transaction: status, expires_at (payment TTL for
 * prepay, the confirmation window for pay_on_handover), the journal row and the client
 * notification (confirm_request / payment_link) as an outbox row. The payment itself is created
 * lazily by «Оплатить» on /o/<token> (decision Б5).
 *
 * Phase 1C (decision С14): a cart filled from a VIN proposal carries carts.vin_request_id; the
 * order created from it gets orders.vin_request_id, the request becomes `converted`
 * (markVinConverted) and the journal gets `vin_order` — in the same order transaction.
 *
 * Step 4 (docs/fit-check.md): a line the master checked (`fits` about this very part, or the
 * analog he offered and the client took) carries the check into its order item — fit_check_id,
 * fit_checked_at, fit_checked_by and fit_guarantee = FIT_GUARANTEE_ENABLED now; a check still
 * waiting is cancelled with the line leaving the cart (removeCartLines).
 *
 * Step 6 (docs/garage.md): with GARAGE_ENABLED the optional «Моя машина» block is read; a typed
 * car is stored for the client by the merge rules (saveUserVehicle, under the client's row lock)
 * and becomes orders.vehicle_id — in the order transaction, so a refused order stores no car.
 * Its source is the cart's prefill when the client kept its make and model (kit, proposal, bot),
 * else `checkout`. Without the switch `vehicle` is never read and nothing is stored.
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
  orderItems,
  orders,
  users,
  type Database,
  type Executor,
} from '@detaly/db';
import {
  cartTotals,
  checkOrderMinimums,
  choosePaymentScheme,
  explainPaymentScheme,
  formatPromise,
  localDate,
  promisedDate,
  repriceCartLines,
  resolveTransition,
  selectCartPart,
  splitCartLines,
  vehicleSourceOf,
  type CartPart,
  type IsoDate,
  type LineChange,
  type OrderStatus,
  type PaymentScheme,
  type PaymentSchemeDecision,
  type RepricedLine,
  type TransitionContext,
} from '@detaly/domain';
import {
  loadOrderSnapshot,
  persistTransition,
  recordJournalEvent,
  saveUserVehicle,
  type EngineDeps,
} from '@detaly/orders';
import { RosskoRateLimitError, type RosskoClient } from '@detaly/rossko';
import { fitOrderItemColumns, latestFitChecksOfLines, markVinConverted } from '@detaly/vin';
import {
  fetchFreshOffers,
  findActiveCart,
  MAX_CART_SEARCHES,
  persistRepricing,
  removeCartLines,
} from '../cart-store';
import { CAR_MAKES } from '@/lib/brands';
import type { CheckoutGate } from '../checkout-gate';
import { getClientIp } from '../client-ip';
import { errorInfo, isNamedError, pgErrorOf } from '../errors';
import { loadVehiclePrefill } from '../garage/prefill';
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
  'pricing' | 'excludedRules' | 'eta' | 'order' | 'fromDatabase'
>;

export interface CheckoutServiceDeps {
  /** The database (transactions are opened on it). */
  db: Database;
  supplier: { rossko: Pick<RosskoClient, 'search'> };
  loadSettings: () => Promise<CheckoutSettings>;
  /** getCheckoutGate bound to env and db (decision Д4). */
  gate: () => Promise<CheckoutGate>;
  logger: CheckoutLogger;
  /** Full env: the order engine reads settings defaults from it (payment TTL, confirmation). */
  env: Env;
  now?: () => Date;
  /**
   * Wakes the worker's outbox dispatcher after the order commit (decision Б1). Default: the
   * process engine's nudge (server/engine.ts); without it the dispatcher polls every 2 s.
   */
  nudge?: () => void;
}

/** The process engine's nudge, resolved lazily (no Redis connection until an order exists). */
async function defaultNudge(): Promise<void> {
  const { getEngineDeps } = await import('../engine');
  getEngineDeps().nudge?.();
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
  promiseChanged: 'Срок получения изменился — проверьте его и отправьте форму ещё раз',
  documentsChanged:
    'Мы обновили оферту или согласие на обработку данных — обновите страницу, прочитайте документы и отправьте форму ещё раз',
  schemeChanged: 'Способ оплаты изменился — проверьте его и отправьте форму ещё раз',
  settingsUnavailable: 'Не удалось загрузить условия заказа — попробуйте через минуту',
  keyConflict: 'Форма устарела — обновите страницу и попробуйте ещё раз',
  internal: 'Не удалось оформить заказ — попробуйте ещё раз или позвоните нам',
} as const;

const NO_STORE = { 'Cache-Control': 'no-store' };

/** Status after checkout for a payment scheme (the rule's `set_scheme_*` effect must agree). */
const STATUS_FOR_SCHEME: Record<PaymentScheme, OrderStatus> = {
  pay_on_handover: 'awaiting_confirmation',
  prepay: 'awaiting_payment',
};

function isCheckoutKeyConflict(error: unknown): boolean {
  const pg = pgErrorOf(error);
  return pg?.code === '23505' && pg.constraint_name === 'orders_checkout_key_unique';
}

class CheckoutInvariantError extends Error {
  override name = 'CheckoutInvariantError';
}

/**
 * The scheme decided with the client's real no-show count differs from the one the page showed
 * (it counts no-shows as 0): thrown inside the order transaction so that nothing is written.
 */
class SchemeChangedError extends Error {
  override name = 'SchemeChangedError';
  readonly decision: PaymentSchemeDecision;

  constructor(decision: PaymentSchemeDecision) {
    super('payment scheme differs from the one shown');
    this.decision = decision;
  }
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
  promise: { date: IsoDate; text: string } | null = null,
): CheckoutResponse {
  return respond(409, {
    error: 'stale',
    message: promise && changes.length === 0 ? MESSAGES.promiseChanged : MESSAGES.stale,
    changes,
    totalKop,
    itemsHash: hash,
    ...(promise ? { promisedDate: promise.date, promiseText: promise.text } : {}),
  });
}

/** The document versions on the rendered page are still the ones the gate serves. */
function documentsMatch(input: CheckoutInput, gate: Extract<CheckoutGate, { open: true }>) {
  if (input.offerVersionId !== gate.docs.offer.id) return false;
  if (input.consentPdVersionId !== gate.docs.consentPd.id) return false;
  // The marketing consent matters only when it is given.
  return (
    !input.consentMarketing || input.consentMarketingVersionId === gate.docs.consentMarketing?.id
  );
}

type TxOutcome =
  | {
      kind: 'created';
      accessToken: string;
      number: string;
      scheme: PaymentScheme;
      vinRequestId: string | null;
      /** Step 6: the order got a car of «Моя машина». */
      vehicle: boolean;
    }
  | { kind: 'replay'; accessToken: string; number: string }
  | { kind: 'cart_changed' };

export function createCheckoutService(deps: CheckoutServiceDeps): CheckoutService {
  const now = deps.now ?? (() => new Date());
  const { db, logger } = deps;
  const nudge = (): void => {
    try {
      if (deps.nudge) deps.nudge();
      else void defaultNudge().catch(() => undefined);
    } catch {
      // best effort (decision Б1): the dispatcher polls anyway
    }
  };
  /** The engine runs in the order transaction; its clock is the checkout clock. */
  const engineDeps = (at: Date): EngineDeps => ({
    db,
    env: deps.env,
    now: () => at,
  });

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
    promised: IsoDate;
    at: Date;
  }): Promise<TxOutcome> {
    const { input, part, cartId, lines, settings, gate, hash, promised, at } = args;
    const totals = cartTotals(lines);
    const allItemsLocal = lines.every((l) => l.isLocal);
    const ip = consentIp(getClientIp(args.headers, deps.env.TRUSTED_IP_HEADER));
    const userAgent = userAgentForConsent(args.headers);

    return db.transaction(async (tx) => {
      // Serializes submits of one cart: a parallel double submit waits here and then finds
      // the order created by the first one.
      const [locked] = await tx
        .select({ id: carts.id, status: carts.status, vinRequestId: carts.vinRequestId })
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
      // Locked: a quantity edit committed between this check and the removal below would
      // otherwise be lost (the order would carry the old quantity).
      const ids = lines.map((l) => l.id);
      const current = await tx
        .select({ id: cartItems.id, qty: cartItems.qty, price: cartItems.priceClientKop })
        .from(cartItems)
        .where(and(eq(cartItems.cartId, cartId), inArray(cartItems.id, ids)))
        .for('update');
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
      // The page showed the scheme with no-shows counted as 0; payment terms are an essential
      // condition, so a different one (prepay for this phone) is shown first, never applied
      // silently. Thrown: the user upsert above rolls back too.
      if (decision.scheme !== input.expectedScheme) throw new SchemeChangedError(decision);

      // Step 6 (docs/garage.md): the car of «Моя машина», typed or kept from the cart's prefill.
      let vehicleId: string | null = null;
      if (deps.env.GARAGE_ENABLED && input.vehicle) {
        const prefill = await loadVehiclePrefill(tx, cartId, localDate(at));
        const saved = await saveUserVehicle(tx, {
          userId: user.id,
          vehicle: input.vehicle,
          source: vehicleSourceOf(input.vehicle, prefill?.identity ?? null),
          now: at,
        });
        vehicleId = saved?.vehicleId ?? null;
      }
      const courierFeeKop = 0;
      const totalKop = totals.subtotalKop + courierFeeKop;
      const accessToken = newAccessToken();
      // The master's proposal this cart was filled from (phase 1C), if any.
      const vinRequestId = locked.vinRequestId;

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
          vinRequestId,
          vehicleId,
          // expires_at is set by the transition below (engine, decision Б5).
          expiresAt: null,
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

      // 4. order_items with the snapshot the price was computed from, and the master's check of
      // the line when it counts (step 4).
      const fitByLine = await latestFitChecksOfLines(tx, cartId, ids);
      await tx.insert(orderItems).values(
        lines.map((l) => ({
          ...fitOrderItemColumns(fitByLine.get(l.id), l.offer, {
            now: at,
            guaranteeEnabled: deps.env.FIT_GUARANTEE_ENABLED,
          }),
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

      // 6. The engine writes the status, expires_at, the journal entry (no phone, no name) and
      // the client notification through the outbox, in this transaction.
      const snapshot = await loadOrderSnapshot(tx, order.id, { lock: true });
      if (snapshot === null) throw new CheckoutInvariantError('order snapshot missing');
      await persistTransition(
        tx,
        snapshot,
        { rule, ctx, changes: [] },
        {
          deps: engineDeps(at),
          orderId: order.id,
          event: 'checkout',
          actor: { type: 'client', id: user.id },
          payload: {
            part,
            scheme: decision.scheme,
            ...(decision.reasons.length > 0 ? { schemeReasons: decision.reasons } : {}),
            items: lines.length,
          },
        },
      );

      // 7. A cart from a VIN proposal (decision С14): the request is converted and the journal
      // says the order came from it, in this transaction.
      if (vinRequestId !== null) {
        await markVinConverted(tx, { vinRequestId, orderId: order.id, now: at });
        await recordJournalEvent(tx, {
          orderId: order.id,
          type: 'vin_order',
          actor: { type: 'client', id: user.id },
          payload: { vinRequestId },
          at,
        });
      }

      // 8. The checked-out lines leave the cart; an empty cart is converted.
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

      return {
        kind: 'created',
        accessToken,
        number: order.number,
        scheme: decision.scheme,
        vinRequestId,
        vehicle: vehicleId !== null,
      };
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

    const parsed = parseCheckoutInput(body, {
      garage: deps.env.GARAGE_ENABLED ? { makes: CAR_MAKES, today: localDate(now()) } : null,
    });
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

    // The order and the consents must point at the texts the client saw and ticked (consent
    // proof, ч. 3 ст. 9 152-ФЗ): a version published after the page was rendered is a 409.
    if (!documentsMatch(input, gate)) {
      logger.info({}, 'checkout stale: documents changed');
      return respond(409, { error: 'documents_changed', message: MESSAGES.documentsChanged });
    }

    // An empty or converted cart may be the work of a duplicate submit with this very key that
    // committed after the lookup above: it gets that order, not 404.
    const cartEmpty = async (): Promise<CheckoutResponse> =>
      (await replayOf(db, input.checkoutKey, cartToken)) ??
      respond(404, { error: 'cart_empty', message: MESSAGES.cartEmpty });
    const active = cartToken === null ? null : await findActiveCart(db, cartToken);
    if (!active) return cartEmpty();
    const partLines = selectCartPart(active.lines, input.part);
    if (partLines.length === 0) return cartEmpty();
    const part: CartPart = splitCartLines(active.lines).mixed ? input.part : 'all';
    const articles = new Set(partLines.map((l) => l.searchArticleNorm));
    if (articles.size > MAX_CART_SEARCHES) {
      return respond(422, { error: 'cart_too_large', message: MESSAGES.cartTooLarge });
    }

    const settings = await deps.loadSettings();
    // Env fallbacks (database read failed, nothing cached) are fine for search, not for an
    // order: stop rules added by the admin and the current markups and thresholds would be
    // ignored.
    if (!settings.fromDatabase) {
      logger.warn({ lines: partLines.length }, 'checkout settings unavailable');
      return respond(
        503,
        { error: 'settings_unavailable', message: MESSAGES.settingsUnavailable },
        { 'Retry-After': '60' },
      );
    }
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
      const retry = isNamedError(cause, RosskoRateLimitError, 'RosskoRateLimitError')
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
      pricing: settings.pricing,
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

    // The promised date is an essential term (ст. 23.1 ЗоЗПП): a later date than the page
    // showed is a 409 with the new date; an earlier one is accepted as is (decision Д8 keeps
    // the date out of the items hash).
    const etaDates = okLines.map((l) => l.etaDate).filter((d): d is IsoDate => d !== null);
    const promised = promisedDate(etaDates, settings.eta);
    if (input.expectedPromisedDate !== null && promised > input.expectedPromisedDate) {
      logger.info({ lines: partLines.length }, 'checkout stale: promised date moved');
      return staleResponse([], totals.subtotalKop, hash, {
        date: promised,
        text: formatPromise(promised),
      });
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
        promised,
        at,
      });
    } catch (error) {
      if (isNamedError(error, SchemeChangedError, 'SchemeChangedError')) {
        logger.info({ scheme: error.decision.scheme }, 'checkout stale: payment scheme changed');
        return respond(409, {
          error: 'scheme_changed',
          message: MESSAGES.schemeChanged,
          scheme: error.decision.scheme,
          explanation: explainPaymentScheme(error.decision, {
            onPickupMaxTotalKop: settings.order.onPickupMaxTotalKop,
          }),
        });
      }
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
    nudge();
    logger.info(
      {
        number: outcome.number,
        scheme: outcome.scheme,
        items: okLines.length,
        part,
        ...(outcome.vinRequestId ? { vinRequest: outcome.vinRequestId } : {}),
        ...(outcome.vehicle ? { vehicle: true } : {}),
      },
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
