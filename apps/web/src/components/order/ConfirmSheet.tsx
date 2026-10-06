'use client';

import { useEffect, useId, useRef, type ReactNode } from 'react';
import { IconClose } from '@/components/icons';

/**
 * The confirmation step of an order action (docs/design-v2.md, «Заказ»: «подтверждения — в
 * листе»): a native modal <dialog> with the `.sheet` look of components/ui/Sheet — a bottom
 * sheet on phones, a centred modal from md. Unlike that Sheet it has no trigger of its own: the
 * caller mounts it when its button is pressed (so nothing of the form is in the markup before),
 * and it puts the focus on the element marked `data-autofocus` (the digits field, or the final
 * button). Esc, the close button and a click on the backdrop call `onClose`.
 */
export function ConfirmSheet({
  title,
  onClose,
  children,
}: {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (dialog === null) return;
    if (!dialog.open) dialog.showModal();
    dialog.querySelector<HTMLElement>('[data-autofocus]')?.focus();
    return () => {
      if (dialog.open) dialog.close();
    };
  }, []);

  return (
    <dialog
      ref={ref}
      className="sheet"
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        // A click on the dialog box itself (not its content) is a click on the backdrop.
        if (event.target === event.currentTarget) onClose();
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
            onClick={onClose}
          >
            <IconClose size={24} />
          </button>
        </div>
        <div className="mt-4 min-w-0 text-body text-ink">{children}</div>
      </div>
    </dialog>
  );
}
