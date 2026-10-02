/**
 * Telegram driver (phase 1C). Phase 0 provides the callback_data codec and a driver over an
 * injected grammY-compatible `sendMessage`, so it is testable without network; wiring a real
 * `Bot`/`Api` is the worker's job.
 *
 * callback_data format (PLAN section 4): `a:<action>:<orderId>:<nonce>`, at most 64 bytes.
 */
import { randomBytes } from 'node:crypto';
import { ChannelBlockedError, type ChannelDriver } from '../notifier';
import type { MessageButton, RenderedMessage } from '../types';

export const CALLBACK_DATA_MAX_BYTES = 64;

export class CallbackDataError extends Error {
  override name = 'CallbackDataError';
}

const ACTION_RE = /^[a-z][a-z0-9_]*$/;
const ID_RE = /^[A-Za-z0-9-]+$/;
const NONCE_RE = /^[A-Za-z0-9_-]+$/;

/** Builds `a:<action>:<orderId>:<nonce>`; throws when a part is invalid or the result > 64 bytes. */
export function buildCallbackData(action: string, orderId: string, nonce: string): string {
  if (!ACTION_RE.test(action)) throw new CallbackDataError(`invalid action '${action}'`);
  if (!ID_RE.test(orderId)) throw new CallbackDataError('invalid order id');
  if (!NONCE_RE.test(nonce)) throw new CallbackDataError('invalid nonce');
  const data = `a:${action}:${orderId}:${nonce}`;
  const bytes = Buffer.byteLength(data, 'utf8');
  if (bytes > CALLBACK_DATA_MAX_BYTES) {
    throw new CallbackDataError(
      `callback_data is ${bytes} bytes, limit ${CALLBACK_DATA_MAX_BYTES}`,
    );
  }
  return data;
}

export interface ParsedCallbackData {
  action: string;
  orderId: string;
  nonce: string;
}

/** Inverse of buildCallbackData; null for anything else (never throws on user input). */
export function parseCallbackData(data: string): ParsedCallbackData | null {
  if (Buffer.byteLength(data, 'utf8') > CALLBACK_DATA_MAX_BYTES) return null;
  const parts = data.split(':');
  if (parts.length !== 4 || parts[0] !== 'a') return null;
  const [, action = '', orderId = '', nonce = ''] = parts;
  if (!ACTION_RE.test(action) || !ID_RE.test(orderId) || !NONCE_RE.test(nonce)) return null;
  return { action, orderId, nonce };
}

/** 6 random bytes -> 8 base64url characters. */
export function newNonce(): string {
  return randomBytes(6).toString('base64url');
}

export type TelegramInlineButton =
  { text: string; callback_data: string } | { text: string; url: string };

export interface TelegramSendOptions {
  reply_markup?: { inline_keyboard: TelegramInlineButton[][] };
  link_preview_options?: { is_disabled: boolean };
}

/** The subset of grammY `Api` the driver needs (`bot.api` satisfies it). */
export interface TelegramSender {
  sendMessage(
    chatId: number | string,
    text: string,
    other?: TelegramSendOptions,
  ): Promise<{ message_id: number }>;
}

export function toInlineKeyboard(
  buttons: readonly (readonly MessageButton[])[],
  nonce: () => string = newNonce,
): TelegramInlineButton[][] {
  return buttons
    .map((row) =>
      row.map((button): TelegramInlineButton =>
        button.kind === 'url'
          ? { text: button.text, url: button.url }
          : {
              text: button.text,
              callback_data: buildCallbackData(button.action, button.orderId, nonce()),
            },
      ),
    )
    .filter((row) => row.length > 0);
}

function isBlockedError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const e = error as { error_code?: unknown; description?: unknown };
  return e.error_code === 403;
}

export function createTelegramDriver(options: {
  api: TelegramSender;
  nonce?: () => string;
}): ChannelDriver {
  return {
    channel: 'telegram',
    async send(address: string, message: RenderedMessage) {
      const keyboard = toInlineKeyboard(message.buttons, options.nonce);
      const other: TelegramSendOptions = { link_preview_options: { is_disabled: true } };
      if (keyboard.length > 0) other.reply_markup = { inline_keyboard: keyboard };
      try {
        const sent = await options.api.sendMessage(address, message.text, other);
        return { externalId: String(sent.message_id) };
      } catch (error) {
        if (isBlockedError(error)) throw new ChannelBlockedError('telegram');
        throw error;
      }
    },
  };
}
