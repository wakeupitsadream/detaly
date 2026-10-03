/**
 * POST /api/proposals/<token>/take — «Оформить и оплатить» on /p/<token>
 * (docs/phase-1c-implementation.md decision С14): the proposal lines are copied into the
 * visitor's own cart (the 1A `cart` cookie; a new cart when there is none) together with the
 * VIN request id, then 303 to /checkout, the ordinary one (fresh GetSearch, DiffBanner,
 * consents). The order created from that cart carries orders.vin_request_id
 * (server/checkout/checkout-service.ts).
 *
 * Order of checks: Origin (403) -> token shape and the proposal (404) -> expired, replaced or
 * closed (410) -> one transaction: the visitor's cart (locked, or created) and
 * copyProposalToCart (409 when the merged cart would be too large; a cart created here is
 * rolled back with it). The body is not read: the button posts no fields.
 *
 * DEMO_MODE (decision С21): only /p/demo exists; its positions go to the demo cart cookie and
 * the visitor lands on /cart (handleDemoProposalTake).
 *
 * Logs: the VIN request id and line counts; never the proposal or cart token.
 */
import type { Env } from '@detaly/config';
import { and, carts, eq, isNull, type Database } from '@detaly/db';
import {
  copyProposalToCart,
  isProposalToken,
  loadProposal,
  type CopyProposalResult,
} from '@detaly/vin';
import { cartSetCookie, requestCookies } from '../cart/http';
import { MAX_CART_LINES, newCartToken, readCartToken } from '../cart-store';
import {
  DEMO_CART_COOKIE,
  decodeDemoCart,
  demoCartSetCookie,
  encodeDemoCart,
  newDemoLineId,
} from '../demo/cart-cookie';
import type { DemoProposalPick } from '../demo/proposal-fixture';
import { errorInfo } from '../errors';
import { isSameOrigin } from '../request-guards';
import { messagePage, seeOther } from './http';

export interface ProposalTakeLogger {
  info(details: Record<string, unknown>, message: string): void;
  error(details: Record<string, unknown>, message: string): void;
}

export interface ProposalTakeDeps {
  db: Database;
  env: Env;
  logger: ProposalTakeLogger;
  now?: () => Date;
}

export const TAKE_MESSAGES = {
  forbidden: 'Запрос отклонён: откройте подборку по ссылке ещё раз и нажмите «Оформить и оплатить»',
  notFound: 'Подборка не найдена — проверьте ссылку из сообщения',
  expired:
    'Срок подборки истёк или мастер прислал новую. Попросите мастера обновить подборку — по телефону или ответом на сообщение',
  cartFull: 'В корзине уже много позиций — оформите или очистите её, а потом вернитесь к подборке',
  internal: 'Не удалось перенести подборку в корзину — попробуйте ещё раз',
} as const;

/** A refusal that rolls the cart transaction back. */
class TakeRefused extends Error {
  constructor(readonly result: Extract<CopyProposalResult, { ok: false }>) {
    super(result.reason);
  }
}

function proposalPath(token: string): string {
  return `/p/${token}`;
}

