import { cn } from '@/components/ui/cn';

const STEPS = [
  {
    title: 'Найдите по артикулу',
    text: 'Цена, дата получения и окно установки — без звонков.',
  },
  {
    title: 'Оплатите',
    text: 'Есть в Оренбурге — при получении. Под заказ — предоплата.',
  },
  {
    title: 'Получите сообщение',
    text: 'Напишем в MAX или Telegram, когда деталь приедет.',
  },
  {
    title: 'Заберите и поставьте',
    text: 'Выдача прямо в автосервисе: можно сразу на подъёмник.',
  },
];

/**
 * The order route in one line: 01–04 on a rail with ticks, like a dimension line on a
 * drawing. Vertical on phones.
 */
export function OrderRoute({ className }: { className?: string }) {
  return (
    <ol
      className={cn(
        'relative grid min-w-0 gap-6 md:grid-cols-4 md:gap-0',
        // The rail across the top from md (on phones each step draws its own piece below).
        'md:before:absolute md:before:top-[5px] md:before:right-0 md:before:left-0 md:before:h-px md:before:bg-line-strong',
        className,
      )}
    >
      {STEPS.map((step, index) => (
        <li
          key={step.title}
          className={cn(
            'relative min-w-0 pl-8 md:pt-8 md:pr-6 md:pl-0',
            // Phones: the rail from this marker down to the next one (24px gap + 6px offset).
            index < STEPS.length - 1 &&
              'after:absolute after:top-[17px] after:-bottom-[30px] after:left-[5px] after:w-px after:bg-line-strong md:after:hidden',
          )}
        >
          <span
            aria-hidden
            className={cn(
              'absolute top-1.5 left-0 size-[11px] border-[1.5px] border-ink md:top-0',
              index === STEPS.length - 1 ? 'bg-accent' : 'bg-paper',
            )}
          />
          <p className="font-mono text-xs font-semibold tracking-wider text-muted">
            {String(index + 1).padStart(2, '0')}
          </p>
          <p className="mt-1 text-h3">{step.title}</p>
          <p className="mt-1.5 text-sm text-muted">{step.text}</p>
        </li>
      ))}
    </ol>
  );
}
