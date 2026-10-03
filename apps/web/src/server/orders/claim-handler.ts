/**
 * POST /api/orders/<token>/claims, multipart/form-data (docs/phase-1c-implementation.md section
 * 10.3, decisions С7, С18, С19): `kind`, `itemId` ('' for the whole order), `text`, `last4`,
 * `requestKey` and up to 3 `photos`. Opens a claim through the state machine (openClaim:
 * claim_opened, the claims row with deadline_at = opened_at + 10 days, notifications to the
 * client, the owner and the sellers).
 *
 * Order of checks: Origin (403) -> order token (404) -> order (404) -> the body, read bounded
 * (413 too large / too many photos, 422 not an image, 400 not a form) -> fields (422) ->
 * the attempt counter of the phone digits shared with 1A/1B (429, 503 when Redis is down) ->
 * the digits under the order row lock (422 wrong_digits) -> photos stored in the FileStore as
 * re-encoded JPEGs without metadata (claim/<order id>/<uuid>.jpg) -> openClaim (409 when the
 * kind is not available now or a claim is already open; the stored photos are deleted again)
 * -> 200 / 303 back to /o/<token>#claim. A repeated form (same requestKey) returns the claim it
 * created. The IP limit `claim` (10 per hour) is in src/proxy.ts.
 *
 * Logs: the order number, the kind and the outcome. Never the text, the digits, the token or
 * the file keys.
 */
import type { Logger, Redis } from '@detaly/config';
import { CLAIM_KINDS, CLAIM_PHOTOS_MAX, CLAIM_TEXT_MAX, type ClaimKind } from '@detaly/domain';
import { newFileKey, type FileStore } from '@detaly/files';
import { isUuid, openClaim, type EngineDeps } from '@detaly/orders';
import { errorInfo, isNamedError } from '../errors';
import { isSameOrigin } from '../request-guards';
import {
  PHOTO_FORM_MAX_TOTAL_BYTES,
  readPhotoForm,
  UploadError,
  uploadErrorMessage,
  uploadErrorStatus,
} from '../uploads';
import { isOrderToken } from './access';
import {
  digitsBlocked,
  DigitsUnavailableError,
  isLast4,
  verifyDigitsLocked,
  type DigitsCheck,
} from './digits';
import { formAnswer, jsonAnswer, type FormOutcome } from './form-response';

export const CLAIM_MESSAGES = {
  forbidden: 'Запрос отклонён. Обновите страницу и попробуйте ещё раз',
  notFound: 'Заказ не найден',
  kind: 'Выберите вид претензии',
  item: 'Выберите позицию или весь заказ',
  text: `Опишите проблему короче — до ${CLAIM_TEXT_MAX} символов`,
  digits: 'Введите последние 4 цифры телефона',
  stale: 'Форма устарела — обновите страницу',
  wrongDigits: 'Цифры не совпадают с номером телефона из заказа',
  tooMany: 'Слишком много неверных попыток. Попробуйте позже или позвоните нам',
  unavailable: 'Сейчас не получается принять претензию, попробуйте через минуту',
  opened: 'Претензия принята',
  internal: 'Ошибка сервера, попробуйте позже',
} as const;

export interface ClaimHandlerDeps {
  engine: EngineDeps;
  redis: Redis;
  /** Prepended to Redis keys; tests use `test:<uuid>:`. */
  keyPrefix?: string;
  files: FileStore;
  /** FILES_MAX_UPLOAD_MB in bytes. */
  maxFileBytes: number;
  appBaseUrl: string;
  logger?: Pick<Logger, 'info' | 'warn' | 'error'>;
}

interface ClaimFields {
  kind: ClaimKind;
  itemId: string | null;
  text: string;
  last4: string;
  requestKey: string;
}

function isClaimKind(value: unknown): value is ClaimKind {
  return typeof value === 'string' && (CLAIM_KINDS as readonly string[]).includes(value);
}

function invalid(message: string, code = 'validation'): FormOutcome {
  return { status: 422, code, message, flash: 'claim_invalid' };
}

function parseFields(fields: Map<string, string>): ClaimFields | FormOutcome {
  const requestKey = (fields.get('requestKey') ?? '').toLowerCase();
  if (!isUuid(requestKey)) return invalid(CLAIM_MESSAGES.stale);
  const kind = fields.get('kind');
  if (!isClaimKind(kind)) return invalid(CLAIM_MESSAGES.kind);
  const rawItem = (fields.get('itemId') ?? '').trim().toLowerCase();
  if (rawItem !== '' && !isUuid(rawItem)) return invalid(CLAIM_MESSAGES.item);
  // Line breaks are normalized the way a textarea counts them.
  const text = (fields.get('text') ?? '').replace(/\r\n/g, '\n').trim();
  if (text.length > CLAIM_TEXT_MAX) return invalid(CLAIM_MESSAGES.text);
  const last4 = (fields.get('last4') ?? '').trim();
  if (!isLast4(last4)) return invalid(CLAIM_MESSAGES.digits, 'digits_required');
  return { kind, itemId: rawItem === '' ? null : rawItem, text, last4, requestKey };
}

function digitsOutcome(check: Exclude<DigitsCheck, { kind: 'ok' }>): FormOutcome {
  switch (check.kind) {
    case 'not_found':
      return {
        status: 404,
        code: 'not_found',
        message: CLAIM_MESSAGES.notFound,
        flash: 'claim_error',
      };
    case 'too_many_attempts':
      return {
        status: 429,
        code: 'too_many_attempts',
        message: CLAIM_MESSAGES.tooMany,
        flash: 'claim_too_many',
        headers: { 'Retry-After': String(check.retryAfterSec) },
      };
    case 'wrong_digits':
      return {
        status: 422,
        code: 'wrong_digits',
        message: CLAIM_MESSAGES.wrongDigits,
        flash: 'claim_wrong_digits',
        extra: { attemptsLeft: check.attemptsLeft },
      };
  }
}

