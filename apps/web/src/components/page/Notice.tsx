import type { HTMLAttributes, ReactNode } from 'react';
import { IconAlert, IconCheck, IconInfo } from '@/components/icons';
import { cn } from '@/components/ui/cn';

export type NoticeTone = 'wait' | 'info' | 'ok' | 'danger' | 'neutral';

const TONE: Record<NoticeTone, { box: string; icon: string; Icon: typeof IconInfo }> = {
  wait: { box: 'bg-wait-soft', icon: 'text-wait', Icon: IconAlert },
  info: { box: 'bg-info-soft', icon: 'text-info', Icon: IconInfo },
  ok: { box: 'bg-ok-soft', icon: 'text-ok', Icon: IconCheck },
  danger: { box: 'bg-danger-soft', icon: 'text-danger', Icon: IconAlert },
  neutral: { box: 'bg-surface', icon: 'text-muted', Icon: IconInfo },
};

/**
 * A note of state: the soft fill of its tone, `rounded-tile`, the tone's icon on the left and
 * ink text (15 px), so the message reads without the colour. `title` is a bold first line;
 * keep the rest to one sentence, details go under a <details>.
 */
export function Notice({
  tone = 'neutral',
  title,
  icon = true,
  className,
  children,
  ...rest
}: {
  tone?: NoticeTone;
  title?: ReactNode;
  icon?: boolean;
  className?: string;
  children?: ReactNode;
} & Omit<HTMLAttributes<HTMLDivElement>, 'title'>) {
  const { box, icon: iconClass, Icon } = TONE[tone];
  return (
    <div
      className={cn(
        'flex min-w-0 items-start gap-3 rounded-tile px-4 py-3 text-small font-normal text-ink',
        box,
        className,
      )}
      {...rest}
    >
      {icon ? <Icon size={22} className={cn('shrink-0', iconClass)} /> : null}
      <div className="min-w-0 flex-1">
        {title ? <p className="font-bold">{title}</p> : null}
        {children}
      </div>
    </div>
  );
}
