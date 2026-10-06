/**
 * After the VIN form (docs/phase-1c-implementation.md section 11 item 1; look: docs/design-v2.md,
 * /vin/sent): a 64 px tick, «Заявка принята» as the page title, one line on when the master
 * answers, and how the proposal arrives — the Telegram deep link to subscribe (one time link
 * token, 24 hours) or «Пришлём SMS». The subscription is not a login.
 */
import { IconCheck, IconClock, IconHome, IconMessage, IconTelegram } from '@/components/icons';
import { Notice } from '@/components/page/Notice';
import { ButtonLink, buttonClass } from '@/components/ui/Button';

export type VinSentChannel =
  /** The deep link to the client bot (`https://t.me/<bot>?start=<link token>`). */
  { kind: 'telegram'; deepLink: string } | { kind: 'sms' };

export function VinSent({
  channel,
  hours,
  demo,
  chatUrl = null,
}: {
  channel: VinSentChannel;
  hours: string | null;
  demo: boolean;
  /** The pickup point's own chat (PICKUP_TELEGRAM_URL), for questions while waiting. */
  chatUrl?: string | null;
}) {
  return (
    <div className="mx-auto min-w-0 max-w-2xl space-y-6" data-testid="vin-sent">
      {demo ? (
        <Notice tone="info" title="Это демо" data-testid="vin-sent-demo">
          Заявка не отправлялась — так выглядит ответ сайта.
        </Notice>
      ) : null}
      <section className="min-w-0 rounded-panel bg-surface px-6 py-8 text-center md:px-10 md:py-12">
        <span
          aria-hidden
          className="mx-auto grid size-24 place-items-center rounded-full bg-ok-soft text-ok"
        >
          <IconCheck size={64} strokeWidth={2} />
        </span>
        <h1 className="mt-6 text-h1" data-testid="vin-sent-title">
          Заявка принята
        </h1>
        <p className="mx-auto mt-3 max-w-md text-body text-muted">
          Мастер пришлёт подборку с ценами, обычно за 4 часа.
        </p>
        {hours ? (
          <p className="mt-3 inline-flex items-center gap-2 text-small text-muted">
            <IconClock size={20} className="shrink-0 text-brand" />
            {hours}
          </p>
        ) : null}

        <div className="mx-auto mt-8 max-w-md">
          {channel.kind === 'telegram' ? (
            <div className="space-y-3" data-testid="vin-sent-telegram">
              <a
                href={channel.deepLink}
                className={buttonClass({ variant: 'primary', size: 'lg', block: true })}
                target="_blank"
                rel="noopener noreferrer"
                data-testid="vin-telegram-link"
              >
                <IconTelegram size={22} />
                Подключить Telegram
              </a>
              <p className="text-small font-normal text-muted">
                Бот пришлёт ссылку, когда подборка будет готова. Это не вход в аккаунт. Кнопка
                работает 24 часа, без Telegram пришлём SMS.
              </p>
            </div>
          ) : (
            <p
              className="flex items-center justify-center gap-2 rounded-tile bg-bg px-4 py-3 text-body font-semibold"
              data-testid="vin-sent-sms"
            >
              <IconMessage size={24} className="shrink-0 text-brand" />
              <span>Пришлём SMS со ссылкой</span>
            </p>
          )}
        </div>
      </section>
      <div className="flex flex-col gap-3 sm:flex-row sm:justify-center">
        <ButtonLink href="/" variant="secondary" size="lg" icon={<IconHome size={20} />}>
          На главную
        </ButtonLink>
        {chatUrl ? (
          <a
            href={chatUrl}
            target="_blank"
            rel="noopener noreferrer"
            className={buttonClass({ variant: 'secondary', size: 'lg' })}
          >
            <IconTelegram size={20} className="text-brand" />
            Написать в Telegram
          </a>
        ) : null}
      </div>
    </div>
  );
}