/** Best effort: a photo of a claim that was not opened is not kept. */
async function dropPhotos(files: FileStore, keys: readonly string[]): Promise<void> {
  await Promise.all(keys.map((key) => files.delete(key).catch(() => undefined)));
}

export async function handleClaimRequest(
  request: Request,
  token: string,
  deps: ClaimHandlerDeps,
): Promise<Response> {
  if (!isSameOrigin(request.headers, deps.appBaseUrl)) {
    return jsonAnswer({ error: 'forbidden_origin', message: CLAIM_MESSAGES.forbidden }, 403);
  }
  if (!isOrderToken(token)) {
    return jsonAnswer({ error: 'not_found', message: CLAIM_MESSAGES.notFound }, 404);
  }
  const { engine, logger, files } = deps;
  const answer = (outcome: FormOutcome) => formAnswer(request, deps.appBaseUrl, token, outcome);
  let stored: string[] = [];
  try {
    const order = await engine.db.query.orders.findFirst({
      where: (t, ops) => ops.eq(t.accessToken, token),
      columns: { id: true, number: true, userId: true },
    });
    if (!order) return jsonAnswer({ error: 'not_found', message: CLAIM_MESSAGES.notFound }, 404);

    const maxFiles = files.kind === 'none' ? 0 : CLAIM_PHOTOS_MAX;
    let form: Awaited<ReturnType<typeof readPhotoForm>>;
    try {
      form = await readPhotoForm(request, {
        maxFiles,
        maxFileBytes: deps.maxFileBytes,
        maxTotalBytes: PHOTO_FORM_MAX_TOTAL_BYTES,
      });
    } catch (error) {
      if (!(error instanceof UploadError)) throw error;
      logger?.info({ order: order.number, upload: error.reason }, 'order: claim upload refused');
      return answer({
        status: uploadErrorStatus(error.reason),
        code: error.reason,
        message: uploadErrorMessage(error.reason, {
          maxFiles,
          maxFileMb: Math.round(deps.maxFileBytes / (1024 * 1024)),
        }),
        flash: error.reason === 'bad_form' ? 'claim_invalid' : 'claim_photos',
      });
    }
    const parsed = parseFields(form.fields);
    if ('status' in parsed) return answer(parsed);

    const digits = { redis: deps.redis, keyPrefix: deps.keyPrefix ?? '', now: engine.now };
    const blocked = await digitsBlocked(digits, order.id);
    if (blocked) return answer(digitsOutcome(blocked));
    // The comparison runs under the row lock; openClaim takes the lock again in its own
    // transaction (the same split as the 1B client actions).
    const check = await engine.db.transaction((tx) =>
      verifyDigitsLocked(tx, digits, { orderId: order.id, last4: parsed.last4 }),
    );
    if (check.kind !== 'ok') {
      if (check.kind !== 'not_found') {
        logger?.warn({ order: order.number, result: check.kind }, 'order: claim digits');
      }
      return answer(digitsOutcome(check));
    }

    for (const bytes of form.photos) {
      const key = newFileKey('claim', order.id);
      await files.put(key, bytes, 'image/jpeg');
      stored.push(key);
    }
    const result = await openClaim(engine, {
      orderId: order.id,
      itemId: parsed.itemId,
      kind: parsed.kind,
      text: parsed.text === '' ? null : parsed.text,
      photoKeys: stored,
      via: 'web',
      requestKey: parsed.requestKey,
      actor: { type: 'client', id: order.userId },
    });
    if (!result.ok || result.duplicate) {
      // A refused claim, or a repeated form whose claim already has its own photos.
      await dropPhotos(files, stored);
      stored = [];
    }
    if (result.ok) {
      logger?.info(
        {
          order: order.number,
          kind: parsed.kind,
          photos: form.photos.length,
          duplicate: result.duplicate,
        },
        'order: claim opened',
      );
      return answer({
        status: 200,
        code: 'opened',
        message: CLAIM_MESSAGES.opened,
        flash: 'claim_opened',
        extra: { claimId: result.claimId, deadlineAt: result.deadlineAt.toISOString() },
      });
    }
    logger?.info(
      { order: order.number, kind: parsed.kind, reason: result.reason },
      'order: claim refused',
    );
    const status = result.reason === 'not_found' ? 404 : result.reason === 'bad_input' ? 422 : 409;
    return answer({
      status,
      code: result.reason,
      message: result.message,
      flash: status === 422 ? 'claim_invalid' : 'claim_unavailable',
      ...(result.kinds ? { extra: { kinds: result.kinds } } : {}),
    });
  } catch (error) {
    await dropPhotos(files, stored);
    if (isNamedError(error, DigitsUnavailableError, 'DigitsUnavailableError')) {
      logger?.warn(errorInfo(error.cause), 'order: claim attempt counter unavailable');
      return answer({
        status: 503,
        code: 'unavailable',
        message: CLAIM_MESSAGES.unavailable,
        flash: 'claim_error',
        headers: { 'Retry-After': '60' },
      });
    }
    // Names and SQLSTATE only: driver messages carry the query parameters (the token).
    logger?.error(errorInfo(error), 'order: claim failed');
    return answer({
      status: 500,
      code: 'internal',
      message: CLAIM_MESSAGES.internal,
      flash: 'claim_error',
    });
  }
}
