/**
 * Short action codes used in buttons. Telegram callback_data is limited to 64 bytes and holds
 * `a:<action>:<id>:<nonce>` (decision Б18), so codes stay short: the longest code is 7 characters
 * and `a:` + 7 + `:` + 36 (uuid) + `:` + 8 (nonce) = 55 bytes.
 *
 * Two kinds of codes (phase 1B, docs/phase-1b-implementation.md table 13.2):
 * - EVENT_ACTIONS: one press applies one order event (code -> OrderEvent);
 * - MENU_ACTIONS: the press opens a menu (aliases, new ETA, item problem), picks an option from
 *   it, goes back to the main keyboard, retries a dead-letter job, or runs an owner action that
 *   is not one order event (`rrefund`: «Повторить возврат», staff action retry_refund). Options
 *   that end in an event carry it, plus the parameter the option stands for.
 *
 * `<id>` is the order uuid or the order item uuid depending on the code (actionTarget); `dlq`
 * carries a dead-letter job id instead.
 */
import type { OrderEvent } from '@detaly/domain';

export const EVENT_ACTIONS = {
  // --- client (Telegram/MAX client bot in phase 1C; /o/<token> applies the same events) -----
  confirm: 'client_confirmed',
  approve: 'client_approved',
  refund: 'client_refund_requested',
  // --- staff, order target (table 13.2) ---------------------------------------------------
  /** «Проверить и заказать»: the bot writes recheck_requested; the recheck job applies the event. */
  recheck: 'supplier_order_requested',
  /** «Отменить и вернуть деньги» / «Отказ клиента» (staff on the client's behalf, ст. 26.1). */
  refused: 'client_refused',
  cancel: 'order_cancelled',
  anyway: 'order_anyway',
  /** Owner only. */
  invpaid: 'supplier_invoice_paid',
  came: 'client_arrived',
  rcpt: 'offset_receipt_requested',
  qr: 'handover_payment_requested',
  handed: 'handed_over',
  /** «Клиент не пришёл»: only after the pickup window (decision Б10). */
  noshow: 'storage_expired',
  // --- staff, item target -------------------------------------------------------------------
  icancel: 'item_cancelled',
  iarr: 'item_arrived',
  // --- order-scope proposals (phase 0 codes, kept for eventForAction; the bot proposes per item
  // through the ialt/ieta menus, the admin may build an order-scope proposal by hand) -------
  alt: 'alternative_proposed',
  neweta: 'new_eta_proposed',
} as const satisfies Record<string, OrderEvent>;

export type EventAction = keyof typeof EVENT_ACTIONS;

/** Reasons of «Проблема с позицией»; same values as ItemProblem in @detaly/orders. */
export type ItemProblemCode = 'declined' | 'wrong' | 'damaged' | 'delay';

export type MenuActionSpec =
  /** Opens a menu instead of the main keyboard. */
  | { kind: 'open'; menu: 'alternative' | 'eta' | 'problem'; label: string }
  /** The n-th alternative from the last recheck_result (0-based). */
  | { kind: 'alternative'; index: 0 | 1 | 2; event: 'alternative_proposed'; label: string }
  /** New ETA: today + days in the client time zone. */
  | { kind: 'eta'; days: 2 | 5 | 7 | 14; event: 'new_eta_proposed'; label: string }
  | {
      kind: 'problem';
      problem: ItemProblemCode;
      event: 'item_problem' | 'item_damaged_on_receipt';
      label: string;
    }
  /** Back to the main keyboard of the card. */
  | { kind: 'back'; label: string }
  /** Owner: retry a dead-letter job; the id part is the dead-letter job id. */
  | { kind: 'dead_letter'; label: string }
  /** Owner: a staff action of @detaly/orders that is not one event; the id is the order id. */
  | { kind: 'staff'; action: 'retry_refund'; label: string };

