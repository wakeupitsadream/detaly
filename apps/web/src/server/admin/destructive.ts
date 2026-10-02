/**
 * Admin actions that cannot be undone (cancellations, a refund, a no-show): the card form
 * carries a «подтверждаю» tick (`confirm=on`), and the action handler refuses the post
 * without it, so a replayed or hand-made request cannot skip the confirmation (PLAN:
 * destructive actions are confirmed).
 */
import type { StaffActionCode } from '@detaly/orders';

export const DESTRUCTIVE_ADMIN_ACTIONS: ReadonlySet<StaffActionCode> = new Set([
  'refused',
  'cancel',
  'icancel',
  'noshow',
  'refund_payment',
  'retry_refund',
]);

/** Name and value of the confirmation checkbox. */
export const CONFIRM_FIELD = 'confirm';
export const CONFIRM_VALUE = 'on';
