/**
 * POST /api/vin: the client's VIN request (docs/phase-1c-implementation.md decision С12,
 * section 11 item 1).
 *
 * Order of checks: Origin (403) -> the checkout gate: RKN number, published documents, pickup
 * point (403; PLAN decision 14 of phase 0: no PD form before the RKN notice) -> the bounded
 * multipart body with at most VIN_PHOTOS_MAX photos re-encoded without metadata (413 / 422 /
 * 400) -> honeypot (400) -> fields (422, every error at once) -> the consent text is the one
 * the page showed (409) -> photos to the FileStore under vin/<id>/<uuid>.jpg -> createVinRequest
 * (user, consent with vin_request_id, the request, outbox notify/vin) -> the outbox nudge ->
 * 303 to /vin/sent/<link token> (Telegram chosen and the client bot configured: the deep link
 * to subscribe) or /vin/sent.
 *
 * Two answer modes: a form post without JavaScript gets 303 back to `/vin?e=<codes>` (codes,
 * never values: the browser keeps nothing, the client types again) and the 303 of success; the
 * form with JavaScript sends `Accept: application/json` and gets JSON with the status of the
 * code and `fields`, or `{location}` on success (fetch cannot read a 303 Location).
 *
 * Logs: the request id, maskVin, counts. Never the phone, the texts, the VIN in full or a token
 * (decision С28). Rate limits (vin: 5 per hour, 20 per day) are applied in src/proxy.ts.
 */
import type { Env } from '@detaly/config';
import type { Database } from '@detaly/db';
import { VIN_PHOTOS_MAX } from '@detaly/domain';
import { newFileKey, type FileStore } from '@detaly/files';
import { createLinkToken } from '@detaly/orders';
import {
  createVinRequest,
  maskVin,
  newVinRequestId,
  VinRequestInputError,
  type VinRequestInputField,
} from '@detaly/vin';
import type { CheckoutGate } from '../checkout-gate';
import { getClientIp } from '../client-ip';
import { errorInfo, isNamedError } from '../errors';
import {
  consentIp,
  HONEYPOT_FIELD,
  isHoneypotTripped,
  isSameOrigin,
  userAgentForConsent,
} from '../request-guards';
import { readPhotoForm, UploadError, uploadErrorStatus } from '../uploads';
import { errorsOf, parseVinForm, VIN_FORM_MESSAGES, type VinFormErrorCode } from './form';
import { jsonResponse, messagePage, seeOther, wantsJson } from './http';

export interface VinSubmitLogger {
  info(details: Record<string, unknown>, message: string): void;
  warn(details: Record<string, unknown>, message: string): void;
  error(details: Record<string, unknown>, message: string): void;
}

export interface VinSubmitDeps {
  db: Database;
  env: Env;
  files: FileStore;
  /** getCheckoutGate bound to env and db (decision С12: the form needs the open gate). */
  gate: () => Promise<CheckoutGate>;
  logger: VinSubmitLogger;
  now?: () => Date;
  /** Wakes the outbox dispatcher after the commit (decision Б1); best effort. */
  nudge?: () => void;
}

export const VIN_SUBMIT_MESSAGES = {
  forbiddenOrigin:
    'Запрос отклонён: откройте страницу подбора по VIN на сайте и отправьте заявку ещё раз',
  rejected: 'Запрос отклонён',
} as const;

/** Where a refused form post without JavaScript returns. */
const FORM_PATH = '/vin';

/** createVinRequest's rejected input -> the form's error code. */
const INPUT_FIELD_CODES: Record<VinRequestInputField, VinFormErrorCode> = {
  id: 'internal',
  vin: 'vin',
  car_text: 'car',
  need_text: 'need',
  phone: 'phone',
  channel: 'channel',
  photos: 'photos_failed',
  consent: 'documents',
  request_key: 'form',
};

function uploadCode(reason: UploadError['reason']): VinFormErrorCode {
  switch (reason) {
    case 'too_large':
      return 'photos_too_large';
    case 'too_many':
      return 'photos_too_many';
    case 'not_image':
      return 'photos_not_image';
    case 'bad_form':
      return 'form';
  }
}

/** HTTP status of a refused form in JSON mode. */
function statusOf(codes: readonly VinFormErrorCode[]): number {
  if (codes.includes('documents')) return 409;
  if (codes.includes('internal')) return 500;
  if (codes.includes('photos_failed')) return 503;
  if (codes.includes('form')) return 400;
  return 422;
}

