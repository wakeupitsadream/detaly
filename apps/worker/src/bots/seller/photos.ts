// Photos sent to the seller bot (docs/phase-1c-implementation.md section 9 item 2, decisions С8,
// С17): the packaging photo — in reply to an open order card or to the «Фото упаковки» prompt —
// and the photo of the returned part — in reply to the «Принял возврат» prompt.
//
//   getFile -> download https://api.telegram.org/file/bot<token>/<path> through deps.fetch (at
//   most 20 MB, VERIFY: Bot API getFile limit) -> ingestImage (re-encoded JPEG, EXIF and GPS
//   removed) -> files.put(order/<order id>/<uuid>.jpg) -> addOrderPhoto (pphoto) or
//   acceptClaimReturn (cret) through performStaffAction -> «Фото сохранено», the card redrawn.
//
// Without a file store (FILES_STORAGE=none) the bot answers «Хранилище фото не настроено» and
// changes nothing. The download URL carries the bot token: it is never logged (describeBotError
// scrubs `bot<id>:<secret>` from error texts). Photos never go back to Telegram from here.
import {
  FilesDisabledError,
  ImageRejectedError,
  ingestImage,
  newFileKey,
  type ImageRejectReason,
} from '@detaly/files';
import { loadStaffActions1C, performStaffAction } from '@detaly/orders';
import type { Context, Middleware } from 'grammy';
import type { WorkerDeps } from '../../deps';
import { takeAwaiting } from './awaiting';
import type { CardService } from './cards';
import { describeBotError } from './errors';
import { loadStaffMember, type StaffMember } from './staff';

/** VERIFY: the Bot API serves files up to 20 MB through getFile (docs/external.md). */
export const TELEGRAM_FILE_MAX_BYTES = 20 * 1024 * 1024;
/** One download; a stuck connection must not hold the bot's update loop. */
export const TELEGRAM_FILE_TIMEOUT_MS = 30_000;

export const STORAGE_OFF = 'Хранилище фото не настроено';
export const DOWNLOAD_FAILED = 'Не получилось скачать фото из Telegram — пришлите его ещё раз';
export const PACKAGING_NOT_NOW =
  'Фото упаковки добавляется, пока деталь едет или ждёт в точке выдачи. Для возврата по претензии нажмите «Принял возврат»';

const MIB = 1024 * 1024;

function rejectMessage(reason: ImageRejectReason, maxMb: number): string {
  switch (reason) {
    case 'too_large':
      return `Фото слишком большое — до ${maxMb} МБ`;
    case 'too_many_pixels':
      return 'Фото слишком большое по размеру — уменьшите его и пришлите ещё раз';
    case 'not_image':
      return 'Это не фото — пришлите снимок (JPEG или PNG)';
  }
}

/** A photo reached the size limit before or while downloading. */
class FileTooLargeError extends Error {
  constructor() {
    super('telegram file is too large');
    this.name = 'FileTooLargeError';
  }
}

/** The file of a photo message: the largest size of a photo, or an image sent as a document. */
export function photoFileOf(
  message: Context['message'],
): { fileId: string; fileSize: number | null } | null {
  if (!message) return null;
  const sizes = message.photo;
  if (sizes && sizes.length > 0) {
    const largest = sizes.reduce((a, b) =>
      (b.width ?? 0) * (b.height ?? 0) > (a.width ?? 0) * (a.height ?? 0) ? b : a,
    );
    return { fileId: largest.file_id, fileSize: largest.file_size ?? null };
  }
  const document = message.document;
  if (
    document &&
    typeof document.mime_type === 'string' &&
    document.mime_type.startsWith('image/')
  ) {
    return { fileId: document.file_id, fileSize: document.file_size ?? null };
  }
  return null;
}

async function readLimited(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > maxBytes) throw new FileTooLargeError();
  if (response.body === null) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) throw new FileTooLargeError();
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new FileTooLargeError();
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/**
 * getFile + download through deps.fetch. Throws FileTooLargeError above `maxBytes` (checked on
 * the size Telegram reports, the Content-Length and while reading) and Error otherwise.
 */
