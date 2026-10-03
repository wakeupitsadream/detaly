// Pure rendering of VIN request cards in the sellers chat (docs/phase-1c-implementation.md
// section 9 item 5, decisions С2, С13): the request as loadVinRequestForStaff gives it without
// `revealPd` — the full VIN (a VIN alone is not PD), the texts with 7+ digit runs masked, the
// phone as •••4567, the NUMBER of photos only (the photos stay in the admin: a registration
// certificate shows the owner's name) — and the preview of the master's answer line by line.
//
// Buttons: «Взять в работу» (vtake), «Ответить строками» (vans), «Отправить клиенту» (vsend, only
// while the saved preview has no errors and was not sent yet), «Исправить» (vfix), «Закрыть
// заявку» (vclose), «Открыть в админке».
import {
  formatPromise,
  formatRub,
  safeMul,
  type EtaSettings,
  type NotificationChannel,
  type VinPreview,
  type VinPreviewLine,
  type VinRequestStatus,
} from '@detaly/domain';
import { buildCallbackData, formatReplyBy, vinRequestNumber } from '@detaly/notify';
import { vinLinePromisedDate, type VinRequestStaffView } from '@detaly/vin';
import { adminRow, type InlineKeyboard } from './card-view';

/** Telegram refuses longer messages (4096); the card stays well below. */
export const VIN_CARD_TEXT_MAX = 3900;

export const VIN_STATUS_LABELS: Record<VinRequestStatus, string> = {
  new: 'новая',
  in_work: 'в работе',
  offered: 'подборка отправлена',
  converted: 'клиент оформил заказ',
  closed: 'закрыта',
};

export const VIN_CHANNEL_LABELS: Record<NotificationChannel, string> = {
  telegram: 'Telegram',
  max: 'MAX',
  sms: 'SMS',
};

export function vinChannelLabel(channel: NotificationChannel | null): string {
  return channel === null ? 'SMS' : VIN_CHANNEL_LABELS[channel];
}

/** The format of the master's answer (decision С13), shown with «Ответить строками». */
export const VIN_ANSWER_FORMAT = [
  'Ответьте на это сообщение строками «БРЕНД АРТИКУЛ [КОЛ-ВО] [# заметка]», по позиции в строке.',
  'Строка с «>» — комментарий клиенту (без телефонов и имён).',
  'Например:',
  'MANN W914/2 1',
  'TRW GDB1330 1 # передние',
  '> Колодки и фильтр под ваш VIN, масло подберём в сервисе',
].join('\n');

export interface VinCardData {
  request: VinRequestStaffView;
  /** First line of a posted card: «Заявка VIN», «Превью ответа» ... */
  headline?: string | null;
  /** Extra line without PD («Без ответа 4 ч»). */
  note?: string | null;
  /** APP_BASE_URL/admin/vin/<id>. */
  adminUrl: string;
  /** Pickup dates of the preview lines (buffer days as on /search). */
  eta: EtaSettings;
}

/** No more actions: an order was placed from the proposal, or the request was closed. */
export function isVinFinished(status: VinRequestStatus): boolean {
  return status === 'converted' || status === 'closed';
}

/**
 * The saved preview was not sent yet: there is one and the request was not offered after it
 * was checked (a preview saved after a send is a new answer).
 */
export function hasUnsentPreview(request: VinRequestStaffView): boolean {
  const preview = request.preview;
  if (preview === null) return false;
  if (request.status !== 'offered' || request.answeredAt === null) return true;
  const checkedAt = new Date(preview.checkedAt).getTime();
  return Number.isFinite(checkedAt) && checkedAt > request.answeredAt.getTime();
}

/** The preview can be sent: lines, no errors, not sent yet, the request still workable. */
export function canSendPreview(request: VinRequestStaffView): boolean {
  const preview = request.preview;
  return (
    !isVinFinished(request.status) &&
    hasUnsentPreview(request) &&
    preview !== null &&
    preview.errorCount === 0 &&
    preview.okCount > 0
  );
}