export async function handleVinSubmit(request: Request, deps: VinSubmitDeps): Promise<Response> {
  const json = wantsJson(request);
  const now = deps.now ?? (() => new Date());

  /** A refused form: JSON with fields, or 303 back to the form with the codes. */
  const refuse = (codes: VinFormErrorCode[], status = statusOf(codes)): Response => {
    if (!json) return seeOther(`${FORM_PATH}?e=${codes.join(',')}#vin-form`);
    const { fields, form } = errorsOf(codes);
    return jsonResponse(status, {
      error: codes[0] ?? 'validation',
      message: form ?? 'Проверьте поля заявки',
      fields,
    });
  };

  if (!isSameOrigin(request.headers, deps.env.APP_BASE_URL)) {
    return json
      ? jsonResponse(403, {
          error: 'forbidden_origin',
          message: VIN_SUBMIT_MESSAGES.forbiddenOrigin,
        })
      : messagePage(403, 'Заявка не отправлена', VIN_SUBMIT_MESSAGES.forbiddenOrigin, {
          href: FORM_PATH,
          label: 'Открыть форму заявки',
        });
  }

  const gate = await deps.gate().catch((error: unknown) => {
    deps.logger.warn(errorInfo(error), 'vin: checkout gate failed');
    return null;
  });
  if (gate === null || !gate.open) {
    const message = gate?.message ?? 'Заявки на сайте временно не принимаются';
    return json
      ? jsonResponse(403, { error: 'closed', message })
      : messagePage(403, 'Заявка не отправлена', message, { href: FORM_PATH, label: 'Назад' });
  }

  const photosOn = deps.files.kind !== 'none';
  const maxFileMb = deps.env.FILES_MAX_UPLOAD_MB;
  let form;
  try {
    form = await readPhotoForm(request, {
      maxFiles: photosOn ? VIN_PHOTOS_MAX : 0,
      maxFileBytes: maxFileMb * 1024 * 1024,
    });
  } catch (error) {
    if (isNamedError(error, UploadError, 'UploadError')) {
      deps.logger.info({ reason: error.reason }, 'vin: upload refused');
      return refuse([uploadCode(error.reason)], uploadErrorStatus(error.reason));
    }
    throw error;
  }

  if (isHoneypotTripped(form.fields.get(HONEYPOT_FIELD))) {
    deps.logger.warn({}, 'vin honeypot');
    return json
      ? jsonResponse(400, { error: 'rejected', message: VIN_SUBMIT_MESSAGES.rejected })
      : messagePage(400, 'Заявка не отправлена', VIN_SUBMIT_MESSAGES.rejected, {
          href: FORM_PATH,
          label: 'Назад',
        });
  }

  const parsed = parseVinForm(form.fields);
  if (!parsed.ok) return refuse(parsed.codes);
  const { input } = parsed;
  // The consent must be the text the client saw and ticked (ч. 3 ст. 9 152-ФЗ).
  if (input.consentPdVersionId !== gate.docs.consentPd.id) return refuse(['documents']);

  // Photos first: the request row lists their keys. A failure after this point deletes them.
  const id = newVinRequestId();
  const keys: string[] = [];
  const dropPhotos = async () => {
    for (const key of keys) {
      await deps.files.delete(key).catch(() => undefined);
    }
  };
  try {
    for (const photo of form.photos) {
      const key = newFileKey('vin', id);
      await deps.files.put(key, photo, 'image/jpeg');
      keys.push(key);
    }
  } catch (error) {
    deps.logger.error(
      { ...errorInfo(error), photos: form.photos.length },
      'vin: photo store failed',
    );
    await dropPhotos();
    return refuse(['photos_failed']);
  }

  let created;
  try {
    created = await createVinRequest(deps.db, {
      id,
      vin: input.vin,
      carText: input.carText,
      needText: input.needText,
      phone: input.phone,
      channel: input.channel,
      photoKeys: keys,
      consent: {
        documentVersionId: gate.docs.consentPd.id,
        textSha256: gate.docs.consentPd.sha256,
        ip: consentIp(getClientIp(request.headers, deps.env.TRUSTED_IP_HEADER)),
        userAgent: userAgentForConsent(request.headers),
      },
      requestKey: input.requestKey,
      now: now(),
    });
  } catch (error) {
    await dropPhotos();
    if (isNamedError(error, VinRequestInputError, 'VinRequestInputError')) {
      deps.logger.info({ field: error.field }, 'vin: input refused');
      return refuse([INPUT_FIELD_CODES[error.field]]);
    }
    deps.logger.error(errorInfo(error), 'vin: request failed');
    return refuse(['internal']);
  }
  if (created.duplicate) {
    // A repeated submit of the same form: the first request stands, these uploads are nobody's.
    await dropPhotos();
  } else {
    try {
      deps.nudge?.();
    } catch {
      // best effort: the dispatcher polls anyway
    }
  }
  deps.logger.info(
    {
      vinRequest: created.vinRequestId,
      vin: maskVin(input.vin),
      photos: created.duplicate ? 0 : keys.length,
      channel: input.channel,
      duplicate: created.duplicate,
    },
    'vin request created',
  );

  let location = '/vin/sent';
  if (input.channel === 'telegram' && deps.env.TG_CLIENT_BOT_USERNAME) {
    try {
      const link = await createLinkToken(deps.db, {
        userId: created.userId,
        channel: 'telegram',
        now: now(),
      });
      // In the path, not the query: the Caddy log filter cuts /vin/sent/<token> (decision С12).
      location = `/vin/sent/${link.token}`;
    } catch (error) {
      // The request is in; only the subscribe button is missing (the proposal goes by SMS).
      deps.logger.warn(errorInfo(error), 'vin: link token failed');
    }
  }
  return json ? jsonResponse(200, { location }) : seeOther(location);
}

/** The Russian message of a code (tests, the page). */
export function vinFormMessage(code: VinFormErrorCode): string {
  return VIN_FORM_MESSAGES[code];
}
