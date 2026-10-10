// Step 7 (docs/month-close.md): «Сдал водителю» and «Не берут» of a part going back to Rossko,
// on the order card. The id of the button is the supplier return; the caller (callbacks.ts)
// checked the nonce of the card, that the return belongs to the card's order and that the presser
// is staff (any role: the master hands the part to the driver).
//
// One press, one claim of the card (the nonce rotates, so a double tap is stale), then
// performStaffAction — itself idempotent under the order row lock: a second press from another
// card or the admin answers «Уже отмечено» and writes nothing — and the card is redrawn without
// the buttons of a return that left the point.
import { performStaffAction, type SupplierReturnStaffActionCode } from '@detaly/orders';
import type { ParsedCallbackData } from '@detaly/notify';
import type { Context } from 'grammy';
import type { WorkerDeps } from '../../deps';
import type { CardService, SellerCardRow } from './cards';
import { describeBotError } from './errors';
import { answerQuery } from './prompts';
import type { StaffMember } from './staff';

export const SUPPLIER_RETURN_CODES: ReadonlySet<string> = new Set<SupplierReturnStaffActionCode>([
  'srship',
  'srrej',
]);

export function isSupplierReturnCode(code: string): code is SupplierReturnStaffActionCode {
  return SUPPLIER_RETURN_CODES.has(code);
}

export async function handleSupplierReturnPress(
  ctx: Context,
  input: {
    deps: WorkerDeps;
    cards: CardService;
    card: SellerCardRow;
    parsed: ParsedCallbackData;
    staff: StaffMember;
  },
): Promise<void> {
  const { deps, cards, card, parsed, staff } = input;
  const code = parsed.action as SupplierReturnStaffActionCode;
  const token = ctx.api.token;
  if (!(await cards.claim(card))) {
    await answerQuery(ctx, 'Карточка устарела, откройте свежую');
    return;
  }
  let message: string;
  try {
    const result = await performStaffAction(deps.engine, {
      staff: { id: staff.id, role: staff.role, via: 'bot' },
      action: code,
      targetId: parsed.orderId,
    });
    message = result.message;
  } catch (error) {
    deps.logger.error(
      { orderId: card.orderId, action: code, err: describeBotError(error, token) },
      'seller bot action failed',
    );
    message = 'Не получилось, попробуйте ещё раз';
  }
  await answerQuery(ctx, message);
  let orderNumber: string | null = null;
  try {
    orderNumber = (await cards.redraw(card.id))?.orderNumber ?? null;
  } catch (error) {
    deps.logger.warn(
      { orderId: card.orderId, err: describeBotError(error, token) },
      'seller card redraw failed',
    );
  }
  deps.logger.info({ orderNumber, action: code, staffId: staff.id }, 'seller bot action');
}
