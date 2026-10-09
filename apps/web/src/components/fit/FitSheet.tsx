'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { ConfirmSheet } from '@/components/order/ConfirmSheet';
import { buttonClass, type ButtonVariant } from '@/components/ui/Button';
import { cn } from '@/components/ui/cn';

interface SheetState {
  /**
   * Closes the sheet (a no-op for the inline form without JavaScript). The focus goes to the
   * element with `focusId` when given (the line after a send), else back to the trigger.
   */
  close: (focusId?: string) => void;
  /** The page is hydrated: the form may submit by fetch. */
  enhanced: boolean;
}

const SheetContext = createContext<SheetState>({ close: () => {}, enhanced: false });

/** The sheet around a fit check form (FitCheckForm closes it after a send). */
export function useFitSheet(): SheetState {
  return useContext(SheetContext);
}

/**
 * «Проверить под мою машину» (step 4, docs/fit-check.md): a trigger that opens the fit check
 * form. Without JavaScript (and before hydration) it is a <details>: the trigger is its summary
 * and the form opens inline under it, so the plain form post works. With JavaScript the same
 * trigger opens the form in the bottom sheet of the design (ConfirmSheet, a native <dialog>).
 * `openInitially`: the page asked for this form (`/cart?check=<line>`, the search card link, or
 * a form post that came back with an error).
 */
export function FitSheet({
  title,
  triggerLabel,
  triggerIcon,
  triggerVariant = 'secondary',
  triggerClassName,
  openInitially = false,
  testId,
  children,
}: {
  title: ReactNode;
  triggerLabel: ReactNode;
  triggerIcon?: ReactNode;
  triggerVariant?: ButtonVariant;
  triggerClassName?: string;
  openInitially?: boolean;
  /** data-testid of the trigger (`<testId>`) and of the panel (`<testId>-panel`). */
  testId: string;
  children: ReactNode;
}) {
  const [enhanced, setEnhanced] = useState(false);
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    setEnhanced(true);
    if (openInitially) setOpen(true);
    // Once, on hydration: the page's request decides the first state only.
  }, []);

  /** Where the focus goes once the sheet is closed: an element id, the trigger (null), none. */
  const focusAfterClose = useRef<string | null | undefined>(undefined);
  const close = useCallback((focusId?: string) => {
    focusAfterClose.current = focusId ?? null;
    setOpen(false);
  }, []);
  useEffect(() => {
    // After the commit that removed the dialog: its close() has already given the focus back to
    // whatever had it before (nothing, for a sheet the page opened by itself).
    if (open || focusAfterClose.current === undefined) return;
    const id = focusAfterClose.current;
    focusAfterClose.current = undefined;
    const target = id ? document.getElementById(id) : triggerRef.current;
    target?.focus({ preventScroll: true });
  }, [open]);
  const inDialog = useMemo(() => ({ close, enhanced: true }), [close]);

  const trigger = cn(buttonClass({ variant: triggerVariant }), triggerClassName);

  if (!enhanced) {
    return (
      <details
        className="details-plain min-w-0"
        open={openInitially}
        data-testid={`${testId}-details`}
      >
        <summary className={trigger} data-testid={testId}>
          {triggerIcon}
          {triggerLabel}
        </summary>
        <div
          className="mt-3 min-w-0 rounded-tile border border-line bg-surface p-4 md:p-5"
          data-testid={`${testId}-panel`}
        >
          <p className="mb-4 text-h3">{title}</p>
          <SheetContext.Provider value={{ close: () => {}, enhanced: false }}>
            {children}
          </SheetContext.Provider>
        </div>
      </details>
    );
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="dialog"
        className={trigger}
        onClick={() => setOpen(true)}
        data-testid={testId}
        data-enhanced="true"
      >
        {triggerIcon}
        {triggerLabel}
      </button>
      {open ? (
        <ConfirmSheet title={title} onClose={() => close()}>
          <div className="min-w-0" data-testid={`${testId}-panel`}>
            <SheetContext.Provider value={inDialog}>{children}</SheetContext.Provider>
          </div>
        </ConfirmSheet>
      ) : null}
    </>
  );
}