export const MENU_ACTIONS = {
  ialt: { kind: 'open', menu: 'alternative', label: 'Аналог' },
  ieta: { kind: 'open', menu: 'eta', label: 'Новый срок' },
  iprob: { kind: 'open', menu: 'problem', label: 'Проблема с позицией' },
  back: { kind: 'back', label: 'Назад' },
  alt1: { kind: 'alternative', index: 0, event: 'alternative_proposed', label: 'Аналог 1' },
  alt2: { kind: 'alternative', index: 1, event: 'alternative_proposed', label: 'Аналог 2' },
  alt3: { kind: 'alternative', index: 2, event: 'alternative_proposed', label: 'Аналог 3' },
  eta2: { kind: 'eta', days: 2, event: 'new_eta_proposed', label: '+2 дня' },
  eta5: { kind: 'eta', days: 5, event: 'new_eta_proposed', label: '+5 дней' },
  eta7: { kind: 'eta', days: 7, event: 'new_eta_proposed', label: '+7 дней' },
  eta14: { kind: 'eta', days: 14, event: 'new_eta_proposed', label: '+14 дней' },
  pdecl: {
    kind: 'problem',
    problem: 'declined',
    event: 'item_problem',
    label: 'Поставщик отказал',
  },
  pwrong: { kind: 'problem', problem: 'wrong', event: 'item_problem', label: 'Пришла не та' },
  pdmg: {
    kind: 'problem',
    problem: 'damaged',
    event: 'item_damaged_on_receipt',
    label: 'Повреждена',
  },
  pdelay: { kind: 'problem', problem: 'delay', event: 'item_problem', label: 'Задержка' },
  dlq: { kind: 'dead_letter', label: 'Повторить' },
  rrefund: { kind: 'staff', action: 'retry_refund', label: 'Повторить возврат' },
} as const satisfies Record<string, MenuActionSpec>;

export type MenuAction = keyof typeof MENU_ACTIONS;

export type CallbackAction = EventAction | MenuAction;

/** Every callback code with its kind; no code is both an event and a menu action. */
export const CALLBACK_ACTIONS: Readonly<Record<CallbackAction, 'event' | 'menu'>> = Object.freeze({
  ...(Object.fromEntries(Object.keys(EVENT_ACTIONS).map((code) => [code, 'event'])) as Record<
    EventAction,
    'event'
  >),
  ...(Object.fromEntries(Object.keys(MENU_ACTIONS).map((code) => [code, 'menu'])) as Record<
    MenuAction,
    'menu'
  >),
});

/** What the `<id>` part of callback_data refers to. */
export type ActionTarget = 'order' | 'item' | 'order_or_item' | 'dead_letter';

const ITEM_ACTIONS: ReadonlySet<string> = new Set<CallbackAction>([
  'icancel',
  'iarr',
  'ialt',
  'ieta',
  'iprob',
  'alt1',
  'alt2',
  'alt3',
  'eta2',
  'eta5',
  'eta7',
  'eta14',
  'pdecl',
  'pwrong',
  'pdmg',
  'pdelay',
]);

/** Codes only the owner may press (section 13.1): sellers get a refusal without changes. */
export const OWNER_ONLY_ACTIONS = [
  'invpaid',
  'dlq',
  'rrefund',
] as const satisfies readonly CallbackAction[];

/** The callback code of a staff action that is not an event code (`retry_refund` -> `rrefund`). */
export function callbackCodeForStaffAction(action: string): string {
  for (const [code, spec] of Object.entries(MENU_ACTIONS) as [string, MenuActionSpec][]) {
    if (spec.kind === 'staff' && spec.action === action) return code;
  }
  return action;
}

/**
 * Codes a client may press in a messenger (client bot, phase 1C). `refused` is shared with staff:
 * the client's eta_changed message offers it («Вернуть деньги» / «Отказаться от заказа»).
 */
export const CLIENT_ACTIONS = [
  'confirm',
  'approve',
  'refund',
  'refused',
] as const satisfies readonly EventAction[];

export function isCallbackAction(value: string): value is CallbackAction {
  return Object.hasOwn(CALLBACK_ACTIONS, value);
}

export function isEventAction(value: string): value is EventAction {
  return Object.hasOwn(EVENT_ACTIONS, value);
}

export function isMenuAction(value: string): value is MenuAction {
  return Object.hasOwn(MENU_ACTIONS, value);
}

export function menuAction(value: string): MenuActionSpec | null {
  return isMenuAction(value) ? MENU_ACTIONS[value] : null;
}

export function isOwnerOnlyAction(value: string): boolean {
  return (OWNER_ONLY_ACTIONS as readonly string[]).includes(value);
}

/** The id kind of a code, or null for an unknown code. */
export function actionTarget(value: string): ActionTarget | null {
  if (!isCallbackAction(value)) return null;
  if (value === 'dlq') return 'dead_letter';
  if (value === 'back') return 'order_or_item';
  return ITEM_ACTIONS.has(value) ? 'item' : 'order';
}

/**
 * The order event a code leads to: event codes map directly (phase 0 behaviour), menu options
 * (alt1, eta5, pdmg ...) give the event of the option; menu openers, `back` and `dlq` -> null.
 */
export function eventForAction(action: string): OrderEvent | null {
  if (isEventAction(action)) return EVENT_ACTIONS[action];
  const spec = menuAction(action);
  return spec !== null && 'event' in spec ? spec.event : null;
}
