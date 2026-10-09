import { IconPhone } from '@/components/icons';
import { buttonClass } from '@/components/ui/Button';
import { cn } from '@/components/ui/cn';

/**
 * The fit check while the checkout gate is closed (step 4, as the closed /vin): checks open
 * together with online orders; until then the phone of the point. No form, so no VIN is typed
 * or stored.
 */
export function FitClosed({
  message,
  phone,
}: {
  message: string;
  /** The number as shown and its tel: link (telHref on the server). */
  phone: { text: string; href: string } | null;
}) {
  return (
    <div className="min-w-0 space-y-4" data-testid="fit-closed">
      <p className="text-body">{message}</p>
      {phone ? (
        <a
          href={phone.href}
          className={cn(buttonClass({ variant: 'primary', block: true }), 'sm:w-auto')}
          data-testid="fit-closed-call"
        >
          <IconPhone size={20} />
          Позвонить {phone.text}
        </a>
      ) : null}
    </div>
  );
}
