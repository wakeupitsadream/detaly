/**
 * «Запись на установку» of /o/<token> (docs/phase-1c-implementation.md section 10.2, decision
 * С6). A plain form without JavaScript: up to six free starts as radio chips, «Записаться» posts
 * `{slotAt, requestKey}` to /api/orders/<token>/install and comes back with a flash message.
 * With a booking: the slot, whether the master confirmed it, and «Отменить запись» until two
 * hours before. No price anywhere: the installation is the partner's service, paid at the
 * service by its own receipt (PLAN risk 11).
 */
import type { ReactNode } from 'react';
import { IconLift } from '@/components/icons';
import { Badge } from '@/components/ui/Badge';
import { buttonClass } from '@/components/ui/Button';
import { chipClass } from '@/components/ui/Chip';
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
}: {
  token: string;
  install: InstallBlockView;
  notice?: ReactNode;
}) {
  const { booking, slots } = install;
  return (
    <Card title="Запись на установку" testId="order-install-booking" id="install">
      {notice}
      {booking ? (
        <div className="space-y-3" data-testid="install-booking" data-status={booking.status}>
          <p className="flex min-w-0 items-start gap-2 text-[1.0625rem]">
            <IconLift size={20} className="mt-0.5 shrink-0" />
            <span className="min-w-0">
              Вы записаны на{' '}
              <time dateTime={booking.slot.startAt} className="font-semibold whitespace-nowrap">
                {booking.slot.dayText} · {booking.slot.timeText}
              </time>
              {' — '}
              {booking.status === 'confirmed'
                ? 'мастер подтвердил запись.'
                : 'ждём подтверждения мастера.'}
            </span>
          </p>
          {install.demo ? (
            <p className="text-sm text-muted">
              Пока мастер не подтвердил время, запись можно отменить здесь же.
            </p>
          ) : booking.canCancel ? (
            <form method="post" action={`/api/orders/${token}/install/cancel`}>
              <input type="hidden" name="bookingId" value={booking.id} />
              <button
                type="submit"
                className={buttonClass({ variant: 'ghost' })}
                data-testid="install-cancel"
              >
                Отменить запись
              </button>
              <p className="mt-1 text-sm text-muted">
                Отменить здесь можно до {booking.cancelUntilText}, позже — по телефону сервиса.
              </p>
            </form>
          ) : (
            <p className="text-sm text-muted">
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
            <legend className="mb-2 text-sm font-medium">Выберите время приезда</legend>
            <div className="flex flex-wrap gap-2">
              {slots.map((slot, index) => (
                <label key={slot.startAt} className="relative cursor-pointer">
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
                      chipClass(false),
                      'h-11 font-mono tabular-nums',
                      'peer-checked:border-ink peer-checked:bg-ink peer-checked:text-paper',
                      'peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-accent',
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
            className={cn(buttonClass({ variant: 'primary' }), 'w-full sm:w-auto')}
            data-testid="install-submit"
          >
            Записаться
          </button>
        </form>
      ) : (
        <p className="text-muted" data-testid="install-empty">
          {EMPTY_TEXT[install.emptyReason ?? 'full'] ?? EMPTY_TEXT.full}
        </p>
      )}
      <p className="mt-4 text-sm text-muted" data-testid="install-partner">
        {installPaymentText(install.partner)} Время подтверждает мастер.
      </p>
      {install.demo ? (
        <Badge tone="demo" className="mt-3">
          демо: загрузка подъёмников условная, запись не сохраняется
        </Badge>
      ) : null}
    </Card>
  );
}
