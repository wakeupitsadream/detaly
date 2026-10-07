'use client';

import { useRef, type Dispatch, type FormEvent, type SetStateAction } from 'react';

/**
 * The browser's own check of `required` / `minLength` before a submit, shown the site's way:
 * the bubble («Please lengthen this text…», in the browser's language, gone in seconds) is
 * suppressed, the server's message for the field goes into the form's `fieldErrors` (shown under
 * the field in `danger` with an icon, like a server error) and the first invalid field gets the
 * focus. The attributes and the server check stay as they are. Wire it as the form's
 * `onInvalidCapture`; `fieldOf` maps an input name to its error field.
 */
export function useInvalidCapture<F extends string>(
  fieldOf: Readonly<Record<string, F>>,
  messages: Readonly<Partial<Record<F, string>>> | undefined,
  setErrors: Dispatch<SetStateAction<Partial<Record<F, string>>>>,
): (event: FormEvent<HTMLFormElement>) => void {
  // One submit fires one `invalid` per bad field in document order: focus only the first.
  const focusing = useRef(false);
  return (event) => {
    const control = event.target as HTMLInputElement;
    const field = fieldOf[control.name];
    const message = field ? messages?.[field] : undefined;
    // An unknown field keeps the browser's bubble: never an error without words.
    if (!field || !message) return;
    event.preventDefault();
    setErrors((prev) => (prev[field] === message ? prev : { ...prev, [field]: message }));
    if (focusing.current) return;
    focusing.current = true;
    control.focus();
    setTimeout(() => {
      focusing.current = false;
    }, 0);
  };
}
