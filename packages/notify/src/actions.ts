/**
 * Short action codes used in buttons. Telegram callback_data is limited to 64 bytes and holds
 * `a:<action>:<id>:<nonce>` (decision Б18), so codes stay short: the longest code is 7 characters
 * and `a:` + 7 + `:` + 36 (uuid) + `:` + 8 (nonce) = 55 bytes.
 *
 * Three kinds of codes (phase 1B, docs/phase-1b-implementation.md table 13.2; phase 1C,
 * docs/phase-1c-implementation.md section 7.1 item 3):
 * - EVENT_ACTIONS: one press applies one order event (code -> OrderEvent);
 * - MENU_ACTIONS: the press opens a menu (aliases, new ETA, item problem), picks an option from
 *   it, goes back to the main keyboard, retries a dead-letter job, or runs an owner action that
 *   is not one order event (`rrefund`: «Повторить возврат», staff action retry_refund). Options
 *   that end in an event carry it, plus the parameter the option stands for;
 * - WORKFLOW_ACTIONS (phase 1C): client bot and seller bot workflows (installation slots,
 *   claims, bookings, the packaging photo, VIN requests) that call @detaly/orders and
 *   @detaly/vin functions, sometimes after a ForceReply question (decision С25).
 *
 * `<id>` is the order, item, claim, booking or VIN request uuid depending on the code
 * (actionTarget); `dlq` carries a dead-letter job id instead.
 */
import type { FitCheckAnswer, OrderEvent } from '@detaly/domain';

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

/**
 * Phase 1C workflow codes. Kept apart from MENU_ACTIONS so the phase 1B card menus stay a closed
 * set (the seller bot switches over MenuActionSpec kinds).
 */
export type WorkflowActionSpec =
  /** Client bot (decision С5): `install` lists slots, `islot` books one (nonce -> Redis). */
  | { kind: 'client'; action: 'install' | 'islot' | 'orders' | 'unsub'; label: string }
  /** Seller bot, claim target (decisions С8, С9). */
  | {
      kind: 'claim';
      action: 'return_accepted' | 'refund' | 'replace' | 'reject' | 'close';
      label: string;
    }
  /** Seller bot, booking target (decision С6). */
  | { kind: 'booking'; action: 'confirm' | 'decline' | 'done' | 'no_show'; label: string }
  /** Seller bot, order target: «Фото упаковки» (decision С17). */
  | { kind: 'photo'; action: 'packaging'; label: string }
  /** Seller bot, VIN request target (decision С13). */
  | { kind: 'vin'; action: 'take' | 'answer' | 'fix' | 'send' | 'close'; label: string }
  /**
   * Seller bot, fit check line target (step 4, docs/fit-check.md): the master's answer to one
   * line of a fit check card (`analog` asks for «БРЕНД АРТИКУЛ» with a ForceReply first).
   */
  | { kind: 'fit'; action: FitCheckAnswer; label: string }
  /**
   * Client bot, step 6 (docs/garage.md): «Мои машины» — the list (`garage`, the pressing user),
   * «Купить снова» (`rebuy`, an order), «Удалить машину» and its confirmation (`vdel`, `vdelok`,
   * a car of user_vehicles).
   */
  | { kind: 'garage'; action: 'list' | 'rebuy' | 'delete' | 'delete_confirmed'; label: string }
  /** Seller bot, step 6: «Пропустить» under the mileage question after «Выдал» (an order). */
  | { kind: 'mileage'; action: 'skip'; label: string };

