/**
 * Notifier: renders a template, picks a channel and hands the message to a driver.
 * Channel priority for clients (PLAN section 4): MAX when bound, else Telegram, else SMS for
 * allowlisted templates only; otherwise the notification is `skipped` with a fallback reason
 * (and transitions that wait for the client do not start their timers).
 */
import type { OrderNotifyTemplate } from '@detaly/domain';
import type { NotificationChannel } from '@detaly/domain/statuses';
import { renderOrderTemplate } from './templates/order';
import { renderPing } from './templates/ping';
import { renderVinProposal } from './templates/vin';
import type {
  ChannelAddress,
  NotifyRecipient,
  OrderTemplateData,
  PingData,
  RenderedMessage,
  VinProposalData,
} from './types';

/** Templates that may go by SMS when the client has no messenger (PLAN section 4). */
export const SMS_ALLOWED_TEMPLATES = [
  'confirm_request',
  'vin_proposal',
  'decision_needed',
  'arrived',
  'money_sent',
] as const satisfies readonly NotifyTemplateId[];

export type TemplateDataMap = { [K in OrderNotifyTemplate]: OrderTemplateData } & {
  vin_proposal: VinProposalData;
  ping: PingData;
};
export type NotifyTemplateId = keyof TemplateDataMap;

export function isSmsAllowed(template: NotifyTemplateId): boolean {
  return (SMS_ALLOWED_TEMPLATES as readonly string[]).includes(template);
}

export function renderTemplate<T extends NotifyTemplateId>(
  template: T,
  data: TemplateDataMap[T],
): RenderedMessage {
  if (template === 'ping') return renderPing(data as PingData);
  if (template === 'vin_proposal') return renderVinProposal(data as VinProposalData);
  return renderOrderTemplate(template as OrderNotifyTemplate, data as OrderTemplateData);
}

/** Fallback reasons written to notifications.fallback_reason. */
export const FALLBACK_REASONS = {
  noMessenger: 'no_messenger',
  notInSmsAllowlist: 'no_messenger:not_in_sms_allowlist',
  noPhone: 'no_messenger:no_phone',
  smsUnavailable: 'no_messenger:sms_unavailable',
  driverUnavailable: 'driver_unavailable',
} as const;

export type ChannelSelection =
  | { status: 'send'; channel: NotificationChannel; address: string; fallbackReason: string | null }
  | { status: 'skipped'; fallbackReason: string };

const MESSENGER_PRIORITY = ['max', 'telegram'] as const;

/**
 * Pure channel choice. `available` lists channels that have a configured driver;
 * `exclude` removes channels that just failed as blocked.
 */
export function selectChannel(
  recipient: NotifyRecipient,
  template: NotifyTemplateId,
  available: ReadonlySet<NotificationChannel>,
  exclude: ReadonlySet<NotificationChannel> = new Set(),
): ChannelSelection {
  if (recipient.kind === 'chat') {
    return available.has(recipient.channel) && !exclude.has(recipient.channel)
      ? {
          status: 'send',
          channel: recipient.channel,
          address: recipient.chatId,
          fallbackReason: null,
        }
      : { status: 'skipped', fallbackReason: FALLBACK_REASONS.driverUnavailable };
  }
  for (const channel of MESSENGER_PRIORITY) {
    if (!available.has(channel) || exclude.has(channel)) continue;
    const candidates = recipient.bindings.filter((b) => b.channel === channel && !b.blocked);
    const binding = candidates.find((b) => b.isPrimary) ?? candidates[0];
    if (binding !== undefined) {
      return { status: 'send', channel, address: binding.chatId, fallbackReason: null };
    }
  }
  if (!isSmsAllowed(template)) {
    return { status: 'skipped', fallbackReason: FALLBACK_REASONS.notInSmsAllowlist };
  }
  if (recipient.phone === null || recipient.phone.trim() === '') {
    return { status: 'skipped', fallbackReason: FALLBACK_REASONS.noPhone };
  }
  if (!available.has('sms') || exclude.has('sms')) {
    return { status: 'skipped', fallbackReason: FALLBACK_REASONS.smsUnavailable };
  }
  return {
    status: 'send',
    channel: 'sms',
    address: recipient.phone,
    fallbackReason: FALLBACK_REASONS.noMessenger,
  };
}

/** A driver: Telegram, MAX or SMS. Errors other than ChannelBlockedError are retried by the queue. */
export interface ChannelDriver {
  readonly channel: NotificationChannel;
  send(address: string, message: RenderedMessage): Promise<{ externalId: string | null }>;
}

/** The recipient blocked the bot (Telegram 403 and similar): try the next channel. */
export class ChannelBlockedError extends Error {
  override name = 'ChannelBlockedError';
  constructor(
    readonly channel: NotificationChannel,
    message = 'recipient blocked the bot',
  ) {
    super(message);
  }
}

export type NotifyResult =
  | {
      status: 'sent';
      channel: NotificationChannel;
      externalId: string | null;
      fallbackReason: string | null;
      /** Channels that turned out blocked; the caller sets messenger_bindings.blocked_at. */
      blocked: ChannelAddress[];
    }
  | { status: 'skipped'; fallbackReason: string; blocked: ChannelAddress[] };

export interface Notifier {
  send<T extends NotifyTemplateId>(
    recipient: NotifyRecipient,
    template: T,
    data: TemplateDataMap[T],
  ): Promise<NotifyResult>;
}

export function createNotifier(options: { drivers: readonly ChannelDriver[] }): Notifier {
  const drivers = new Map<NotificationChannel, ChannelDriver>();
  for (const driver of options.drivers) drivers.set(driver.channel, driver);
  const available = new Set(drivers.keys());

  return {
    async send(recipient, template, data) {
      const message = renderTemplate(template, data);
      const exclude = new Set<NotificationChannel>();
      const blocked: ChannelAddress[] = [];
      for (;;) {
        const selection = selectChannel(recipient, template, available, exclude);
        if (selection.status === 'skipped') {
          const fallbackReason =
            blocked.length > 0
              ? `blocked:${blocked.map((b) => b.channel).join(',')};${selection.fallbackReason}`
              : selection.fallbackReason;
          return { status: 'skipped', fallbackReason, blocked };
        }
        const driver = drivers.get(selection.channel) as ChannelDriver;
        try {
          const { externalId } = await driver.send(selection.address, message);
          const fallbackReason =
            blocked.length > 0
              ? `blocked:${blocked.map((b) => b.channel).join(',')}`
              : selection.fallbackReason;
          return {
            status: 'sent',
            channel: selection.channel,
            externalId,
            fallbackReason,
            blocked,
          };
        } catch (error) {
          if (!(error instanceof ChannelBlockedError)) throw error;
          blocked.push({ channel: selection.channel, address: selection.address });
          exclude.add(selection.channel);
        }
      }
    },
  };
}

/** Plain text for SMS: message text plus URLs of url buttons (action buttons are dropped). */
export function renderSmsText(message: RenderedMessage): string {
  const urls = message.buttons.flat().flatMap((b) => (b.kind === 'url' ? [b.url] : []));
  return [message.text, ...urls].join('\n');
}