/**
 * «✓ MANN-FILTER W 914/2 × 1 — 798 ₽, к пн 12 октября, в Оренбурге» /
 * «✗ 2: BOSH OC90 — Бренд BOSH не найден для OC90, есть: Knecht, MAHLE».
 */
export function previewLineText(line: VinPreviewLine, eta: EtaSettings): string {
  if (line.status === 'error') return `✗ ${line.line}: ${line.raw} — ${line.message}`;
  const sum = formatRub(safeMul(line.priceClientKop, line.qty));
  const each = line.qty > 1 ? ` (по ${formatRub(line.priceClientKop)})` : '';
  const parts = [
    `✓ ${line.brand} ${line.article} × ${line.qty} — ${sum}${each}`,
    formatPromise(vinLinePromisedDate(line, eta)),
  ];
  if (line.isLocal) parts.push('в Оренбурге');
  const note = line.note ? ` · ${line.note}` : '';
  return `${parts.join(', ')}${note}`;
}

export function previewBlock(preview: VinPreview, eta: EtaSettings): string[] {
  const checked = formatReplyBy(preview.checkedAt);
  const lines = [`Превью ответа${checked ? ` (проверено ${checked})` : ''}:`];
  for (const line of preview.lines) lines.push(previewLineText(line, eta));
  if (preview.comment) lines.push(`Комментарий клиенту: ${preview.comment}`);
  const summary = `Итого: ${formatRub(preview.totalKop)} · позиций: ${preview.okCount}`;
  if (preview.errorCount > 0) {
    lines.push(
      `${summary}, ошибок: ${preview.errorCount} — «Отправить клиенту» появится, когда ошибок не останется`,
    );
  } else {
    lines.push(summary);
  }
  return lines;
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function renderVinCardText(data: VinCardData): string {
  const { request } = data;
  const lines: string[] = [];
  const number = vinRequestNumber(request.id);
  lines.push(`${data.headline ?? 'Заявка VIN'} № ${number}`);
  if (data.note) lines.push(data.note);
  lines.push(`Статус: ${VIN_STATUS_LABELS[request.status]}`);
  if (request.vin) lines.push(`VIN ${request.vin}`);
  if (request.carText) lines.push(`Авто: ${clip(request.carText, 200)}`);
  lines.push(`Нужно: «${clip(request.needText, 1000)}»`);
  if (request.photosDeleted) lines.push('Фото: удалены по сроку хранения');
  else if (request.photos.length > 0) lines.push(`Фото: ${request.photos.length} (в админке)`);
  else lines.push('Фото: нет');
  lines.push(`Клиент ${request.phone} · ответ: ${vinChannelLabel(request.channel)}`);
  if (request.status === 'offered' && request.proposalCount > 0) {
    const until = formatReplyBy(request.proposalExpiresAt);
    lines.push(
      `Подборка № ${request.proposalCount} отправлена клиенту${until ? `, действует до ${until}` : ''}`,
    );
  }
  if (request.status === 'closed' && request.closeReason) {
    lines.push(`Закрыта: ${clip(request.closeReason, 200)}`);
  }
  if (request.preview !== null && !isVinFinished(request.status)) {
    lines.push('', ...previewBlock(request.preview, data.eta));
  }
  return clip(lines.join('\n'), VIN_CARD_TEXT_MAX);
}

export function vinKeyboard(data: VinCardData, nonce: string): InlineKeyboard {
  const { request } = data;
  const id = request.id;
  const rows: InlineKeyboard = [];
  const button = (code: string, text: string) => [
    { text, callback_data: buildCallbackData(code, id, nonce) },
  ];
  if (!isVinFinished(request.status)) {
    if (request.status === 'new') rows.push(button('vtake', 'Взять в работу'));
    if (hasUnsentPreview(request)) {
      if (canSendPreview(request)) rows.push(button('vsend', 'Отправить клиенту'));
      rows.push(button('vfix', 'Исправить'));
    } else {
      rows.push(
        button(
          'vans',
          request.status === 'offered' ? 'Новая подборка строками' : 'Ответить строками',
        ),
      );
    }
    rows.push(button('vclose', 'Закрыть заявку'));
  }
  rows.push(adminRow(data.adminUrl));
  return rows;
}
