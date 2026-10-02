import { addDays, formatPromise, localDate } from '@detaly/domain';

/** Example promise dates are computed for "today" in the client time zone. */
export function HowItWorks({ now }: { now: Date }) {
  const today = localDate(now);
  const localExample = formatPromise(addDays(today, 1));
  const orderExample = formatPromise(addDays(today, 4));
  const steps = [
    {
      title: 'Найдите деталь по артикулу',
      text: `Сразу видно цену и дату, когда деталь будет в пункте выдачи: не «3–5 дней», а, например, «${localExample}».`,
    },
    {
      title: 'Оплата — по ситуации',
      text: `Со склада в Оренбурге — оплата при получении. Под заказ — предоплата, получение, например, «${orderExample}».`,
    },
    {
      title: 'Узнайте, что деталь приехала',
      text: 'Пришлём сообщение в MAX или Telegram с кодом выдачи.',
    },
    {
      title: 'Заберите и поставьте',
      text: 'Пункт выдачи — в автосервисе: деталь можно сразу установить, если запишетесь.',
    },
  ];
  return (
    <section aria-labelledby="how-title">
      <h2 id="how-title" className="text-xl font-semibold">
        Как это работает
      </h2>
      <ol className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-4">
        {steps.map((step, index) => (
          <li key={step.title} className="min-w-0 rounded-card border border-line bg-card p-4">
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-accent-soft font-semibold text-accent-strong">
              {index + 1}
            </div>
            <h3 className="mt-3 font-semibold">{step.title}</h3>
            <p className="mt-1 text-sm text-muted">{step.text}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}
