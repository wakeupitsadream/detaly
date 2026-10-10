/**
 * /admin/rossko (step 8, docs/rossko-automation.md): Rossko without the manual cabinet. The
 * GetOrders status map (code → what to do) next to the codes the polling has seen, the polling
 * switch (it works only with ROSSKO_MODE=live: the page says so), the order deadline of «Не
 * заказано у поставщика», the Rossko cutoff times and the shadow auto-order limit. Every form is
 * saved through the audited settings writer with the version it was opened with. Plain forms, no
 * client JavaScript. There is no switch of the real auto-order.
 */
import {
  formatRub,
  ROSSKO_CUTOFF_LEAD_MINUTES,
  ROSSKO_CUTOFF_TIMES_MAX,
  ROSSKO_ORDER_WITHIN_MAX_MINUTES,
  ROSSKO_ORDER_WITHIN_MIN_MINUTES,
  ROSSKO_STATUS_ACTION_LABELS,
  ROSSKO_STATUS_ACTIONS,
  workingTimeText,
} from '@detaly/domain';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { plural } from '@/lib/plural';
import type { AdminRosskoData, AdminSetting, StatusMapRow } from '@/server/admin/rossko';
import { rubInputValue } from '@/server/admin/rossko';
import { dateTime } from './format';

const BUTTON =
  'inline-flex min-h-11 items-center rounded-md bg-accent px-4 py-2 font-semibold text-white hover:bg-accent-strong';
const FIELD =
  'min-w-0 rounded-md border border-line-strong bg-card px-3 py-2 tabular-nums min-h-11';
const INPUT = `w-full ${FIELD}`;

const ACTION = '/api/admin/rossko';

function Section({
  title,
  children,
  testId,
}: {
  title: string;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <section className="min-w-0 rounded-card border border-line bg-card p-4" data-testid={testId}>
      <h2 className="mb-3 text-lg font-semibold">{title}</h2>
      {children}
    </section>
  );
}

/** «Изменено 10.10.2026, 14:05 (admin).» of a stored setting; nothing for a default. */
function Changed({ setting }: { setting: AdminSetting<unknown> }) {
  if (setting.updatedAt === null) return null;
  return (
    <>
      {' '}
      Изменено {dateTime(setting.updatedAt)}
      {setting.updatedBy ? ` (${setting.updatedBy})` : ''}.
    </>
  );
}

function ActionSelect({ row, index }: { row: StatusMapRow | null; index: number }) {
  return (
    <select
      name="act"
      defaultValue={row?.action ?? ''}
      className={`${FIELD} w-full sm:w-auto sm:max-w-full`}
      aria-label={row ? `Что делать при коде ${row.code}` : 'Что делать при новом коде'}
      data-testid={row ? `rossko-act-${row.code}` : `rossko-act-new-${index}`}
    >
      <option value="">Не задано — только сообщение «что это значит?»</option>
      {ROSSKO_STATUS_ACTIONS.map((action) => (
        <option key={action} value={action}>
          {ROSSKO_STATUS_ACTION_LABELS[action]}
        </option>
      ))}
    </select>
  );
}

