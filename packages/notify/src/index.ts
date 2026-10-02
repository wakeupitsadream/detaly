// Public API of @detaly/notify. Step 0 stubs; implemented in work package P2.
import type { NotificationChannel } from '@detaly/domain/statuses';

export interface MessageButton {
  text: string;
  /** Opaque action payload; drivers encode it (Telegram callback_data <= 64 bytes). */
  action: string;
}

export interface RenderedMessage {
  text: string;
  buttons: MessageButton[][];
}

export interface NotifyRecipient {
  channel: NotificationChannel;
  chatId: string;
}

export interface Notifier {
  send(recipient: NotifyRecipient, message: RenderedMessage): Promise<void>;
}

/** Telegram callback_data `a:<action>:<orderId>:<nonce>`, throws when longer than 64 bytes. */
export function buildCallbackData(_action: string, _orderId: string, _nonce: string): string {
  throw new Error('not implemented: @detaly/notify buildCallbackData');
}
