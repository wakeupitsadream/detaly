/**
 * The /vin form (docs/phase-1c-implementation.md decision С12): field names, error codes and
 * their Russian messages, and the parsing of the posted fields. Pure: the submit handler and
 * the page share it (the page turns `?e=<codes>` of a form post without JavaScript back into
 * messages; the codes never carry what was typed).
 */
import {
  normalizeMobilePhone,
  VIN_CAR_TEXT_MAX,
  VIN_NEED_TEXT_MAX,
  VIN_PHOTOS_MAX,
} from '@detaly/domain';
import {
  normalizeVin,
  VIN_ANSWER_CHANNELS,
  VIN_NEED_TEXT_MIN,
  type VinAnswerChannel,
} from '@detaly/vin';

/** Form fields of the error map (the client component marks these). */
export type VinFormField = 'vin' | 'car' | 'need' | 'photos' | 'phone' | 'channel' | 'consent';

/** Error codes of `/vin?e=…` (form post without JavaScript). */
export const VIN_FORM_ERROR_CODES = [
  'vin',
  'vin_oiq',
  'car',
  'need',
  'phone',
  'channel',
  'consent',
  'photos_too_large',
  'photos_too_many',
  'photos_not_image',
  'photos_failed',
  'form',
  'documents',
  'internal',
] as const;
export type VinFormErrorCode = (typeof VIN_FORM_ERROR_CODES)[number];

export const VIN_FORM_MESSAGES: Record<VinFormErrorCode, string> = {
  vin: 'Проверьте VIN: 17 символов — латинские буквы и цифры',
  vin_oiq: 'В VIN не бывает букв O, I и Q — скорее всего, это цифры 0 и 1',
  car: `Марка и модель — не длиннее ${VIN_CAR_TEXT_MAX} символов`,
  need: `Напишите, какая деталь нужна: от ${VIN_NEED_TEXT_MIN} до ${VIN_NEED_TEXT_MAX} символов`,
  phone: 'Мобильный номер: +7 или 8 и 10 цифр',
  channel: 'Выберите, куда прислать подборку: Telegram или SMS',
  consent: 'Без согласия на обработку персональных данных заявку не отправить',
  photos_too_large: 'Фото слишком большие — уменьшите их или пришлите другие',
  photos_too_many: `Не больше ${VIN_PHOTOS_MAX} фото`,
  photos_not_image: 'Файл не похож на фото — пришлите снимок JPEG или PNG',
  photos_failed: 'Не удалось сохранить фото — отправьте заявку ещё раз',
  form: 'Форма устарела — обновите страницу и отправьте заявку ещё раз',
  documents:
    'Мы обновили согласие на обработку данных — обновите страницу, прочитайте его и отправьте заявку ещё раз',
  internal: 'Не удалось отправить заявку — попробуйте ещё раз или позвоните нам',
};

/** Which field shows an error code (null: a message for the whole form). */
export const VIN_FORM_CODE_FIELD: Record<VinFormErrorCode, VinFormField | null> = {
  vin: 'vin',
  vin_oiq: 'vin',
  car: 'car',
  need: 'need',
  phone: 'phone',
  channel: 'channel',
  consent: 'consent',
  photos_too_large: 'photos',
  photos_too_many: 'photos',
  photos_not_image: 'photos',
  photos_failed: 'photos',
  form: null,
  documents: null,
  internal: null,
};

export function isVinFormErrorCode(value: string): value is VinFormErrorCode {
  return (VIN_FORM_ERROR_CODES as readonly string[]).includes(value);
}

/** `?e=vin,phone` -> known codes (unknown ones are dropped, at most one of each). */
export function parseErrorCodes(raw: string | string[] | undefined): VinFormErrorCode[] {
  const text = (Array.isArray(raw) ? raw[0] : raw) ?? '';
  const codes = text
    .slice(0, 200)
    .split(',')
    .map((code) => code.trim())
    .filter(isVinFormErrorCode);
  return [...new Set(codes)];
}

/** Messages by field and the form-level message for a list of codes. */
export function errorsOf(codes: readonly VinFormErrorCode[]): {
  fields: Partial<Record<VinFormField, string>>;
  form: string | null;
} {
  const fields: Partial<Record<VinFormField, string>> = {};
  let form: string | null = null;
  for (const code of codes) {
    const field = VIN_FORM_CODE_FIELD[code];
    if (field === null) form ??= VIN_FORM_MESSAGES[code];
    else fields[field] ??= VIN_FORM_MESSAGES[code];
  }
  return { fields, form };
}

/** Characters a VIN may look like before normalizeVin (spaces, dashes, upper case, Cyrillic). */
function vinErrorCode(raw: string): 'vin' | 'vin_oiq' {
  const cleaned = raw.replace(/[\s-]+/gu, '').toUpperCase();
  return cleaned.length === 17 && /[OIQОІ]/u.test(cleaned) ? 'vin_oiq' : 'vin';
}

export interface VinFormInput {
  vin: string;
  carText: string | null;
  needText: string;
  phone: string;
  channel: VinAnswerChannel;
  consentPdVersionId: string;
  requestKey: string;
}

export type ParsedVinForm =
  { ok: true; input: VinFormInput } | { ok: false; codes: VinFormErrorCode[] };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The posted text fields (`vin`, `car`, `need`, `phone`, `channel`, `consentPd`,
 * `consentPdVersionId`, `requestKey`). Every field is checked, so the client sees all errors at
 * once. `channel=max` is refused: MAX answers come in phase 2.
 */
export function parseVinForm(fields: ReadonlyMap<string, string>): ParsedVinForm {
  const get = (name: string) => fields.get(name) ?? '';
  const codes: VinFormErrorCode[] = [];

  const vinRaw = get('vin');
  const vin = normalizeVin(vinRaw);
  if (vin === null) codes.push(vinErrorCode(vinRaw));

  const car = get('car').trim();
  if (car.length > VIN_CAR_TEXT_MAX) codes.push('car');

  const need = get('need').trim();
  if (need.length < VIN_NEED_TEXT_MIN || need.length > VIN_NEED_TEXT_MAX) codes.push('need');

  const phone = normalizeMobilePhone(get('phone'));
  if (phone === null) codes.push('phone');

  const channelRaw = get('channel');
  const channel = (VIN_ANSWER_CHANNELS as readonly string[]).includes(channelRaw)
    ? (channelRaw as VinAnswerChannel)
    : null;
  if (channel === null) codes.push('channel');

  if (get('consentPd') !== 'on') codes.push('consent');

  const consentPdVersionId = get('consentPdVersionId');
  const requestKey = get('requestKey').toLowerCase();
  if (!UUID_RE.test(consentPdVersionId) || !UUID_RE.test(requestKey)) codes.push('form');

  if (codes.length > 0 || vin === null || phone === null || channel === null) {
    return { ok: false, codes };
  }
  return {
    ok: true,
    input: {
      vin,
      carText: car === '' ? null : car,
      needText: need,
      phone,
      channel,
      consentPdVersionId,
      requestKey,
    },
  };
}
