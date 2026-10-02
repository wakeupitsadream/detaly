import { Sheet } from '@/components/ui/Sheet';
import { cn } from '@/components/ui/cn';

const RULES: readonly { term: string; text: string }[] = [
  {
    term: 'Дата детали',
    text: 'Срок склада поставщика плюс запас на дорогу. Это та же дата, что вы видите в поиске и в заказе.',
  },
  {
    term: 'Когда можно ставить',
    text: 'Поставка приходит в сервис к обеду, поэтому считаем с 12:00 дня получения. Если деталь уже здесь — не раньше чем через час.',
  },
  {
    term: 'Окно на подъёмнике',
    text: 'Ищем ближайшие два часа подряд в рабочее время точки, когда свободен хотя бы один подъёмник. Шаг — час, смотрим на две недели вперёд.',
  },
  {
    term: 'Машина готова',
    text: 'Начало окна плюс два часа — столько занимает типовая замена: фильтры, колодки, свечи. Сложную работу мастер оценит отдельно.',
  },
];

/**
 * "Как мы считаем" in plain words, in a bottom sheet on phones. The numbers are the ones of
 * server/install/config.ts; keep them in sync when the partner's lifts or job time change.
 */
export function InstallFormulaSheet({
  demo,
  triggerClassName,
}: {
  demo: boolean;
  triggerClassName?: string;
}) {
  return (
    <Sheet
      title="Как мы считаем"
      triggerLabel="Как мы считаем"
      triggerClassName={cn('text-sm font-medium', triggerClassName)}
    >
      <dl className="space-y-4">
        {RULES.map((rule, index) => (
          <div key={rule.term} className="grid grid-cols-[2rem_minmax(0,1fr)] gap-x-3">
            <dt className="col-start-2 font-semibold">{rule.term}</dt>
            <span
              aria-hidden
              className="col-start-1 row-span-2 row-start-1 font-mono text-sm font-semibold text-accent-ink"
            >
              {String(index + 1).padStart(2, '0')}
            </span>
            <dd className="col-start-2 mt-0.5 text-[0.9375rem] text-muted">{rule.text}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-6 border-t border-line pt-4 text-sm text-muted">
        Это расчёт, а не запись: время подтверждает мастер. Установка — услуга сервиса, её
        оплачивают там. Если окна нет, напишем «окно подберём при записи».
        {demo
          ? ' Сейчас загрузка подъёмников демонстрационная: реальных записей на сайте нет.'
          : ''}
      </p>
    </Sheet>
  );
}
