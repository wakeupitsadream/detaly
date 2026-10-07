'use client';

import { usePathname } from 'next/navigation';
import { DEMO_EXAMPLES } from '@/lib/demo-articles';
import { Container } from './ui/Container';

/** What the strip says on this page, short enough for one line at 375 px. */
function message(pathname: string | null, demoMode: boolean): { short: string; long: string } {
  if (demoMode && pathname === '/o/demo') {
    return {
      short: 'Пример страницы заказа',
      long: 'Пример страницы заказа: ссылку на неё покупатель получает сразу после оформления',
    };
  }
  if (demoMode && pathname === '/checkout') {
    return {
      short: 'Заказ не создаётся',
      long: 'Заказ не создаётся: кнопка оформления откроет пример заказа',
    };
  }
  return demoMode
    ? {
        short: 'Цены условные, заказ не создаётся',
        long: 'Демо-витрина: цены и сроки условные, заказ не создаётся',
      }
    : {
        short: 'Цены условные, заказ не выполняется',
        long: 'Демо-данные: цены и сроки условные, оформленный заказ не будет выполнен',
      };
}

/**
 * One thin `wait-soft` strip above the brand header on every page while the data is synthetic
 * (ROSSKO_MODE=fixtures; DEMO_MODE on Vercel): a «Демо» chip, one line, and on wide screens
 * the articles that answer. Nothing else in the page bodies repeats it.
 */
export function DemoStrip({ demoMode }: { demoMode: boolean }) {
  const pathname = usePathname();
  const text = message(pathname, demoMode);
  return (
    <div className="bg-wait-soft text-ink" role="note" data-testid="demo-strip">
      <Container className="flex h-11 min-w-0 items-center gap-3 text-caption">
        <span className="inline-flex h-6 shrink-0 items-center rounded-full bg-wait px-2.5 font-bold text-on-brand">
          Демо
        </span>
        <span className="min-w-0 truncate sm:hidden">{text.short}</span>
        <span className="hidden min-w-0 truncate sm:inline">{text.long}</span>
        <span className="ml-auto hidden shrink-0 items-center gap-4 lg:flex">
          <span className="text-muted">Попробуйте:</span>
          {DEMO_EXAMPLES.map((example) => (
            <a
              key={example.q}
              href={`/search?q=${example.q}`}
              // The ring goes inside: the strip is the link's height, the window edge and the
              // brand plate would cover a ring drawn outside.
              className="-mx-1.5 inline-flex h-11 items-center rounded-md px-1.5 font-bold tabular-nums underline decoration-1 underline-offset-4 hover:decoration-2 focus-visible:outline-offset-[-3px]"
            >
              {example.article}
            </a>
          ))}
        </span>
      </Container>
    </div>
  );
}