export const WORKFLOW_ACTIONS = {
  // --- client bot ---------------------------------------------------------------------------
  install: { kind: 'client', action: 'install', label: 'Записаться на установку' },
  islot: { kind: 'client', action: 'islot', label: 'Выбрать время' },
  orders: { kind: 'client', action: 'orders', label: 'Мои заказы' },
  unsub: { kind: 'client', action: 'unsub', label: 'Отключить уведомления' },
  // --- seller bot: claims (StaffActionCode, docs/phase-1c-implementation.md 5.2 item 4) ------
  cret: { kind: 'claim', action: 'return_accepted', label: 'Принял возврат' },
  cref: { kind: 'claim', action: 'refund', label: 'Вернуть деньги' },
  crepl: { kind: 'claim', action: 'replace', label: 'Замена' },
  crej: { kind: 'claim', action: 'reject', label: 'Отказать' },
  cclose: { kind: 'claim', action: 'close', label: 'Замена выдана' },
  // --- seller bot: installation bookings ----------------------------------------------------
  bconf: { kind: 'booking', action: 'confirm', label: 'Подтвердить запись' },
  bdecl: { kind: 'booking', action: 'decline', label: 'Отклонить запись' },
  bdone: { kind: 'booking', action: 'done', label: 'Установка выполнена' },
  bnoshow: { kind: 'booking', action: 'no_show', label: 'Не приехал' },
  // --- seller bot: packaging photo ----------------------------------------------------------
  pphoto: { kind: 'photo', action: 'packaging', label: 'Фото упаковки' },
  // --- seller bot: VIN requests -------------------------------------------------------------
  vtake: { kind: 'vin', action: 'take', label: 'Взять в работу' },
  vans: { kind: 'vin', action: 'answer', label: 'Ответить строками' },
  vfix: { kind: 'vin', action: 'fix', label: 'Исправить' },
  vsend: { kind: 'vin', action: 'send', label: 'Отправить клиенту' },
  vclose: { kind: 'vin', action: 'close', label: 'Закрыть заявку' },
  // --- seller bot: fit checks (step 4, docs/fit-check.md) ----------------------------------
  ffit: { kind: 'fit', action: 'fits', label: 'Подходит' },
  fanlg: { kind: 'fit', action: 'analog', label: 'Аналог' },
  fnot: { kind: 'fit', action: 'not_fit', label: 'Не подходит' },
  fcall: { kind: 'fit', action: 'call_needed', label: 'Нужен звонок' },
  // --- client bot: «Мои машины» (step 6, docs/garage.md) -----------------------------------
  garage: { kind: 'garage', action: 'list', label: 'Мои машины' },
  rebuy: { kind: 'garage', action: 'rebuy', label: 'Купить снова' },
  vdel: { kind: 'garage', action: 'delete', label: 'Удалить машину' },
  vdelok: { kind: 'garage', action: 'delete_confirmed', label: 'Да, удалить' },
  // --- seller bot: the mileage at the handover (step 6) ------------------------------------
  mskip: { kind: 'mileage', action: 'skip', label: 'Пропустить' },
} as const satisfies Record<string, WorkflowActionSpec>;

export type WorkflowAction = keyof typeof WORKFLOW_ACTIONS;

export type CallbackAction = EventAction | MenuAction | WorkflowAction;

export type CallbackActionKind = 'event' | 'menu' | 'workflow';

function kindsOf<K extends string>(
  codes: Readonly<Record<K, unknown>>,
  kind: CallbackActionKind,
): Record<K, CallbackActionKind> {
  return Object.fromEntries(Object.keys(codes).map((code) => [code, kind])) as Record<
    K,
    CallbackActionKind
  >;
}

/** Every callback code with its kind; no code belongs to two kinds. */
export const CALLBACK_ACTIONS: Readonly<Record<CallbackAction, CallbackActionKind>> = Object.freeze(
  {
    ...kindsOf(EVENT_ACTIONS, 'event'),
    ...kindsOf(MENU_ACTIONS, 'menu'),
    ...kindsOf(WORKFLOW_ACTIONS, 'workflow'),
  },
);

/**
 * What the `<id>` part of callback_data refers to. Phase 1C: `claim` (claims.id), `booking`
 * (install_bookings.id), `vin` (vin_requests.id). The client bot's `orders` and `unsub` carry the
 * order of the message they are attached to; the bot acts on the pressing user. Step 4: `fit`
 * (fit_checks.id, one line of a fit check card). Step 6: `vehicle` (user_vehicles.id of «Удалить
 * машину»); «Мои машины» carries the list target like `orders`, «Купить снова» and the seller's
 * «Пропустить» an order.
 */