export async function downloadTelegramFile(
  ctx: Context,
  deps: Pick<WorkerDeps, 'fetch'>,
  file: { fileId: string; fileSize: number | null },
  maxBytes: number,
): Promise<Uint8Array> {
  if (file.fileSize !== null && file.fileSize > maxBytes) throw new FileTooLargeError();
  const info = await ctx.api.getFile(file.fileId);
  if (typeof info.file_path !== 'string' || info.file_path === '') {
    throw new Error('telegram getFile: no file_path');
  }
  if (typeof info.file_size === 'number' && info.file_size > maxBytes) {
    throw new FileTooLargeError();
  }
  // VERIFY: the download URL of the Bot API (https://api.telegram.org/file/bot<token>/<path>).
  const root = (ctx.api.options?.apiRoot ?? 'https://api.telegram.org').replace(/\/+$/u, '');
  const response = await deps.fetch(`${root}/file/bot${ctx.api.token}/${info.file_path}`, {
    signal: AbortSignal.timeout(TELEGRAM_FILE_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`telegram file download: HTTP ${response.status}`);
  return readLimited(response, maxBytes);
}

type PhotoTarget =
  | { purpose: 'packaging'; orderId: string; claimId: null; viaCard: boolean }
  | { purpose: 'return'; orderId: string; claimId: string; viaCard: false };

/**
 * Downloads, re-encodes and stores the photo, then records it on the order (pphoto) or the
 * claim (cret). The stored file is deleted again when the action is refused. Returns the text
 * for the chat.
 */
async function savePhoto(
  ctx: Context,
  deps: WorkerDeps,
  target: PhotoTarget,
  staff: StaffMember,
  file: { fileId: string; fileSize: number | null },
): Promise<{ ok: boolean; message: string }> {
  const token = ctx.api.token;
  const maxMb = deps.env.FILES_MAX_UPLOAD_MB;
  const maxBytes = Math.min(TELEGRAM_FILE_MAX_BYTES, maxMb * MIB);
  let bytes: Uint8Array;
  try {
    const raw = await downloadTelegramFile(ctx, deps, file, maxBytes);
    bytes = (await ingestImage(raw, { maxBytes })).bytes;
  } catch (error) {
    if (error instanceof FileTooLargeError) {
      return { ok: false, message: rejectMessage('too_large', maxMb) };
    }
    if (error instanceof ImageRejectedError) {
      return { ok: false, message: rejectMessage(error.reason, maxMb) };
    }
    deps.logger.warn(
      { orderId: target.orderId, err: describeBotError(error, token) },
      'seller bot: photo download failed',
    );
    return { ok: false, message: DOWNLOAD_FAILED };
  }
  const key = newFileKey('order', target.orderId);
  try {
    await deps.files.put(key, bytes, 'image/jpeg');
  } catch (error) {
    if (error instanceof FilesDisabledError) return { ok: false, message: STORAGE_OFF };
    throw error;
  }
  const actor = { id: staff.id, role: staff.role, via: 'bot' as const };
  const result =
    target.purpose === 'return'
      ? await performStaffAction(deps.engine, {
          staff: actor,
          action: 'cret',
          targetId: target.claimId,
          input: { photoKey: key },
        })
      : await performStaffAction(deps.engine, {
          staff: actor,
          action: 'pphoto',
          targetId: target.orderId,
          input: { photoKey: key, photoKind: 'packaging' },
        });
  if (!result.ok) {
    // Nothing references the object: no orphan files in the store.
    await deps.files.delete(key).catch(() => undefined);
  }
  deps.logger.info(
    {
      orderId: target.orderId,
      action: target.purpose === 'return' ? 'cret' : 'pphoto',
      staffId: staff.id,
      ok: result.ok,
    },
    'seller bot photo',
  );
  return { ok: result.ok, message: result.message };
}

/**
 * Photo messages of staff: a reply to a pending «Фото упаковки» / «Принял возврат» prompt, or
 * a reply to an open order card (packaging). Anything else goes on (silence).
 */
export function photoHandler(input: { deps: WorkerDeps; cards: CardService }): Middleware<Context> {
  const { deps, cards } = input;
  return async (ctx, next) => {
    const message = ctx.message;
    const chatId = ctx.chat?.id;
    const userId = ctx.from?.id;
    const file = photoFileOf(message);
    if (!message || file === null || chatId === undefined || userId === undefined) return next();
    const replyTo = message.reply_to_message?.message_id;

    let target: PhotoTarget | null = null;
    const awaiting = await takeAwaiting(deps, chatId, userId, replyTo, ['photo']);
    if (awaiting !== null) {
      target =
        awaiting.purpose === 'return' && awaiting.claimId !== null
          ? {
              purpose: 'return',
              orderId: awaiting.orderId,
              claimId: awaiting.claimId,
              viaCard: false,
            }
          : { purpose: 'packaging', orderId: awaiting.orderId, claimId: null, viaCard: false };
    } else if (replyTo !== undefined) {
      const card = await cards.openOrderCardAt(String(chatId), replyTo);
      if (card !== null) {
        target = { purpose: 'packaging', orderId: card.orderId, claimId: null, viaCard: true };
      }
    }
    if (target === null) return next();

    const staff = await loadStaffMember(deps.db, userId);
    if (staff === null) return;
    if (deps.files.kind === 'none') {
      await ctx.reply(STORAGE_OFF);
      return;
    }
    if (target.viaCard) {
      // A photo in reply to the card: only while «Фото упаковки» is on it (ordered, ready).
      const views = (await loadStaffActions1C(deps.engine, target.orderId, staff.role)) ?? [];
      if (!views.some((view) => view.code === 'pphoto' && view.enabled)) {
        await ctx.reply(PACKAGING_NOT_NOW);
        return;
      }
    }

    const result = await savePhoto(ctx, deps, target, staff, file);
    await ctx.reply(
      result.ok
        ? result.message
        : target.viaCard
          ? result.message
          : `${result.message}. Нажмите кнопку на карточке ещё раз.`,
    );
    if (result.ok) {
      try {
        await cards.refresh(target.orderId);
      } catch (error) {
        deps.logger.warn(
          { orderId: target.orderId, err: describeBotError(error, ctx.api.token) },
          'seller card refresh failed',
        );
      }
    }
  };
}
