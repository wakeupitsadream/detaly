/**
 * «Претензия или возврат» of /o/<token> (docs/phase-1c-implementation.md section 10.3). The
 * claims of this order with their state — accepted and the answer date (+10 days, art. 22
 * ЗоЗПП), the order of actions, «возврат принят мастером», the decision with the master's
 * answer — and the form (ClaimForm) while claimKindsAvailable allows one. The money of a
 * refund decision is the RefundBlock right below this card. After the handover: the link to
 * the printed return memo (a static PDF).
 */
import type { ReactNode } from 'react';
import { IconCheck, IconDocument } from '@/components/icons';
import { Badge, type BadgeTone } from '@/components/ui/Badge';
import type { ClaimCardView, ClaimsBlockView } from '@/server/orders/order-services';
import { ClaimForm } from './ClaimForm';
import { Card, type PickupInfo } from './OrderSections';

function stateBadge(claim: ClaimCardView): { tone: BadgeTone; text: string } {
  if (!claim.open) return { tone: 'neutral', text: 'Закрыта' };
  if (claim.decision !== null) return { tone: 'ok', text: 'Есть решение' };
  return { tone: 'wait', text: 'Принята' };
}

/** What the client does next (a part to bring back, or nothing for a delay). */
function NextSteps({ claim, pickup }: { claim: ClaimCardView; pickup: PickupInfo }) {
  if (claim.kind === 'delay') {
    return (
      <p className="text-sm" data-testid="claim-steps">
        Ничего приносить не нужно. Ответим до {claim.deadlineText}. Если заказ ещё не получен и
        решим вернуть деньги — вернём на ту же карту не позже {claim.deadlineText}. Если заказ уже
        получен — рассчитаем неустойку за просрочку.
      </p>
    );
  }
  const where = [pickup.name, pickup.address].filter(Boolean).join(', ');
  return (
    <ol className="list-decimal space-y-1.5 pl-5 text-sm" data-testid="claim-steps">
      <li>
        Принесите деталь в упаковке в пункт выдачи
        {where ? `: ${where}` : ''}
        {pickup.hours ? ` (${pickup.hours})` : ''}.
      </li>
      <li>Без упаковки тоже примем — решим по состоянию детали.</li>
      <li>Мастер примет деталь и сфотографирует её при вас.</li>
      <li>
        Ответим до {claim.deadlineText}. Если решим вернуть деньги — вернём на ту же карту не позже{' '}
        {claim.deadlineText} (10 дней со дня претензии).
      </li>
    </ol>
  );
}

function ClaimCard({ claim, pickup }: { claim: ClaimCardView; pickup: PickupInfo }) {
  const badge = stateBadge(claim);
  return (
    <article
      className="min-w-0 space-y-3 rounded-sm border border-line-strong bg-paper p-4"
      data-testid="claim-card"
      data-open={claim.open ? 'true' : 'false'}
      data-decision={claim.decision ?? ''}
    >
      <header className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5">
        <Badge tone={badge.tone}>{badge.text}</Badge>
        <p className="min-w-0 font-semibold wrap-anywhere">
          {claim.kindLabel} · <span className="font-normal">{claim.targetLabel}</span>
        </p>
      </header>
      <p className="text-sm text-muted">
        Принята {claim.openedText}.
        {claim.open && claim.decision === null ? (
          <>
            {' '}
            Ответим до <span className="font-semibold text-ink">{claim.deadlineText}</span>.
          </>
        ) : null}
      </p>
      {claim.clientText ? (
        <p className="text-sm wrap-anywhere whitespace-pre-line">
          <span className="text-muted">Ваше описание: </span>
          {claim.clientText}
        </p>
      ) : null}
      {claim.photoCount > 0 ? (
        <p className="text-sm text-muted">Фото к претензии: {claim.photoCount}</p>
      ) : null}
      {claim.returnAcceptedText ? (
        <p className="flex items-start gap-2 text-sm font-medium" data-testid="claim-return">
          <IconCheck size={16} className="mt-0.5 shrink-0 text-ok" />
          Возврат принят мастером {claim.returnAcceptedText}
        </p>
      ) : null}
      {claim.decision !== null ? (
        <div
          className="space-y-1 border-t border-dashed border-line pt-3"
          data-testid="claim-decision"
        >
          <p className="font-semibold">Решение: {claim.decisionLabel}</p>
          {claim.decisionText ? (
            <p className="wrap-anywhere whitespace-pre-line">{claim.decisionText}</p>
          ) : null}
          {claim.refund ? (
            <p className="text-sm text-muted">
              Деньги вернём в течение 10 дней на ту же карту — состояние возврата ниже.
            </p>
          ) : null}
          {claim.decision === 'replace' && claim.open ? (
            <p className="text-sm text-muted">Закажем замену и сообщим, когда её можно забрать.</p>
          ) : null}
        </div>
      ) : null}
      {claim.open && claim.decision === null && claim.returnAcceptedText === null ? (
        <div className="space-y-1.5">
          <p className="text-label text-muted">Что дальше</p>
          <NextSteps claim={claim} pickup={pickup} />
        </div>
      ) : null}
    </article>
  );
}

export function ClaimBlock({
  token,
  block,
  pickup,
  contactPhone,
  notice,
}: {
  token: string;
  block: ClaimsBlockView;
  pickup: PickupInfo;
  contactPhone: string | null;
  notice?: ReactNode;
}) {
  const { form, claims, memoUrl } = block;
  return (
    <Card title="Претензия или возврат" testId="order-claims" id="claim">
      {notice}
      {claims.length > 0 ? (
        <div className="space-y-3">
          {claims.map((claim) => (
            <ClaimCard key={claim.id} claim={claim} pickup={pickup} />
          ))}
        </div>
      ) : null}
      {form ? (
        <div className={claims.length > 0 ? 'mt-5 border-t border-line pt-5' : ''}>
          <p className="mb-4 text-sm text-muted">
            {block.demo
              ? 'Так выглядит форма после получения заказа. В демо она ничего не отправляет.'
              : 'Отказ от исправной детали — 7 дней после получения, брак — в пределах гарантии. Ответим в течение 10 дней.'}
          </p>
          <ClaimForm
            // A fresh key per server render: after a claim the form starts empty again.
            key={form.requestKey}
            action={`/api/orders/${token}/claims`}
            requestKey={form.requestKey}
            kinds={form.kinds}
            targets={form.targets}
            maxPhotos={form.maxPhotos}
            maxFileMb={form.maxFileMb}
            textMax={form.textMax}
            demo={block.demo}
            contactPhone={contactPhone}
          />
        </div>
      ) : claims.length === 0 ? (
        <p className="text-sm text-muted">
          Претензию можно оформить после получения заказа. Вопросы — по телефону пункта выдачи.
        </p>
      ) : null}
      {memoUrl ? (
        <p className="mt-5">
          <a
            href={memoUrl}
            className="inline-flex min-h-11 items-center gap-2 font-medium underline underline-offset-4"
            data-testid="claim-memo"
          >
            <IconDocument size={18} className="shrink-0" />
            Памятка о возврате (PDF)
          </a>
        </p>
      ) : null}
    </Card>
  );
}
