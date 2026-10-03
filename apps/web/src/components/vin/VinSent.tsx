/**
 * After the VIN form (docs/phase-1c-implementation.md section 11 item 1): «Заявка принята», when
 * the master answers, and how the proposal arrives — the Telegram deep link to subscribe (one
 * time link token, 24 hours) or «Пришлём SMS». The subscription is not a login.
 */
import Link from 'next/link';
import { IconCheck, IconClock, IconMessage, IconSearch } from '@/components/icons';
import { Notice } from '@/components/page/Notice';
import { buttonClass } from '@/components/ui/Button';
import { cn } from '@/components/ui/cn';

export type VinSentChannel =
  /** The deep link to the client bot (`https://t.me/<bot>?start=<link token>`). */
  { kind: 'telegram'; deepLink: string } | { kind: 'sms' };

export function VinSent({
  channel,
  hours,
  demo,
}: {
  channel: VinSentChannel;
  hours: string | null;
  demo: boolean;
}) {
  return (
    <div className="mx-auto min-w-0 max-w-2xl space-y-6" data-testid="vin-sent">
      {demo ? (
        <Notice tone="info" title="Это демо" data-testid="vin-sent-demo">
          Заявка не отправлялась: так выглядит ответ сайта после отправки формы.
        </Notice>
      ) : null}
      <section className="corner-marks min-w-0 rounded border border-ink bg-card p-5 md:p-8">
        <div className="flex items-start gap-4">
          <span
            aria-hidden
            className="grid size-11 shrink-0 place-items-center rounded-sm bg-ok-soft text-ok"
          >
            <IconCheck size={24} strokeWidth={2.5} />
          </span>
          <div className="min-w-0">
            <h2 className="text-h2" data-testid="vin-sent-title">
              Заявка принята
            </h2>
            <p className="mt-2 text-muted">
              Мастер подберёт детали по VIN и пришлёт ссылку на подборку с ценами и датами
              получения. Отвечаем в рабочее время, обычно в течение 4 часов.
            </p>
            {hours ? (
              <p className="mt-3 flex items-center gap-2 text-sm text-muted">
                <IconClock size={15} className="shrink-0 text-ink" />
                {hours}
              </p>
            ) : null}
          </div>
        </div>

        <div className="mt-6 border-t border-dashed border-line pt-6">
          {channel.kind === 'telegram' ? (
            <div className="space-y-3" data-testid="vin-sent-telegram">
              <p className="font-semibold">Получить подборку в Telegram</p>
              <p className="text-sm text-muted">
                Нажмите кнопку и запустите бота: он пришлёт ссылку на подборку, когда мастер её
                соберёт. Это подписка на уведомления, а не вход в аккаунт. Кнопка действует 24 часа.
                Если Telegram не подключите — пришлём SMS.
              </p>
              <a
                href={channel.deepLink}
                className={cn(buttonClass({ variant: 'primary', size: 'lg' }), 'w-full sm:w-auto')}
                target="_blank"
                rel="noopener noreferrer"
                data-testid="vin-telegram-link"
              >
                <IconMessage size={18} />
                Подключить Telegram
              </a>
            </div>
          ) : (
            <p className="flex items-start gap-2 text-sm" data-testid="vin-sent-sms">
              <IconMessage size={17} className="mt-0.5 shrink-0" />
              <span>Пришлём SMS со ссылкой на подборку на номер из заявки.</span>
            </p>
          )}
        </div>
      </section>
      <div className="flex flex-wrap gap-3">
        <Link href="/" className={buttonClass({ variant: 'secondary' })}>
          <IconSearch size={18} strokeWidth={2} />
          Искать по артикулу
        </Link>
      </div>
    </div>
  );
}
