'use client';

import { useId, useRef, type ReactNode } from 'react';
import { IconClose } from '@/components/icons';
import { cn } from './cn';

/**
 * A native <dialog>: a bottom sheet on phones (rounded top, a handle), a centred modal from md.
 * Esc (native), the close button and a click on the backdrop close it. The trigger is a button
 * rendered here, so a server component can pass plain content as children.
 */
export function Sheet({
  title,
  triggerLabel,
  triggerClassName,
  children,
}: {
  title: ReactNode;
  triggerLabel: ReactNode;
  triggerClassName?: string;
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
          'inline-flex min-h-11 items-center underline decoration-1 underline-offset-4 hover:decoration-2',
          triggerClassName,
        )}
        onClick={() => ref.current?.showModal()}
      >
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
          <div aria-hidden className="mx-auto mb-4 h-1 w-10 rounded-full bg-line md:hidden" />
          <div className="flex items-start justify-between gap-4">
            <h2 id={titleId} className="min-w-0 text-h2">
              {title}
            </h2>
            <button
              type="button"
              aria-label="Закрыть"
              className="-mt-1 -mr-2 grid size-11 shrink-0 place-items-center rounded text-muted hover:text-ink"
              onClick={() => ref.current?.close()}
            >
              <IconClose size={22} />
            </button>
          </div>
          <div className="mt-4 min-w-0 text-ink">{children}</div>
        </div>
      </dialog>
    </>
  );
}
