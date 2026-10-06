'use client';

import { useId, useRef, type ReactNode } from 'react';
import { IconClose } from '@/components/icons';
import { buttonClass, type ButtonVariant } from './Button';
import { cn } from './cn';

/**
 * A native <dialog>: a bottom sheet on phones (rounded top, a handle), a centred modal from md.
 * Esc (native), the close button and a click on the backdrop close it. The trigger is a button
 * rendered here, so a server component can pass plain content as children. `triggerVariant`
 * draws the trigger as a button; without it the trigger is an underlined text link.
 */
export function Sheet({
  title,
  triggerLabel,
  triggerClassName,
  triggerVariant,
  triggerIcon,
  children,
}: {
  title: ReactNode;
  triggerLabel: ReactNode;
  triggerClassName?: string;
  triggerVariant?: ButtonVariant;
  triggerIcon?: ReactNode;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  return (
    <>
      <button
        type="button"
        aria-haspopup="dialog"
        className={cn(
          triggerVariant
            ? buttonClass({ variant: triggerVariant })
            : 'inline-flex min-h-11 items-center gap-2 font-semibold text-brand underline decoration-1 underline-offset-4 hover:text-brand-hover hover:decoration-2',
          triggerClassName,
        )}
        onClick={() => ref.current?.showModal()}
      >
        {triggerIcon}
        {triggerLabel}
      </button>
      <dialog
        ref={ref}
        className="sheet"
        aria-labelledby={titleId}
        onClick={(event) => {
          // A click on the dialog box itself (not its content) is a click on the backdrop.
          if (event.target === event.currentTarget) event.currentTarget.close();
        }}
      >
        <div className="relative px-5 pt-3 pb-6 md:px-8 md:pt-7 md:pb-8">
          <div aria-hidden className="mx-auto mb-4 h-1.5 w-12 rounded-full bg-line md:hidden" />
          <div className="flex items-start justify-between gap-4">
            <h2 id={titleId} className="min-w-0 text-h3">
              {title}
            </h2>
            <button
              type="button"
              aria-label="Закрыть"
              className="-mt-2 -mr-2 grid size-12 shrink-0 place-items-center rounded-full text-muted hover:bg-surface hover:text-ink"
              onClick={() => ref.current?.close()}
            >
              <IconClose size={24} />
            </button>
          </div>
          <div className="mt-4 min-w-0 text-body text-ink">{children}</div>
        </div>
      </dialog>
    </>
  );
}
