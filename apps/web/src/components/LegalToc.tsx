'use client';

import { useEffect, useState } from 'react';
import { IconChevronDown } from './icons';
import { cn } from './ui/cn';

export interface TocItem {
  id: string;
  text: string;
}

/** How far below the viewport top a heading counts as «read now»: under the sticky search. */
const READ_LINE_PX = 140;

/**
 * The heading the reader is in: the last one whose top went above the read line. Plain scroll
 * listener (one per page, throttled by rAF): an IntersectionObserver loses the current section
 * while a long one fills the whole screen.
 */
function useCurrentSection(items: readonly TocItem[]): string | null {
  const [current, setCurrent] = useState<string | null>(null);
  useEffect(() => {
    if (items.length === 0) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      let found: string | null = null;
      for (const item of items) {
        const el = document.getElementById(item.id);
        if (el && el.getBoundingClientRect().top <= READ_LINE_PX) found = item.id;
      }
      setCurrent(found);
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    update();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
    };
  }, [items]);
  return current;
}

function TocList({ items, current }: { items: readonly TocItem[]; current: string | null }) {
  return (
    <ol className="grid min-w-0 gap-0.5">
      {items.map((item) => {
        const active = item.id === current;
        return (
          <li key={item.id} className="min-w-0">
            <a
              href={`#${item.id}`}
              aria-current={active ? 'location' : undefined}
              className={cn(
                'flex min-h-11 items-center rounded-control px-2 py-1.5 text-small leading-5 wrap-anywhere',
                'hover:bg-surface-2 hover:text-ink',
                active ? 'font-semibold text-ink' : 'font-medium text-muted',
              )}
            >
              {item.text}
            </a>
          </li>
        );
      })}
    </ol>
  );
}

/**
 * «Содержание» of a legal document (docs/design-v2.md, /docs/*): the h2 sections as anchor
 * links, the one being read in ink 600. `side` is the sticky right column from lg; `folded`
 * is the same list folded in a <details> above the text on phones and tablets.
 */
export function LegalToc({
  items,
  variant,
  className,
}: {
  items: readonly TocItem[];
  variant: 'side' | 'folded';
  className?: string;
}) {
  const current = useCurrentSection(variant === 'side' ? items : []);
  if (items.length === 0) return null;
  if (variant === 'folded') {
    return (
      <details
        className={cn('details-plain group min-w-0 rounded-tile bg-surface', className)}
        data-print-hide=""
        data-testid="legal-toc-folded"
      >
        <summary className="flex min-h-12 cursor-pointer items-center justify-between gap-3 px-4 py-3 text-body font-semibold [&::-webkit-details-marker]:hidden">
          Содержание
          <IconChevronDown
            size={20}
            className="shrink-0 text-muted transition-transform duration-150 group-open:rotate-180"
          />
        </summary>
        <nav aria-label="Содержание документа" className="min-w-0 px-2 pb-3">
          <TocList items={items} current={null} />
        </nav>
      </details>
    );
  }
  return (
    <nav
      aria-labelledby="legal-toc-title"
      className={cn('min-w-0', className)}
      data-print-hide=""
      data-testid="legal-toc"
    >
      <h2 id="legal-toc-title" className="mb-2 px-2 text-h3">
        Содержание
      </h2>
      <TocList items={items} current={current} />
    </nav>
  );
}
