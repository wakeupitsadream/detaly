// Pure rendering of fit check cards in the sellers chat (step 4, docs/fit-check.md): the full VIN
// (the master needs it to check the part; it is shown nowhere else), the client's comment with
// digit runs, plates and e-mails masked (maskClientText: a phone typed into it never reaches
// Telegram), and the lines «1. MANN W 914/2 — Фильтр масляный» with what was answered, by whom
// and when. A fit check has no client phone or name, so the card has none either.
//
// Buttons of every line still waiting: «1 · Подходит» «1 · Аналог» / «1 · Не подходит»
// «1 · Нужен звонок» (callback_data `a:<code>:<fit check id>:<nonce>` through buildCallbackData);
// then «Открыть в админке».
import {
  FIT_CHECK_ANSWER_LABELS,
  fitRequestNumber,
  maskClientText,
  type FitCheckAnswer,
} from '@detaly/domain';
import { buildCallbackData, fitAnswerCode, formatReplyBy } from '@detaly/notify';
import type { FitLineStaffView, FitRequestStaffView } from '@detaly/vin';
import { adminRow, type InlineKeyboard } from './card-view';

/** Telegram refuses longer messages (4096); the card stays well below. */
export const FIT_CARD_TEXT_MAX = 3900;
/** The comment is at most 200 characters already (fit_checks.comment). */
const COMMENT_MAX = 200;

/** First line of the card. */
export const FIT_CARD_HEADLINE = 'Проверка применимости';

/** What an analog costs the client and when it comes, as the cart will show it. */
export interface FitAnalogPrice {
  /** '528 ₽' */
  priceText: string;
  /** 'к пт 10 октября' */
  promiseText: string | null;
}

export interface FitCardData {
  request: FitRequestStaffView;
  /** The analog price of a line by its id (the card service prices it with priceOffer). */
  analogPrices: ReadonlyMap<string, FitAnalogPrice>;
  /** «Без ответа больше часа — клиент ждёт» (the SLA reminder); no PD. */
  note?: string | null;
  /** «Ответьте в течение часа» from the SLA setting. */
  slaText: string;
  /** APP_BASE_URL/admin/fit-checks */
  adminUrl: string;
}

const STATUS_MARKS: Record<Exclude<FitLineStaffView['status'], 'analog'>, string> = {
  pending: '⏳ ждёт ответа',
  fits: '✓ Подходит',
  not_fit: '✗ Не подходит',
  call_needed: '☎ Нужен звонок: клиент увидит телефон точки и позвонит',
  expired: '⌛ Не успели ответить за 24 часа',
  cancelled: '— Отменена: позиции больше нет в корзине',
};

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** «Лёша, 14:05 9 октября» / «админка, …»: who answered and when. */
function whoAndWhen(line: FitLineStaffView): string {
  if (line.answeredAt === null) return '';
  const who = line.answeredBy?.name ?? 'админка';
  const when = formatReplyBy(line.answeredAt);
  return ` · ${who}${when ? `, ${when}` : ''}`;
}

/** The answer of one line: «✓ Подходит · Лёша, 14:05 9 октября». */
export function fitAnswerText(line: FitLineStaffView, price: FitAnalogPrice | undefined): string {
  if (line.status === 'analog') {
    const analog = line.analog;
    const what = analog ? `${analog.brand} ${analog.article} — ${analog.name}` : 'аналог';
    const money = price
      ? `, ${price.priceText}${price.promiseText ? `, ${price.promiseText}` : ''}`
      : '';
    return `↔ Аналог: ${what}${money}${whoAndWhen(line)}`;
  }
  return `${STATUS_MARKS[line.status]}${whoAndWhen(line)}`;
}

export function renderFitCardText(data: FitCardData): string {
  const { request } = data;
  const lines: string[] = [];
  lines.push(`${FIT_CARD_HEADLINE} № ${fitRequestNumber(request.requestId)}`);
  if (data.note) lines.push(data.note);
  lines.push(request.vin ? `VIN ${request.vin}` : 'VIN удалён по сроку хранения');
  if (request.comment) {
    lines.push(`Комментарий: «${clip(maskClientText(request.comment), COMMENT_MAX)}»`);
  }
  for (const line of request.lines) {
    lines.push('', `${line.n}. ${line.brand} ${line.article} — ${line.name}`);
    lines.push(`   ${fitAnswerText(line, data.analogPrices.get(line.id))}`);
  }
  lines.push('');
  if (request.lines.some((line) => line.status === 'pending')) {
    lines.push(`${data.slaText}. Ответ клиент увидит в корзине на сайте.`);
    lines.push('«Аналог» — ответом «БРЕНД АРТИКУЛ», например «KNECHT OC90».');
  } else {
    lines.push('Все позиции отвечены.');
  }
  return clip(lines.join('\n'), FIT_CARD_TEXT_MAX);
}

const ROWS: readonly (readonly FitCheckAnswer[])[] = [
  ['fits', 'analog'],
  ['not_fit', 'call_needed'],
];

/** Two rows of answers for every line still waiting, then the admin link. */
export function fitKeyboard(data: FitCardData, nonce: string): InlineKeyboard {
  const rows: InlineKeyboard = [];
  for (const line of data.request.lines) {
    if (line.status !== 'pending') continue;
    for (const answers of ROWS) {
      rows.push(
        answers.map((answer) => ({
          text: `${line.n} · ${FIT_CHECK_ANSWER_LABELS[answer]}`,
          callback_data: buildCallbackData(fitAnswerCode(answer), line.id, nonce),
        })),
      );
    }
  }
  rows.push(adminRow(data.adminUrl));
  return rows;
}
