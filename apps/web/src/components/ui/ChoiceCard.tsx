import { IconCheck, type IconComponent } from '@/components/icons';
import { cn } from './cn';

/**
 * A radio card (the messenger choice of /checkout and /vin): an icon over a short label in a
 * framed card. Unchecked: a `faint` frame and an empty `muted` circle in the corner (both above
 * 3:1, WCAG 1.4.11); checked: a brand frame on `brand-soft` and a white check in a brand circle.
 * `soon`: an inactive card with «скоро» under the label, nothing to tick.
 */
export function ChoiceCard({
  name,
  value,
  label,
  Icon,
  soon = false,
  defaultChecked,
  required,
  describedBy,
}: {
  name: string;
  value: string;
  label: string;
  Icon: IconComponent;
  /** Not available yet: disabled, «скоро». */
  soon?: boolean;
  defaultChecked?: boolean;
  required?: boolean;
  describedBy?: string;
}) {
  return (
    <label
      className={cn(
        'relative flex min-h-24 min-w-0 flex-col items-center justify-center gap-1.5 rounded-control border-[1.5px] px-2 pt-7 pb-3 text-center font-semibold transition-colors',
        soon
          ? 'cursor-not-allowed border-line bg-surface text-muted'
          : 'cursor-pointer border-faint bg-bg text-ink hover:border-muted has-[:checked]:border-brand has-[:checked]:bg-brand-soft',
        'has-[:focus-visible]:outline-3 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-brand',
      )}
    >
      <input
        type="radio"
        name={name}
        value={value}
        disabled={soon}
        required={required}
        defaultChecked={soon ? false : defaultChecked}
        aria-describedby={describedBy}
        className="peer sr-only"
      />
      <Icon size={28} strokeWidth={1.75} className={soon ? 'text-faint' : 'text-brand'} />
      <span className="max-w-full text-base leading-tight wrap-anywhere">{label}</span>
      {soon ? <span className="text-caption font-medium text-muted">скоро</span> : null}
      {soon ? null : (
        <span
          aria-hidden
          className="absolute top-2 right-2 grid size-6 place-items-center rounded-full border-2 border-muted bg-bg text-on-brand peer-checked:border-brand peer-checked:bg-brand [&>svg]:invisible peer-checked:[&>svg]:visible"
        >
          <IconCheck size={16} strokeWidth={2.5} />
        </span>
      )}
    </label>
  );
}
