import type { ReactNode } from 'react';
import { cn } from './cn';

/**
 * An advantage as a row (docs/design-v2.md, FeatureRow): a 40 px brand icon on the left, a bold
 * `text-h3` title and one line of muted text on the right. Pass the icon element sized 40.
 */
export function FeatureRow({
  as: Tag = 'div',
  icon,
  title,
  titleAs: Title = 'h3',
  className,
  children,
}: {
  as?: 'div' | 'li';
  icon: ReactNode;
  title: ReactNode;
  titleAs?: 'h2' | 'h3' | 'p';
  className?: string;
  children?: ReactNode;
}) {
  return (
    <Tag className={cn('flex min-w-0 items-start gap-4', className)}>
      <span aria-hidden className="mt-0.5 shrink-0 text-brand">
        {icon}
      </span>
      <div className="min-w-0">
        <Title className="text-h3">{title}</Title>
        {children ? <p className="mt-1 text-body text-muted">{children}</p> : null}
      </div>
    </Tag>
  );
}
