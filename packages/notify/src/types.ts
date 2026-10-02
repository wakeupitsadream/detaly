/**
 * Channel-neutral message model. Templates return text plus abstract buttons; drivers turn
 * them into Telegram inline keyboards, MAX buttons or plain SMS text.
 */
import type { MessengerChannel, NotificationChannel, PaymentScheme } from '@detaly/domain/statuses';
import type { IsoDate, Kop } from '@detaly/domain/types';

/** Callback button: drivers encode it (Telegram callback_data `a:<action>:<orderId>:<nonce>`). */
export interface ActionButton {
  kind: 'action';
  text: string;
  /** Short action code, see CALLBACK_ACTIONS. */
  action: string;
  orderId: string;
}

export interface UrlButton {
  kind: 'url';
  text: string;
  url: string;
}

export type MessageButton = ActionButton | UrlButton;

export interface RenderedMessage {
  text: string;
  /** Rows of buttons. */
  buttons: MessageButton[][];
  /**
   * Short text for SMS (no buttons, two segments at most): renderSmsText uses it instead of
   * `text` and appends the URL buttons. Set by the SMS allowlisted templates.
   */
  smsText?: string;
}

/** One messenger_bindings row, reduced to what channel selection needs. */
export interface MessengerBindingInfo {
  channel: MessengerChannel;
  chatId: string;
  isPrimary: boolean;
  blocked: boolean;
}

export type NotifyRecipient =
  /** A client: channel chosen from bindings, SMS fallback for allowlisted templates. */
  | { kind: 'client'; bindings: readonly MessengerBindingInfo[]; phone: string | null }
  /** A fixed chat (sellers chat, owner's private chat). */
  | { kind: 'chat'; channel: MessengerChannel; chatId: string };

export interface PickupPoint {
  name: string;
  address: string;
  hours: string;
}

/**
 * Data for order templates. Client templates may use only the order number, status, brand
 * and article (PD minimisation: Telegram is a foreign service); client phone and address are
 * accepted for staff cards and printed masked.
 */
export interface OrderTemplateData {
  /** BRAND_NAME from env; never hardcoded. */
  brandName: string;
  orderId: string;
  orderNumber: string;
  /** Secret order page /o/<token>. */
  orderUrl: string;
  scheme: PaymentScheme;
  items: readonly { brand: string; article: string }[];
  promisedDate?: IsoDate | null;
  totalKop?: Kop | null;
  paidAmountKop?: Kop | null;
  paymentUrl?: string | null;
  pickup?: PickupPoint | null;
  pickupCode?: string | null;
  /** Free text from staff (e.g. new ETA reason); must not contain PD. */
  note?: string | null;
  /** For staff cards only. */
  clientPhone?: string | null;
  adminUrl?: string | null;
  /** Supplier invoice to pay (awaiting_supplier_invoice). */
  supplierInvoice?: { number: string; amountKop: Kop } | null;
  /** Deadline shown to staff (supplier return, claim answer). */
  deadlineDate?: IsoDate | null;
  /** Days since the order became ready (reminders 3/6/9). */
  readyDays?: number | null;
  /**
   * Instant the client must answer by: confirm_request (orders.expires_at), decision_needed
   * (client_approvals.expires_at, or now + approval.timeout_h when sending). A Date or an ISO
   * timestamp (job data is JSON); shown in Asia/Yekaterinburg.
   */
  replyBy?: Date | string | null;
  /** Storage window by the offer (pickup.window_prepaid_days / pickup.window_cod_days). */
  storageDays?: number | null;
}

export interface VinProposalData {
  brandName: string;
  proposalUrl: string;
  /** Free text from the master; must not contain PD. */
  comment?: string | null;
}

export interface PingData {
  heartbeatAgeSec: number | null;
  dbOk: boolean;
  gitSha: string | null;
}

export type ChannelAddress = { channel: NotificationChannel; address: string };
