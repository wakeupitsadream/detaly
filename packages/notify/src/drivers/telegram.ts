/**
 * Telegram driver. Phase 0 provides the callback_data codec and a driver over an injected
 * grammY-compatible `sendMessage`, so it is testable without network; wiring a real `Bot`/`Api`
 * is the worker's job. Phase 1C (docs/phase-1c-implementation.md section 7.1 item 1): the
 * packaging photo of `arrived` goes with `sendPhoto`, a blocked chat and «chat not found» are
 * ChannelBlockedError, 429 is a retryable TelegramRateLimitError.
 *
 * callback_data format (PLAN section 4): `a:<action>:<orderId>:<nonce>`, at most 64 bytes.
 */
import { randomBytes } from 'node:crypto';
import type { InputFile } from 'grammy';
import { ChannelBlockedError, type ChannelDriver } from '../notifier';
import type { MessageButton, RenderedMessage } from '../types';

export const CALLBACK_DATA_MAX_BYTES = 64;

/**
 * VERIFY: Telegram Bot API limits a photo caption to 1024 characters after entity parsing (we
 * send plain text, no parse_mode); a longer text goes as a separate message under the photo.
 */
export const TELEGRAM_CAPTION_MAX = 1024;

export class CallbackDataError extends Error {
  override name = 'CallbackDataError';
}

/**
 * Telegram answered 429 Too Many Requests. Retryable: the queue repeats the job with its backoff.
 * VERIFY: Bot API limits (about 1 message per second per chat, 30 per second in total) and that
 * `parameters.retry_after` is in seconds.
 */
export class TelegramRateLimitError extends Error {
  override name = 'TelegramRateLimitError';
  constructor(readonly retryAfterSec: number | null) {
    super(
      retryAfterSec === null
        ? 'telegram: too many requests'
        : `telegram: too many requests, retry after ${retryAfterSec}s`,
    );
  }
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

export interface TelegramPhotoOptions {
  caption?: string;
  reply_markup?: { inline_keyboard: TelegramInlineButton[][] };
}

/**
 * The subset of grammY `Api` the driver needs (`bot.api` satisfies it). `sendPhoto` is optional:
 * senders without it (alerts) get text only.
 */
export interface TelegramSender {
  sendMessage(
    chatId: number | string,
    text: string,
    other?: TelegramSendOptions,
  ): Promise<{ message_id: number }>;
  sendPhoto?(
    chatId: number | string,
    photo: InputFile,
    other?: TelegramPhotoOptions,
  ): Promise<{ message_id: number }>;
}

/** Bytes of a stored photo (FileStore key), or null when it is gone. */
export type PhotoLoader = (key: string) => Promise<Uint8Array | null>;

/** Wraps bytes for upload; the default lazily imports grammY's InputFile (server only). */
export type InputFileFactory = (bytes: Uint8Array, filename: string) => Promise<InputFile>;

const defaultInputFile: InputFileFactory = async (bytes, filename) => {
  const { InputFile: GrammyInputFile } = await import('grammy');
  return new GrammyInputFile(bytes, filename);
};

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

interface BotApiErrorShape {
  error_code?: unknown;
  description?: unknown;
  parameters?: { retry_after?: unknown } | null;
}

function botApiError(error: unknown): BotApiErrorShape | null {
  return typeof error === 'object' && error !== null ? (error as BotApiErrorShape) : null;
}

/**
 * The recipient cannot be reached in this chat any more: 403 (bot blocked, user deactivated,
 * kicked) or 400 «chat not found» (the chat was deleted). VERIFY: descriptions of the Bot API.
 */
export function isTelegramBlockedError(error: unknown): boolean {
  const e = botApiError(error);
  if (e === null) return false;
  if (e.error_code === 403) return true;
  return (
    e.error_code === 400 &&
    typeof e.description === 'string' &&
    /chat not found/iu.test(e.description)
  );
}

/** A 429 answer as TelegramRateLimitError, or null for anything else. */
export function telegramRateLimit(error: unknown): TelegramRateLimitError | null {
  const e = botApiError(error);
  if (e === null || e.error_code !== 429) return null;
  const retryAfter = e.parameters?.retry_after;
  return new TelegramRateLimitError(
    typeof retryAfter === 'number' && Number.isFinite(retryAfter) && retryAfter >= 0
      ? retryAfter
      : null,
  );
}

function mapSendError(error: unknown): unknown {
  if (isTelegramBlockedError(error)) return new ChannelBlockedError('telegram');
  return telegramRateLimit(error) ?? error;
}

export interface TelegramDriverOptions {
  api: TelegramSender;
  nonce?: () => string;
  /**
   * Phase 1C: reads a photo of `message.photos` (FileStore keys) for sendPhoto. Without it (or
   * without `api.sendPhoto`) photos are ignored and the text goes with sendMessage.
   */
  loadPhoto?: PhotoLoader;
  inputFile?: InputFileFactory;
}

export function createTelegramDriver(options: TelegramDriverOptions): ChannelDriver {
  const inputFile = options.inputFile ?? defaultInputFile;

  /** The first photo of the message, or null: no loader, no key, gone from the store. */
  async function photoOf(message: RenderedMessage): Promise<Uint8Array | null> {
    const key = message.photos?.[0];
    if (key === undefined || options.loadPhoto === undefined || !options.api.sendPhoto) {
      return null;
    }
    try {
      return await options.loadPhoto(key);
    } catch {
      // The photo is a bonus: a store failure must not hold back «заказ приехал».
      return null;
    }
  }

  return {
    channel: 'telegram',
    async send(address: string, message: RenderedMessage) {
      const keyboard = toInlineKeyboard(message.buttons, options.nonce);
      const markup = keyboard.length > 0 ? { inline_keyboard: keyboard } : undefined;
      try {
        const photo = await photoOf(message);
        const sendPhoto = options.api.sendPhoto?.bind(options.api);
        if (photo !== null && sendPhoto !== undefined) {
          const caption = message.text.length <= TELEGRAM_CAPTION_MAX;
          try {
            const file = await inputFile(photo, 'photo.jpg');
            const sent = await sendPhoto(
              address,
              file,
              caption ? { caption: message.text, ...(markup ? { reply_markup: markup } : {}) } : {},
            );
            if (caption) return { externalId: String(sent.message_id) };
            // Too long for a caption: the photo went alone, the text with the buttons follows.
          } catch (error) {
            // Blocked or rate-limited: the text would fail the same way. Anything else (a photo
            // Telegram refuses): the photo is a bonus, the text still goes.
            if (isTelegramBlockedError(error) || telegramRateLimit(error) !== null) throw error;
          }
        }
        const other: TelegramSendOptions = { link_preview_options: { is_disabled: true } };
        if (markup) other.reply_markup = markup;
        const sent = await options.api.sendMessage(address, message.text, other);
        return { externalId: String(sent.message_id) };
      } catch (error) {
        throw mapSendError(error);
      }
    },
  };
}
