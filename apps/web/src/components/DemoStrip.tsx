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
 * One thin strip above the header on every page while the data is synthetic
 * (ROSSKO_MODE=fixtures; DEMO_MODE on Vercel): a «Демо» plate, one line, and on wide screens
 * the articles that answer. Nothing else in the page bodies repeats it.
 */
export function DemoStrip({ demoMode }: { demoMode: boolean }) {
  const pathname = usePathname();
  const text = message(pathname, demoMode);
  return (
    <div
      className="border-b border-graphite-800 bg-graphite-900 text-steel-200"
      role="note"
      data-testid="demo-strip"
    >
      <Container className="flex h-9 min-w-0 items-center gap-3 text-[0.8125rem]">
        <span className="inline-flex h-5 shrink-0 items-center rounded-sm bg-signal px-1.5 font-mono text-[0.6875rem] font-semibold tracking-wider text-ink uppercase">
          Демо
        </span>
        <span className="min-w-0 truncate sm:hidden">{text.short}</span>
        <span className="hidden min-w-0 truncate sm:inline">{text.long}</span>
        <span className="ml-auto hidden shrink-0 items-center gap-3 lg:flex">
          <span className="text-steel-400">Попробуйте:</span>
          {DEMO_EXAMPLES.map((example) => (
            <a
              key={example.q}
              href={`/search?q=${example.q}`}
              className="font-mono font-semibold text-paper underline decoration-graphite-700 underline-offset-4 hover:decoration-accent"
            >
              {example.article}
            </a>
          ))}
        </span>
      </Container>
    </div>
  );
}
