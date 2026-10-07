import { telHref } from '@/server/brand';
import { IconPhone, IconShield } from '../icons';
import { buttonClass } from '../ui/Button';
import { cn } from '../ui/cn';

/**
 * /returns: where to go with a defect or any other claim, also after the 7 days of a refusal.
 * The client opens «Претензия» on the order page, or brings the part to the point and the
 * seller opens the claim on their behalf (claimKindsAvailable: «client (or staff on their
 * behalf)»). The call button only when a phone is set.
 */
export function DefectClaimNote({
  pointName,
  phone,
}: {
  pointName: string | null;
  phone: string | null;
}) {
  return (
    <section
      aria-labelledby="returns-claim"
      className="min-w-0 rounded-tile border border-line bg-bg p-4 md:p-6"
      data-testid="returns-claim"
    >
      <h2 id="returns-claim" className="flex min-w-0 items-center gap-3 text-h3">
        <IconShield size={24} className="shrink-0 text-brand" />
        Брак или претензия
      </h2>
      <p className="mt-2 text-body">
        Брак принимаем и после 7 дней — в пределах гарантии. Откройте заказ по ссылке из сообщения и
        нажмите «Претензия». Или принесите деталь в {pointName ?? 'пункт выдачи'} — оформим на
        месте.
      </p>
      {phone ? (
        <a
          href={telHref(phone)}
          className={cn(
            buttonClass({ variant: 'secondary', size: 'md' }),
            'mt-4 whitespace-nowrap',
          )}
          data-testid="returns-claim-call"
        >
          <IconPhone size={20} />
          Позвонить {phone}
        </a>
      ) : null}
    </section>
  );
}