export type ActionTarget =
  | 'order'
  | 'item'
  | 'order_or_item'
  | 'dead_letter'
  | 'claim'
  | 'booking'
  | 'vin'
  | 'fit'
  | 'vehicle';

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
 * Event codes a client may press in a messenger (client bot, phase 1C). `refused` is shared with
 * staff: the client's eta_changed message offers it («Вернуть деньги» / «Отказаться от заказа»).
 */
export const CLIENT_ACTIONS = [
  'confirm',
  'approve',
  'refund',
  'refused',
] as const satisfies readonly EventAction[];

/**
 * Workflow codes a client may press in the client bot (decision С5): the installation menu and
 * the slot choice, «Мои заказы», «Отключить уведомления»; step 6 (docs/garage.md): «Мои машины»,
 * «Купить снова», «Удалить машину» and its confirmation.
 */
export const CLIENT_WORKFLOW_ACTIONS = [
  'install',
  'islot',
  'orders',
  'unsub',
  'garage',
  'rebuy',
  'vdel',
  'vdelok',
] as const satisfies readonly WorkflowAction[];

/** A code the client bot accepts (event or workflow); every other code is staff-only. */
export function isClientAction(value: string): boolean {
  return (
    (CLIENT_ACTIONS as readonly string[]).includes(value) ||
    (CLIENT_WORKFLOW_ACTIONS as readonly string[]).includes(value)
  );
}

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

export function isWorkflowAction(value: string): value is WorkflowAction {
  return Object.hasOwn(WORKFLOW_ACTIONS, value);
}

/** The spec of a phase 1C workflow code, or null. */
export function workflowAction(value: string): WorkflowActionSpec | null {
  return isWorkflowAction(value) ? WORKFLOW_ACTIONS[value] : null;
}

/** The callback code of a fit check answer (step 4): `fits` -> `ffit`. */
export function fitAnswerCode(answer: FitCheckAnswer): WorkflowAction {
  for (const [code, spec] of Object.entries(WORKFLOW_ACTIONS) as [
    WorkflowAction,
    WorkflowActionSpec,
  ][]) {
    if (spec.kind === 'fit' && spec.action === answer) return code;
  }
  throw new Error(`no callback code for the fit answer ${answer}`);
}

export function isOwnerOnlyAction(value: string): boolean {
  return (OWNER_ONLY_ACTIONS as readonly string[]).includes(value);
}

/** The id kind of a code, or null for an unknown code. */
export function actionTarget(value: string): ActionTarget | null {
  if (!isCallbackAction(value)) return null;
  if (value === 'dlq') return 'dead_letter';
  if (value === 'back') return 'order_or_item';
  const workflow = workflowAction(value);
  if (workflow !== null) {
    if (
      workflow.kind === 'claim' ||
      workflow.kind === 'booking' ||
      workflow.kind === 'vin' ||
      workflow.kind === 'fit'
    ) {
      return workflow.kind;
    }
    if (
      workflow.kind === 'garage' &&
      (workflow.action === 'delete' || workflow.action === 'delete_confirmed')
    ) {
      return 'vehicle';
    }
    return 'order';
  }
  return ITEM_ACTIONS.has(value) ? 'item' : 'order';
}

/**
 * The order event a code leads to: event codes map directly (phase 0 behaviour), menu options
 * (alt1, eta5, pdmg ...) give the event of the option; menu openers, `back`, `dlq` and the
 * phase 1C workflow codes (their functions decide which event, if any) -> null.
 */
export function eventForAction(action: string): OrderEvent | null {
  if (isEventAction(action)) return EVENT_ACTIONS[action];
  const spec = menuAction(action);
  return spec !== null && 'event' in spec ? spec.event : null;
}
