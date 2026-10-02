import type { HTMLAttributes, ReactNode } from 'react';
import { IconAlert, IconCheck, IconInfo } from '@/components/icons';
import { cn } from '@/components/ui/cn';

export type NoticeTone = 'wait' | 'info' | 'ok' | 'danger' | 'neutral';

const TONE: Record<NoticeTone, { box: string; icon: string; Icon: typeof IconInfo }> = {
  wait: { box: 'border-wait/25 border-l-wait bg-wait-soft', icon: 'text-wait', Icon: IconAlert },
  info: { box: 'border-info/20 border-l-info bg-info-soft', icon: 'text-info', Icon: IconInfo },
  ok: { box: 'border-ok/20 border-l-ok bg-ok-soft', icon: 'text-ok', Icon: IconCheck },
  danger: {
    box: 'border-danger/25 border-l-danger bg-danger-soft',
    icon: 'text-danger',
    Icon: IconAlert,
  },
  neutral: { box: 'border-line border-l-ink bg-card', icon: 'text-muted', Icon: IconInfo },
};

/**
 * A plate of state on paper: soft fill of the state colour, a 3px edge on the left and its icon.
 * Text stays ink for reading; the colour says what kind of message it is. `title` is a bold
 * first line.
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
        'flex min-w-0 items-start gap-3 rounded-sm border border-l-[3px] px-4 py-3 text-sm leading-relaxed text-ink',
        box,
        className,
      )}
      {...rest}
    >
      {icon ? <Icon size={18} className={cn('mt-0.5 shrink-0', iconClass)} /> : null}
      <div className="min-w-0 flex-1">
        {title ? <p className="font-semibold">{title}</p> : null}
        {children}
      </div>
    </div>
  );
}
