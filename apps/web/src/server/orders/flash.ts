/**
 * Flash messages of /o/<token> after a plain form post (phase 1C forms without JavaScript:
 * «Статусы в Telegram», «Записаться», «Отменить запись», the claim form). The handler answers
 * 303 to `/o/<token>?flash=<code>#<section>`; only the codes below are read, so the query can
 * never put arbitrary text on the page.
 */

export type FlashTone = 'ok' | 'info' | 'danger';

export interface OrderFlash {
  code: FlashCode;
  tone: FlashTone;
  text: string;
  /** The block the message belongs to (also the URL fragment of the redirect). */
  section: 'notify' | 'install' | 'claim';
}

export const FLASH_MESSAGES = {
  link_unavailable: {
    tone: 'danger',
    section: 'notify',
    text: 'Подключение Telegram пока недоступно. Следите за заказом на этой странице.',
  },
  link_error: {
    tone: 'danger',
    section: 'notify',
    text: 'Не получилось создать ссылку на бота. Попробуйте ещё раз через минуту.',
  },
  install_booked: {
    tone: 'ok',
    section: 'install',
    text: 'Вы записаны. Мастер подтвердит время — пришлём уведомление.',
  },
  install_taken: {
    tone: 'danger',
    section: 'install',
    text: 'Это время только что заняли — выберите другое.',
  },
  install_already: {
    tone: 'info',
    section: 'install',
    text: 'У заказа уже есть запись на установку.',
  },
  install_unavailable: {
    tone: 'danger',
    section: 'install',
    text: 'Запись на установку для этого заказа сейчас недоступна.',
  },
  install_bad_slot: {
    tone: 'danger',
    section: 'install',
    text: 'Выберите время из списка.',
  },
  install_cancelled: {
    tone: 'ok',
    section: 'install',
    text: 'Запись на установку отменена.',
  },
  install_cancel_late: {
    tone: 'danger',
    section: 'install',
    text: 'До установки меньше 2 часов — позвоните в сервис, чтобы отменить запись.',
  },
  install_cancel_error: {
    tone: 'danger',
    section: 'install',
    text: 'Запись уже закрыта или не найдена — обновите страницу.',
  },
  claim_opened: {
    tone: 'ok',
    section: 'claim',
    text: 'Претензия принята. Порядок действий — ниже.',
  },
  claim_wrong_digits: {
    tone: 'danger',
    section: 'claim',
    text: 'Цифры не совпадают с номером телефона из заказа. Заполните форму ещё раз.',
  },
  claim_too_many: {
    tone: 'danger',
    section: 'claim',
    text: 'Слишком много неверных попыток. Попробуйте позже или позвоните нам.',
  },
  claim_photos: {
    tone: 'danger',
    section: 'claim',
    text: 'Фото не приняты: нужны снимки JPEG или PNG, не больше 3 и не слишком большие. Отправьте форму ещё раз.',
  },
  claim_unavailable: {
    tone: 'danger',
    section: 'claim',
    text: 'Такую претензию сейчас оформить нельзя — выберите другой вид или позвоните нам.',
  },
  claim_invalid: {
    tone: 'danger',
    section: 'claim',
    text: 'Проверьте форму: выберите вид претензии и введите последние 4 цифры телефона.',
  },
  claim_error: {
    tone: 'danger',
    section: 'claim',
    text: 'Не получилось отправить претензию. Попробуйте через минуту или позвоните нам.',
  },
  // The sample order (/o/demo?demo=…, decision С21): what the client would see, nothing sent.
  demo_link: {
    tone: 'info',
    section: 'notify',
    text: 'Демо: здесь откроется бот магазина в Telegram и попросит подтвердить номер телефона из заказа. В демо бот не подключается.',
  },
  demo_install: {
    tone: 'info',
    section: 'install',
    text: 'Демо: так выглядит запись на установку. Ничего не сохранено, мастеру ничего не ушло.',
  },
  demo_claim: {
    tone: 'info',
    section: 'claim',
    text: 'Демо: так выглядит принятая претензия. Форма ничего не отправила — ни текста, ни фото.',
  },
} as const satisfies Record<
  string,
  { tone: FlashTone; section: OrderFlash['section']; text: string }
>;

export type FlashCode = keyof typeof FLASH_MESSAGES;

export function isFlashCode(value: unknown): value is FlashCode {
  return typeof value === 'string' && Object.hasOwn(FLASH_MESSAGES, value);
}

/** `?flash=<code>&…` -> the message, or null for anything not in the list. */
export function parseOrderFlash(
  params: Record<string, string | string[] | undefined>,
): OrderFlash | null {
  const raw = Array.isArray(params.flash) ? params.flash[0] : params.flash;
  if (!isFlashCode(raw)) return null;
  const message = FLASH_MESSAGES[raw];
  return { code: raw, tone: message.tone, text: message.text, section: message.section };
}

/** `/o/demo?demo=link|install|claim` (the proxy's demo form redirects) -> its screen. */
export function parseDemoScreen(
  params: Record<string, string | string[] | undefined>,
): 'link' | 'install' | 'claim' | null {
  const raw = Array.isArray(params.demo) ? params.demo[0] : params.demo;
  return raw === 'link' || raw === 'install' || raw === 'claim' ? raw : null;
}

/** Query and fragment of a redirect back to the order page. */
export function flashQuery(code: FlashCode): string {
  return `?flash=${code}#${FLASH_MESSAGES[code].section}`;
}
