import type { HTMLAttributes } from 'react';
import { cn } from './cn';

type ContainerTag = 'div' | 'section' | 'header' | 'footer' | 'nav';

/** The site column: 72rem, side gutters 16 / 24 / 32 px. */
export function Container({
  as: Tag = 'div',
  className,
  ...rest
}: { as?: ContainerTag } & HTMLAttributes<HTMLElement>) {
  return (
    <Tag
      className={cn('mx-auto w-full max-w-site min-w-0 px-4 md:px-6 lg:px-8', className)}
      {...rest}
    />
  );
}
