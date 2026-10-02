/**
 * Error codes of the cart API (docs/phase-1a-implementation.md section 5.1). The code is what a
 * no-JS form gets in `/cart?error=<code>`; the page turns it back into the message below.
 */
import { MAX_CART_LINES, MAX_CART_SEARCHES } from '../cart-store';

export type CartErrorCode =
  | 'forbidden_origin'
  | 'invalid'
  | 'offer_not_found'
  | 'line_not_found'
  | 'excluded'
  | 'qty'
  | 'cart_full'
  | 'too_many_searches'
  | 'supplier_unavailable'
  | 'internal';

const STATUS: Record<CartErrorCode, number> = {
  forbidden_origin: 403,
  invalid: 400,
  offer_not_found: 404,
  line_not_found: 404,
  excluded: 422,
  qty: 422,
  cart_full: 422,
  too_many_searches: 422,
  supplier_unavailable: 503,
  internal: 500,
};

/** Default client text per code (a `qty` error usually carries a more precise one). */
export const CART_ERROR_MESSAGES: Record<CartErrorCode, string> = {
  forbidden_origin: 'Запрос отклонён: откройте корзину на сайте и повторите',
  invalid: 'Не удалось изменить корзину: неверный запрос',
  offer_not_found: 'Это предложение больше недоступно — повторите поиск',
  line_not_found: 'Этой позиции уже нет в корзине',
  excluded: 'Не продаём онлайн, спросите в сервисе',
  qty: 'Такое количество выбрать нельзя: проверьте остаток и кратность',
  cart_full: `В корзине уже ${MAX_CART_LINES} позиций — оформите заказ или удалите лишнее`,
  too_many_searches: `В корзине детали из ${MAX_CART_SEARCHES} разных поисков — оформите заказ или удалите лишнее`,
  supplier_unavailable: 'Поставщик сейчас не отвечает, попробуйте через минуту',
  internal: 'Ошибка сервера, попробуйте позже',
};

export function isCartErrorCode(value: unknown): value is CartErrorCode {
  return typeof value === 'string' && Object.hasOwn(STATUS, value);
}

export class CartRequestError extends Error {
  override name = 'CartRequestError';
  readonly code: CartErrorCode;
  readonly status: number;
  /** Seconds, for 503 after a Rossko rate-limit wait. */
  readonly retryAfterSec: number | null;

  constructor(
    code: CartErrorCode,
    message: string = CART_ERROR_MESSAGES[code],
    retryAfterSec: number | null = null,
  ) {
    super(message);
    this.code = code;
    this.status = STATUS[code];
    this.retryAfterSec = retryAfterSec;
  }
}
