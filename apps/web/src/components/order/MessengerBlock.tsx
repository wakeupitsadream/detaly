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
import { IconArrowRight, IconCheck, IconMax, IconMessage, IconTelegram } from '@/components/icons';
import { cn } from '@/components/ui/cn';
import type { MessengerView } from '@/server/orders/order-services';
import { Card } from './OrderSections';
import { TelegramLinkButton } from './TelegramLinkButton';

/** A messenger button: secondary, 52 px, the icon on the left, a tag or an arrow on the right. */
const ROW =
  'flex min-h-13 w-full items-center justify-between gap-3 rounded-control border-[1.5px] border-line-strong bg-bg px-4 py-2 text-left text-[1.0625rem] leading-tight font-semibold text-ink transition-colors duration-150';

function SoonTag({ children }: { children: ReactNode }) {
  return (
    <span className="shrink-0 rounded-full bg-surface px-2.5 py-0.5 text-caption text-muted">
      {children}
    </span>
  );
}

function ChosenNote({ selected }: { selected: boolean }) {
  return selected ? (
    <span className="block text-small font-normal text-muted">вы выбрали</span>
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
  const Icon = channel === 'max' ? IconMax : IconTelegram;
  return (
    <button
      type="button"
      disabled
      aria-disabled="true"
      className={cn(ROW, 'cursor-not-allowed border-line text-muted')}
      data-testid={`messenger-${channel}`}
      data-selected={selected ? 'true' : 'false'}
      data-state="unavailable"
    >
      <span className="flex min-w-0 items-center gap-2.5">
        <Icon size={24} className="shrink-0" />
        <span className="min-w-0">
          {label}
          <ChosenNote selected={selected} />
        </span>
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
      className={cn(ROW, 'hover:border-ink hover:bg-surface disabled:opacity-60')}
      testId="messenger-telegram"
      selected={selected}
      state={state}
    >
      <span className="flex min-w-0 flex-1 items-center gap-2.5">
        <IconTelegram size={24} className="shrink-0 text-brand" />
        <span className="min-w-0">
          {label}
          <ChosenNote selected={selected} />
        </span>
      </span>
      <IconArrowRight size={20} className="shrink-0 text-brand" />
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
    <Card
      title="Статусы заказа"
      icon={<IconMessage size={26} />}
      testId="order-messengers"
      id="notify"
    >
      {notice}
      <div className="grid gap-2 sm:grid-cols-2">
        {messenger.telegram === 'active' ? (
          <p
            className="flex min-h-13 items-center gap-2.5 rounded-control bg-ok-soft px-4 py-2 font-semibold text-ink"
            data-testid="messenger-telegram"
            data-selected={telegramSelected ? 'true' : 'false'}
            data-state="active"
          >
            <IconCheck size={22} className="shrink-0 text-ok" />
            Статусы приходят в Telegram
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
        <StubRow channel="max" label="Статусы в MAX" tag="скоро" selected={preferred === 'max'} />
      </div>
      <div
        className="mt-3 space-y-1 text-small font-normal text-muted"
        data-testid="messenger-help"
      >
        {messenger.telegram === 'active' ? <p>Отключить — команда /stop в боте.</p> : null}
        {messenger.telegram === 'blocked' ? (
          <p data-testid="messenger-blocked">
            Вы отключили уведомления в Telegram. Подключить снова — кнопкой выше.
          </p>
        ) : null}
        {messenger.telegram !== 'active' && messenger.telegramAvailable ? (
          <p>Бот попросит подтвердить номер из заказа. Ссылка действует 24 часа.</p>
        ) : null}
        {!messenger.telegramAvailable && messenger.telegram !== 'active' ? (
          <p>
            {preferred === 'sms'
              ? 'Вы выбрали SMS: важное придёт по SMS, остальное — здесь.'
              : 'Пока следите за заказом на этой странице.'}
          </p>
        ) : null}
        <p>Это подписка на статусы, а не вход в аккаунт.</p>
      </div>
      {preview}
    </Card>
  );
}
