/**
 * «Запись на установку» of /o/<token> (docs/phase-1c-implementation.md section 10.2, decision
 * С6). A plain form without JavaScript: up to six free starts as round chips, «Записаться» posts
 * `{slotAt, requestKey}` to /api/orders/<token>/install and comes back with a flash message.
 * With a booking: the slot, whether the master confirmed it, and «Отменить запись» until two
 * hours before. No price anywhere: the installation is the partner's service, paid at the
 * service by its own receipt (PLAN risk 11): that sentence is folded under «Как оплатить
 * установку», so the card is the «Машина готова …» line (`lead`), the slots and one button.
 */
import type { ReactNode } from 'react';
import { IconCheck, IconChevronDown, IconClock, IconWrench } from '@/components/icons';
import { Badge } from '@/components/ui/Badge';
import { buttonClass } from '@/components/ui/Button';
import { cn } from '@/components/ui/cn';
import type { InstallBlockView } from '@/server/orders/order-services';
import { Card } from '@/components/order/OrderSections';

const EMPTY_TEXT: Record<string, string> = {
  no_date: 'Свободное время покажем, когда станет известна дата получения детали.',
  no_hours: 'Запишитесь на установку по телефону сервиса.',
  full: 'В ближайшие две недели всё занято — позвоните в сервис, подберём время.',
  status: 'Запись на установку для этого заказа недоступна.',
  booked: 'У заказа уже есть запись на установку.',
};

/** «Установка — услуга <партнёр> (<реквизиты>), оплачивается в сервисе по его чеку». */
export function installPaymentText(partner: InstallBlockView['partner']): string {
  const who = partner.requisites ? `${partner.name} (${partner.requisites})` : partner.name;
  return `Установка — услуга ${who}, оплачивается в сервисе по его чеку.`;
}

export function InstallBookingBlock({
  token,
  install,
  notice,
  lead,
}: {
  token: string;
  install: InstallBlockView;
  notice?: ReactNode;
  /** The «Машина готова …» line (InstallLine) over the slots. */
  lead?: ReactNode;
}) {
  const { booking, slots } = install;
  return (
    <Card
      title="Запись на установку"
      icon={<IconWrench size={24} />}
      testId="order-install-booking"
      id="install"
    >
      {notice}
      {lead ? <div className="mb-4">{lead}</div> : null}
      {booking ? (
        <div className="space-y-3" data-testid="install-booking" data-status={booking.status}>
          <div className="flex min-w-0 items-start gap-3 rounded-tile bg-surface p-4">
            <span
              className={cn(
                'grid size-10 shrink-0 place-items-center rounded-full',
                booking.status === 'confirmed' ? 'bg-ok text-on-brand' : 'bg-wait-soft text-wait',
              )}
            >
              {booking.status === 'confirmed' ? (
                <IconCheck size={22} strokeWidth={2.5} />
              ) : (
                <IconClock size={22} />
              )}
            </span>
            <p className="min-w-0 text-body">
              Вы записаны на{' '}
              <time dateTime={booking.slot.startAt} className="font-bold whitespace-nowrap">
                {booking.slot.dayText} · {booking.slot.timeText}
              </time>
              {' — '}
              {booking.status === 'confirmed'
                ? 'мастер подтвердил запись.'
                : 'ждём подтверждения мастера.'}
            </p>
          </div>
          {install.demo ? (
            <p className="text-small font-normal text-muted">
              Пока мастер не подтвердил время, запись можно отменить здесь же.
            </p>
          ) : booking.canCancel ? (
            <form method="post" action={`/api/orders/${token}/install/cancel`}>
              <input type="hidden" name="bookingId" value={booking.id} />
              <button
                type="submit"
                className={buttonClass({ variant: 'secondary' })}
                data-testid="install-cancel"
              >
                Отменить запись
              </button>
              <p className="mt-2 text-small font-normal text-muted">
                Отменить здесь можно до {booking.cancelUntilText}, позже — по телефону сервиса.
              </p>
            </form>
          ) : (
            <p className="text-small font-normal text-muted">
              До установки меньше 2 часов: отменить запись можно по телефону сервиса.
            </p>
          )}
        </div>
      ) : slots.length > 0 ? (
        <form
          method={install.demo ? 'get' : 'post'}
          action={install.demo ? '/o/demo' : `/api/orders/${token}/install`}
          className="space-y-4"
          data-testid="install-form"
        >
          {install.demo ? (
            <input type="hidden" name="demo" value="install" />
          ) : (
            <input type="hidden" name="requestKey" value={install.requestKey} />
          )}
          <fieldset className="min-w-0">
            <legend className="mb-3 text-[0.9375rem] font-semibold">Когда приедете</legend>
            <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
              {slots.map((slot, index) => (
                <label key={slot.startAt} className="relative min-w-0 cursor-pointer">
                  <input
                    type="radio"
                    name="slotAt"
                    value={slot.startAt}
                    required
                    defaultChecked={index === 0}
                    className="peer sr-only"
                    data-testid="install-slot"
                  />
                  <span
                    className={cn(
                      'flex h-12 w-full items-center justify-center rounded-full bg-surface px-3 text-base font-semibold whitespace-nowrap text-ink tabular-nums transition-colors duration-150 hover:bg-surface-2 sm:px-5',
                      'peer-checked:bg-brand peer-checked:text-on-brand peer-checked:hover:bg-brand-hover',
                      'peer-focus-visible:outline-3 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-brand',
                    )}
                  >
                    {slot.dayText} · {slot.timeText}
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
          <button
            type="submit"
            className={cn(buttonClass({ variant: 'primary', size: 'lg' }), 'w-full sm:w-auto')}
            data-testid="install-submit"
          >
            Записаться
          </button>
        </form>
      ) : (
        <p className="text-body text-muted" data-testid="install-empty">
          {EMPTY_TEXT[install.emptyReason ?? 'full'] ?? EMPTY_TEXT.full}
        </p>
      )}
      <details className="details-plain group mt-4 min-w-0">
        <summary className="inline-flex min-h-11 items-center gap-1 text-small font-semibold text-ink underline decoration-line-strong underline-offset-4 hover:decoration-brand">
          Как оплатить установку
          <IconChevronDown
            size={18}
            className="shrink-0 text-muted transition-transform duration-150 group-open:rotate-180"
          />
        </summary>
        <p className="mt-1 text-small font-normal text-muted" data-testid="install-partner">
          {installPaymentText(install.partner)} Время подтверждает мастер.
        </p>
      </details>
      {install.demo ? (
        <Badge tone="demo" className="mt-3">
          Демо: время условное, запись не сохраняется
        </Badge>
      ) : null}
    </Card>
  );
}