function StatusMapForm({ data }: { data: AdminRosskoData }) {
  return (
    <form
      method="post"
      action={ACTION}
      className="flex min-w-0 flex-col gap-3"
      data-testid="rossko-map-form"
    >
      <input type="hidden" name="action" value="map" />
      <input type="hidden" name="version" value={data.statusMap.version} />
      {/* One row per code: what Rossko calls it and how often, the action below it on a phone. */}
      <ul className="flex min-w-0 flex-col" data-testid="rossko-map">
        {data.rows.length === 0 ? (
          <li
            className="border-b border-line py-3 text-sm text-muted"
            data-testid="rossko-map-empty"
          >
            Кодов пока нет: опрос ещё ничего не видел. Впишите коды из списка менеджера Rossko.
          </li>
        ) : null}
        {data.rows.map((row) => (
          <li
            key={row.code}
            className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-line py-3"
            data-testid="rossko-map-row"
            data-code={row.code}
          >
            <input type="hidden" name="code" value={row.code} />
            <div className="min-w-0 flex-1 basis-56">
              <p className="wrap-anywhere">
                <span className="font-semibold tabular-nums">Код {row.code}</span>
                {' — '}
                {row.names.length > 0 ? (
                  row.names.join(' / ')
                ) : (
                  <span className="text-muted">название ещё не приходило</span>
                )}
              </p>
              <p className="text-xs text-muted" data-testid={`rossko-seen-${row.code}`}>
                {row.count === 0 ? (
                  'опрос его ещё не видел'
                ) : (
                  <>
                    встречался <span data-testid={`rossko-count-${row.code}`}>{row.count}</span>{' '}
                    {plural(row.count, 'раз', 'раза', 'раз')}
                    {row.lastSeenAt ? `, последний раз ${dateTime(row.lastSeenAt)}` : ''}
                  </>
                )}
              </p>
            </div>
            <ActionSelect row={row} index={0} />
          </li>
        ))}
        <li
          className="flex min-w-0 flex-wrap items-end gap-x-4 gap-y-2 py-3"
          data-testid="rossko-map-new"
        >
          <label className="flex min-w-0 flex-1 basis-56 flex-col gap-1 text-sm">
            Новый код из списка менеджера Rossko
            <input
              name="code"
              inputMode="numeric"
              pattern="[0-9]{1,6}"
              maxLength={6}
              autoComplete="off"
              placeholder="код"
              className={`${FIELD} w-28`}
              data-testid="rossko-new-code"
            />
          </label>
          <ActionSelect row={null} index={0} />
        </li>
      </ul>
      <div>
        <button type="submit" className={BUTTON} data-testid="rossko-map-save">
          Сохранить коды
        </button>
      </div>
      <p className="text-sm text-muted">
        Коды и их смысл даст менеджер Rossko (вопрос R11 в docs/external.md). Пока код не задан,
        система по нему ничего не делает: в чат продавцов приходит одно сообщение «что это значит?»
        на заказ. Действие выполняется один раз при смене кода; «Приехало» и решение по отказу
        остаются за мастером.
        <Changed setting={data.statusMap} />
      </p>
    </form>
  );
}

