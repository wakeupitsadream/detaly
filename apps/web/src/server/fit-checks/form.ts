/**
 * The fit check form of the cart (step 4, docs/fit-check.md): field names, error codes with
 * their Russian messages, and the parsing of the posted fields. Pure: the submit handler and the
 * cart page share it (a form post without JavaScript comes back as `?fit_error=<code>` — a code,
 * never a value: the VIN is not put into a URL).
 */
import { FIT_CHECK_COMMENT_MAX, FIT_CHECK_LINES_MAX, cleanFitComment } from '@detaly/domain';
import { normalizeVin } from '@detaly/vin/vin';
import { lineIdOf } from './paths';

/** Field names of the form. */
export const FIT_FORM_FIELDS = {
  vin: 'vin',
  comment: 'comment',
  /** The ticked cart lines (repeated). */
  lines: 'lines',
  /** «Все детали корзины»: every line of the cart, whatever is ticked. */
  all: 'all',
  /** The line the form was opened from (where the answer comes back to). */
  line: 'line',
} as const;

export const FIT_FORM_ERROR_CODES = [
  'vin',
  'vin_oiq',
  'comment',
  'lines',
  'lines_foreign',
  'pending',
  'cart',
  'closed',
  'form',
  'rate_limited',
  'internal',
] as const;
export type FitFormErrorCode = (typeof FIT_FORM_ERROR_CODES)[number];

export const FIT_FORM_MESSAGES: Record<FitFormErrorCode, string> = {
  vin: 'Проверьте VIN: 17 символов — латинские буквы и цифры',
  vin_oiq: 'В VIN не бывает букв O, I и Q — скорее всего, это цифры 0 и 1',
  comment: `Комментарий — не длиннее ${FIT_CHECK_COMMENT_MAX} символов`,
  lines: 'Отметьте хотя бы одну деталь',
  lines_foreign: 'Корзина изменилась — обновите страницу и отправьте ещё раз',
  pending: 'Эти детали мастер уже проверяет — ответ появится здесь',
  cart: 'Корзина пуста — добавьте детали из поиска',
  closed: 'Проверка откроется вместе с заказами на сайте',
  form: 'Форма устарела — обновите страницу и отправьте ещё раз',
  rate_limited: 'Слишком много проверок за сутки — позвоните нам, проверим по телефону',
  internal: 'Не удалось отправить — попробуйте ещё раз или позвоните нам',
};

export function isFitFormErrorCode(value: unknown): value is FitFormErrorCode {
  return typeof value === 'string' && (FIT_FORM_ERROR_CODES as readonly string[]).includes(value);
}

export { lineIdOf };

/** Characters a VIN may look like before normalizeVin (spaces, dashes, upper case, Cyrillic). */
function vinErrorCode(raw: string): 'vin' | 'vin_oiq' {
  const cleaned = raw.replace(/[\s-]+/gu, '').toUpperCase();
  return cleaned.length === 17 && /[OIQОІ]/u.test(cleaned) ? 'vin_oiq' : 'vin';
}

export interface FitFormInput {
  /** Normalized: upper case, no spaces or dashes, Cyrillic look-alikes as Latin. */
  vin: string;
  comment: string | null;
  /** Ticked line ids (lower case, unique); empty with `all`. */
  lineIds: string[];
  all: boolean;
  /** The line the form was opened from; null when absent or malformed. */
  line: string | null;
}

export type ParsedFitForm =
  { ok: true; input: FitFormInput } | { ok: false; codes: FitFormErrorCode[] };

/** Posted fields: one value per name except `lines` (every value). */
export interface FitFormFields {
  get(name: string): string | undefined;
  getAll(name: string): string[];
}

/** Every field is checked, so all errors show at once. */
export function parseFitForm(fields: FitFormFields): ParsedFitForm {
  const codes: FitFormErrorCode[] = [];
  const vinRaw = fields.get(FIT_FORM_FIELDS.vin) ?? '';
  const vin = normalizeVin(vinRaw);
  if (vin === null) codes.push(vinErrorCode(vinRaw));

  const comment = cleanFitComment(fields.get(FIT_FORM_FIELDS.comment));
  if (comment !== null && comment.length > FIT_CHECK_COMMENT_MAX) codes.push('comment');

  const all = ['on', '1', 'true'].includes((fields.get(FIT_FORM_FIELDS.all) ?? '').trim());
  const raw = fields.getAll(FIT_FORM_FIELDS.lines);
  const lineIds = [...new Set(raw.map(lineIdOf))];
  if (lineIds.some((id) => id === null) || raw.length > FIT_CHECK_LINES_MAX * 2) {
    codes.push('form');
  } else if (!all && lineIds.length === 0) {
    codes.push('lines');
  }

  if (codes.length > 0 || vin === null) return { ok: false, codes };
  return {
    ok: true,
    input: {
      vin,
      comment,
      lineIds: all ? [] : (lineIds as string[]),
      all,
      line: lineIdOf(fields.get(FIT_FORM_FIELDS.line)),
    },
  };
}
