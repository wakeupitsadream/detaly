/**
 * «Уведомления о статусе» of /o/<token> (docs/phase-1c-implementation.md section 10.1).
 * «Статусы в Telegram» posts to /api/orders/<token>/link, which creates a one-time link token
 * and sends the browser to the client bot (`t.me/<bot>?start=<link token>`, never the order
 * token; TelegramLinkButton explains why it navigates by script). Without TG_CLIENT_BOT_USERNAME the button is inactive («скоро»). Connected: a check
 * and how to switch off; switched off by the client: «Подключить снова». «Статусы в MAX» stays
 * an inactive stub until phase 2. It is a subscription to statuses, not a sign-in.
 */
import type { NotificationChannel } from '@detaly/domain';
import type { ReactNode } from 'react';
import { IconCheck, IconMessage } from '@/components/icons';
import { cn } from '@/components/ui/cn';
import type { MessengerView } from '@/server/orders/order-services';
import { Card } from './OrderSections';
import { TelegramLinkButton } from './TelegramLinkButton';

const ROW =
  'flex min-h-12 w-full flex-wrap items-center justify-between gap-2 rounded border px-4 py-2 text-left font-medium';

function SoonTag({ children }: { children: ReactNode }) {
  return (
    <span className="rounded-sm bg-paper-2 px-1.5 py-0.5 font-mono text-[0.6875rem] tracking-wider text-muted uppercase">
      {children}
    </span>
  );
}

function ChosenNote({ selected }: { selected: boolean }) {
  return selected ? (
    <span className="ml-2 text-sm font-normal text-muted">— вы выбрали</span>
  ) : null;
}

/** An inactive row (MAX until phase 2, Telegram without a configured bot). */
function StubRow({
  channel,
  label,
  tag,
  selected,
}: {
  channel: 'max' | 'telegram';
  label: string;
  tag: string;
  selected: boolean;
}) {
  return (
    <button
      type="button"
      disabled
      aria-disabled="true"
      className={cn(
        ROW,
        'cursor-not-allowed border-line bg-paper',
        selected ? 'text-ink' : 'text-muted',
      )}
      data-testid={`messenger-${channel}`}
      data-selected={selected ? 'true' : 'false'}
      data-state="unavailable"
    >
      <span>
        {label}
        <ChosenNote selected={selected} />
      </span>
      <SoonTag>{tag}</SoonTag>
    </button>
  );
}

function TelegramForm({
  token,
  label,
  selected,
  state,
  demo,
}: {
  token: string;
  label: string;
  selected: boolean;
  state: 'none' | 'blocked';
  demo: boolean;
}) {
  return (
    <TelegramLinkButton
      action={`/api/orders/${token}/link`}
      demo={demo}
      className="flex min-h-12 w-full items-center justify-between gap-3 rounded border-[1.5px] border-ink bg-card px-4 py-2 text-left font-medium text-ink transition-colors duration-150 hover:bg-ink hover:text-paper disabled:opacity-60"
      testId="messenger-telegram"
      selected={selected}
      state={state}
    >
      <span className="flex min-w-0 flex-1 items-center gap-2">
        <IconMessage size={18} className="shrink-0" />
        <span className="min-w-0">
          {label}
          <ChosenNote selected={selected} />
        </span>
      </span>
      <span aria-hidden className="shrink-0 font-mono text-sm">
        →
      </span>
    </TelegramLinkButton>
  );
}

export function MessengerBlock({
  token,
  messenger,
  preferred,
  notice,
  preview,
  demo = false,
}: {
  token: string;
  messenger: MessengerView;
  preferred: NotificationChannel | null;
  /** A flash message of the last form post (e.g. the bot is not configured). */
  notice?: ReactNode;
  /** The demo shows a sample status message under the buttons. */
  preview?: ReactNode;
  /** The sample order: the button posts natively to the demo screen. */
  demo?: boolean;
}) {
  const telegramSelected = preferred === 'telegram';
  return (
    <Card title="Уведомления о статусе" testId="order-messengers" id="notify">
      {notice}
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-1">
        {messenger.telegram === 'active' ? (
          <p
            className={cn(ROW, 'border-ok/30 bg-ok-soft text-ink')}
            data-testid="messenger-telegram"
            data-selected={telegramSelected ? 'true' : 'false'}
            data-state="active"
          >
            <span className="inline-flex items-center gap-2">
              <IconCheck size={18} className="shrink-0 text-ok" />
              Статусы приходят в Telegram
            </span>
          </p>
        ) : messenger.telegramAvailable ? (
          <TelegramForm
            token={token}
            label={
              messenger.telegram === 'blocked' ? 'Подключить Telegram снова' : 'Статусы в Telegram'
            }
            selected={telegramSelected}
            state={messenger.telegram}
            demo={demo}
          />
        ) : (
          <StubRow
            channel="telegram"
            label="Статусы в Telegram"
            tag="скоро"
            selected={telegramSelected}
          />
        )}
        <StubRow
          channel="max"
          label="Статусы в MAX"
          tag="после запуска MAX"
          selected={preferred === 'max'}
        />
      </div>
      <div className="mt-3 space-y-1.5 text-sm text-muted" data-testid="messenger-help">
        {messenger.telegram === 'active' ? (
          <p>Отключить уведомления — команда /stop в боте.</p>
        ) : null}
        {messenger.telegram === 'blocked' ? (
          <p data-testid="messenger-blocked">
            Вы отключили уведомления в Telegram. Подключить снова — кнопкой выше.
          </p>
        ) : null}
        {messenger.telegram !== 'active' && messenger.telegramAvailable ? (
          <p>
            Бот попросит подтвердить номер телефона из заказа. Ссылка на бота действует 24 часа.
          </p>
        ) : null}
        {!messenger.telegramAvailable && messenger.telegram !== 'active' ? (
          <p>
            {preferred === 'sms'
              ? 'Вы выбрали SMS. Важные сообщения о заказе придут по SMS, остальное — на этой странице.'
              : 'Уведомления подключаются — пока следите за заказом на этой странице.'}
          </p>
        ) : null}
        <p>
          Это подписка на уведомления о заказе, а не вход в аккаунт. Сохраните ссылку на эту
          страницу: по ней видно статус заказа.
        </p>
      </div>
      {preview}
    </Card>
  );
}