export function AdminRossko({ data, done }: { data: AdminRosskoData; done: string | null }) {
  const live = data.mode === 'live';
  return (
    <div className="flex min-w-0 flex-col gap-4" data-testid="admin-rossko">
      {done ? (
        <p
          className="rounded-card border border-local bg-local-soft px-4 py-2 text-local"
          role="status"
          data-testid="admin-done"
        >
          {done}
        </p>
      ) : null}

      <Section title="Опрос заказов Rossko (GetOrders)" testId="rossko-poll">
        {!live ? (
          <p
            className="mb-3 rounded-md border border-warn bg-warn-soft px-3 py-2 text-warn"
            role="note"
            data-testid="rossko-mode-warning"
          >
            Сейчас ROSSKO_MODE={data.mode}: ключей Rossko нет, опрос не работает, даже если он
            включён здесь. Он начнёт работать после ключей и ROSSKO_MODE=live.
          </p>
        ) : null}
        <p className="mb-3" data-testid="rossko-poll-state">
          Опрос {data.pollEnabled.value ? 'включён' : 'выключен'}
          {data.pollEnabled.value && live ? ' — заказы проверяются каждые 20 минут' : ''}. Открытых
          заказов у поставщика: {data.polling.open}; последний ответ Rossko:{' '}
          {data.polling.lastCheckedAt ? dateTime(data.polling.lastCheckedAt) : 'ещё не было'}.
        </p>
        <form
          method="post"
          action={ACTION}
          className="flex min-w-0 flex-wrap items-end gap-3"
          data-testid="rossko-poll-form"
        >
          <input type="hidden" name="action" value="poll" />
          <input type="hidden" name="version" value={data.pollEnabled.version} />
          <fieldset className="flex min-w-0 flex-wrap gap-4">
            <legend className="sr-only">Опрос Rossko</legend>
            <label className="inline-flex min-h-11 items-center gap-2">
              <input
                type="radio"
                name="enabled"
                value="on"
                defaultChecked={data.pollEnabled.value}
                data-testid="rossko-poll-on"
              />
              Включён
            </label>
            <label className="inline-flex min-h-11 items-center gap-2">
              <input
                type="radio"
                name="enabled"
                value="off"
                defaultChecked={!data.pollEnabled.value}
                data-testid="rossko-poll-off"
              />
              Выключен
            </label>
          </fieldset>
          <button type="submit" className={BUTTON} data-testid="rossko-poll-save">
            Сохранить
          </button>
        </form>
        <p className="mt-2 text-sm text-muted">
          Порядок после ключей: заполните коды ниже по списку менеджера Rossko и по кодам, которые
          уже видел опрос, затем включите опрос.
          <Changed setting={data.pollEnabled} />
        </p>
      </Section>

      <Section title="Коды статусов Rossko" testId="rossko-codes">
        <StatusMapForm data={data} />
      </Section>

      <Section title="Срок заказа у поставщика" testId="rossko-within">
        <form
          method="post"
          action={ACTION}
          className="flex min-w-0 flex-wrap items-end gap-3"
          data-testid="rossko-within-form"
        >
          <input type="hidden" name="action" value="within" />
          <input type="hidden" name="version" value={data.orderWithinMinutes.version} />
          <label className="flex max-w-56 min-w-0 flex-col gap-1 text-sm">
            Минут рабочего времени
            <input
              name="minutes"
              type="number"
              required
              min={ROSSKO_ORDER_WITHIN_MIN_MINUTES}
              max={ROSSKO_ORDER_WITHIN_MAX_MINUTES}
              step={1}
              defaultValue={data.orderWithinMinutes.value}
              inputMode="numeric"
              className={INPUT}
              data-testid="rossko-within-minutes"
            />
          </label>
          <button type="submit" className={BUTTON} data-testid="rossko-within-save">
            Сохранить
          </button>
        </form>
        <p className="mt-2 text-sm text-muted">
          Подтверждённый заказ без заказа у Rossko дольше{' '}
          {workingTimeText(data.orderWithinMinutes.value)} рабочего времени — одна карточка «Не
          заказано у поставщика» в чат продавцов. Там же, без настроек: «Срок поставщика под
          угрозой» (вечер рабочего дня перед обещанной датой), «Срок сорван» (следующий рабочий
          день) и «Не забирают» (больше 3 рабочих дней в пункте).
          <Changed setting={data.orderWithinMinutes} />
        </p>
      </Section>

      <Section title="Отсечки Rossko" testId="rossko-cutoffs">
        <form
          method="post"
          action={ACTION}
          className="flex min-w-0 flex-wrap items-end gap-3"
          data-testid="rossko-cutoffs-form"
        >
          <input type="hidden" name="action" value="cutoffs" />
          <input type="hidden" name="version" value={data.cutoffTimes.version} />
          <label className="flex max-w-80 min-w-0 flex-col gap-1 text-sm">
            Время, до которого менеджер Rossko принимает заказы
            <input
              name="times"
              defaultValue={data.cutoffTimes.value.join(', ')}
              placeholder="11:00, 16:00"
              autoComplete="off"
              maxLength={200}
              className={INPUT}
              data-testid="rossko-cutoffs-times"
            />
          </label>
          <button type="submit" className={BUTTON} data-testid="rossko-cutoffs-save">
            Сохранить
          </button>
        </form>
        <p className="mt-2 text-sm text-muted">
          {data.cutoffTimes.value.length === 0
            ? 'Отсечки не заданы — напоминаний нет. '
            : `Отсечки: ${data.cutoffTimes.value.join(', ')}. `}
          За {ROSSKO_CUTOFF_LEAD_MINUTES} минут до отсечки в рабочий день, если есть незаказанные
          заказы, в чат продавцов уходит одно сообщение. Не больше {ROSSKO_CUTOFF_TIMES_MAX}{' '}
          отсечек; пустое поле их убирает.
          <Changed setting={data.cutoffTimes} />
        </p>
      </Section>

      <Section title="Порог теневого автозаказа" testId="rossko-max-total">
        <form
          method="post"
          action={ACTION}
          className="flex min-w-0 flex-wrap items-end gap-3"
          data-testid="rossko-max-total-form"
        >
          <input type="hidden" name="action" value="max_total" />
          <input type="hidden" name="version" value={data.autoOrderMaxTotalKop.version} />
          <label className="flex max-w-56 min-w-0 flex-col gap-1 text-sm">
            Сумма заказа, ₽
            <input
              name="rub"
              required
              defaultValue={rubInputValue(data.autoOrderMaxTotalKop.value)}
              inputMode="decimal"
              autoComplete="off"
              maxLength={16}
              className={INPUT}
              data-testid="rossko-max-total-rub"
            />
          </label>
          <button type="submit" className={BUTTON} data-testid="rossko-max-total-save">
            Сохранить
          </button>
        </form>
        <p className="mt-2 text-sm text-muted">
          Заказ дороже {formatRub(data.autoOrderMaxTotalKop.value)} теневой автозаказ не взял бы.
          Это только статистика: заказ у Rossko по-прежнему делает мастер кнопкой «Проверить и
          заказать». Как часто тень совпадает с мастером — на странице{' '}
          <Link href="/admin/auto-order" className="text-accent underline">
            «Автозаказ»
          </Link>
          .
          <Changed setting={data.autoOrderMaxTotalKop} />
        </p>
      </Section>
    </div>
  );
}
