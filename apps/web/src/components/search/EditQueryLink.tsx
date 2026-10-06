'use client';

import type { MouseEvent, ReactNode } from 'react';

/** id of the header search input (components/HeaderSearch.tsx). */
const HEADER_INPUT_ID = 'header-q';

/**
 * «Изменить запрос»: puts the caret into the header search with the query selected. Without
 * JavaScript it is a plain link to the field.
 */
export function EditQueryLink({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    const input = document.getElementById(HEADER_INPUT_ID);
    if (!(input instanceof HTMLInputElement)) return;
    event.preventDefault();
    input.scrollIntoView({ block: 'center' });
    input.focus();
    input.select();
  };
  return (
    <a href={`#${HEADER_INPUT_ID}`} className={className} onClick={onClick}>
      {children}
    </a>
  );
}