export async function handleProposalTake(
  request: Request,
  token: string,
  deps: ProposalTakeDeps,
): Promise<Response> {
  const back = { href: '/', label: 'На главную' };
  if (!isSameOrigin(request.headers, deps.env.APP_BASE_URL)) {
    return messagePage(403, 'Подборка не оформлена', TAKE_MESSAGES.forbidden, back);
  }
  if (!isProposalToken(token)) {
    return messagePage(404, 'Подборка не найдена', TAKE_MESSAGES.notFound, back);
  }
  const toProposal = { href: proposalPath(token), label: 'Вернуться к подборке' };
  const now = deps.now?.() ?? new Date();
  try {
    const proposal = await loadProposal(deps.db, token, now);
    if (proposal === null) {
      return messagePage(404, 'Подборка не найдена', TAKE_MESSAGES.notFound, back);
    }
    if (proposal.expired) {
      return messagePage(410, 'Подборка устарела', TAKE_MESSAGES.expired, toProposal);
    }

    const cookieToken = readCartToken(requestCookies(request));
    let taken: { copied: Extract<CopyProposalResult, { ok: true }>; cartToken: string };
    try {
      taken = await deps.db.transaction(async (tx) => {
        let target =
          cookieToken === null
            ? undefined
            : (
                await tx
                  .select({ id: carts.id, anonToken: carts.anonToken })
                  .from(carts)
                  .where(
                    and(
                      eq(carts.anonToken, cookieToken),
                      eq(carts.status, 'active'),
                      isNull(carts.proposalToken),
                    ),
                  )
              )[0];
        if (!target) {
          const [created] = await tx
            .insert(carts)
            .values({ anonToken: newCartToken(), status: 'active', createdAt: now, updatedAt: now })
            .returning({ id: carts.id, anonToken: carts.anonToken });
          target = created;
        }
        if (!target?.anonToken) throw new Error('proposal take: no target cart');
        const copied = await copyProposalToCart(tx, {
          proposalCartId: proposal.cartId,
          targetCartId: target.id,
          now,
        });
        // A refusal rolls back a cart created above.
        if (!copied.ok) throw new TakeRefused(copied);
        return { copied, cartToken: target.anonToken };
      });
    } catch (error) {
      if (!(error instanceof TakeRefused)) throw error;
      const { reason } = error.result;
      deps.logger.info({ vinRequest: proposal.vinRequestId, reason }, 'proposal take refused');
      switch (reason) {
        case 'expired':
          return messagePage(410, 'Подборка устарела', TAKE_MESSAGES.expired, toProposal);
        case 'cart_full':
        case 'too_many_searches':
          return messagePage(409, 'Корзина переполнена', TAKE_MESSAGES.cartFull, {
            href: '/cart',
            label: 'Открыть корзину',
          });
        case 'not_found':
          return messagePage(404, 'Подборка не найдена', TAKE_MESSAGES.notFound, back);
      }
    }
    const { copied, cartToken } = taken;
    deps.logger.info(
      { vinRequest: copied.vinRequestId, inserted: copied.inserted, updated: copied.updated },
      'proposal taken',
    );
    return seeOther('/checkout', [cartSetCookie(cartToken, deps.env)]);
  } catch (error) {
    deps.logger.error(errorInfo(error), 'proposal take failed');
    return messagePage(500, 'Подборка не оформлена', TAKE_MESSAGES.internal, toProposal);
  }
}

// ---------------------------------------------------------------------------------------------
// DEMO_MODE
// ---------------------------------------------------------------------------------------------

export interface DemoProposalTakeDeps {
  env: Pick<Env, 'APP_BASE_URL' | 'CART_TTL_DAYS' | 'SESSION_SECRET'>;
  /** The sample positions (server/demo/proposal-fixture.ts). */
  picks: () => Promise<DemoProposalPick[]>;
}

/**
 * /p/demo «Оформить и оплатить» in DEMO_MODE: the sample positions join the signed demo cart
 * (same offer: the sample's quantity), then 303 /cart. Prices are never stored: the demo cart
 * re-prices from the fixtures on every read.
 */
export async function handleDemoProposalTake(
  request: Request,
  deps: DemoProposalTakeDeps,
): Promise<Response> {
  if (!isSameOrigin(request.headers, deps.env.APP_BASE_URL)) {
    return messagePage(403, 'Подборка не оформлена', TAKE_MESSAGES.forbidden, {
      href: '/p/demo',
      label: 'Вернуться к подборке',
    });
  }
  const secret = deps.env.SESSION_SECRET;
  const lines = decodeDemoCart(requestCookies(request).get(DEMO_CART_COOKIE)?.value, secret);
  for (const pick of await deps.picks()) {
    const existing = lines.find((line) => line.offerId === pick.offerId);
    if (existing) existing.qty = pick.qty;
    else lines.push({ id: newDemoLineId(), q: pick.q, offerId: pick.offerId, qty: pick.qty });
  }
  if (lines.length > MAX_CART_LINES) {
    return messagePage(409, 'Корзина переполнена', TAKE_MESSAGES.cartFull, {
      href: '/cart',
      label: 'Открыть корзину',
    });
  }
  return seeOther('/cart', [demoCartSetCookie(encodeDemoCart(lines, secret), deps.env)]);
}
