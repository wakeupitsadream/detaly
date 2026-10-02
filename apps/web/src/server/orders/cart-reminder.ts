/**
 * «В корзине остались детали — оформить второй заказ» on /o/<token> (7.1, item 5): after
 * «Разделить на два заказа» the second part waits in the same browser's cart.
 */
import type { Executor } from '@detaly/db';
import { splitCartLines, type CartLine } from '@detaly/domain';
import { findActiveCart } from '../cart-store';

export interface CartReminder {
  text: string;
  href: string;
}

/** What to suggest for the lines left in the cart; null for an empty cart. */
export function cartReminder(lines: readonly CartLine[]): CartReminder | null {
  if (lines.length === 0) return null;
  const { local, toOrder } = splitCartLines(lines);
  if (local.length === 0) {
    return {
      text: 'В корзине остались детали под заказ — оформить второй заказ',
      href: '/checkout?part=order',
    };
  }
  if (toOrder.length === 0) {
    return {
      text: 'В корзине остались детали — оформить второй заказ',
      href: '/checkout',
    };
  }
  // Mixed again: let the cart page explain the payment schemes and the split.
  return { text: 'В корзине остались детали — оформить второй заказ', href: '/cart' };
}

/**
 * Reminder for the cart of this browser (token from the `cart` cookie, null when absent).
 * Never fails the order page: a database error just hides the reminder.
 */
export async function findCartReminder(
  db: Executor,
  cartToken: string | null,
  onError?: (error: unknown) => void,
): Promise<CartReminder | null> {
  if (cartToken === null) return null;
  try {
    const cart = await findActiveCart(db, cartToken);
    return cart ? cartReminder(cart.lines) : null;
  } catch (error) {
    onError?.(error);
    return null;
  }
}
