'use client';

/**
 * Up to N photos for a form posted as multipart/form-data («Техкарта», docs/design.md;
 * docs/phase-1c-implementation.md decision С19). It is a real <input type="file" name=…>: without
 * JavaScript the browser sends the originals, and the server (server/uploads.ts) checks and
 * re-encodes them. With JavaScript every chosen photo is downscaled in the browser
 * (lib/downscale.ts), previewed, can be removed, and the input's file list is rebuilt through
 * DataTransfer so the form posts exactly the photos on screen.
 */
import { useEffect, useId, useRef, useState, type ChangeEvent } from 'react';
import { IconAlert, IconClose } from '@/components/icons';
import { cn } from '@/components/ui/cn';
import { fieldDescribedBy } from '@/components/ui/Field';
import { downscaleImage } from '@/lib/downscale';

export interface PhotoInputProps {
  /** Form field name (server/uploads.ts reads `photos` by default). */
  name?: string;
  label?: string;
  hint?: string;
  /** Server-side error to show (e.g. «Фото слишком большие — до 8 МБ каждое»). */
  error?: string | null;
  /** Most photos (3 for VIN requests and claims). */
  max?: number;
  /** One photo limit in MB, for the hint and the browser-side check of what stays too big. */
  maxFileMb?: number;
  disabled?: boolean;
  className?: string;
}

interface Picked {
  key: string;
  file: File;
  url: string;
}

function canRebuildFileList(): boolean {
  try {
    return typeof DataTransfer !== 'undefined' && new DataTransfer().items !== undefined;
  } catch {
    return false;
  }
}

export function PhotoInput({
  name = 'photos',
  label = 'Фото',
  hint,
  error,
  max = 3,
  maxFileMb = 8,
  disabled = false,
  className,
}: PhotoInputProps) {
  const id = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [picked, setPicked] = useState<Picked[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [enhanced, setEnhanced] = useState(false);

  useEffect(() => {
    setEnhanced(canRebuildFileList());
  }, []);

  // The input's file list always mirrors what is on screen.
  useEffect(() => {
    const input = inputRef.current;
    if (!enhanced || input === null) return;
    const transfer = new DataTransfer();
    for (const item of picked) transfer.items.add(item.file);
    input.files = transfer.files;
  }, [picked, enhanced]);

  // Free the preview URLs of removed photos and on unmount.
  const urls = useRef(new Set<string>());
  useEffect(() => {
    const current = new Set(picked.map((item) => item.url));
    for (const url of urls.current) {
      if (!current.has(url)) URL.revokeObjectURL(url);
    }
    urls.current = current;
  }, [picked]);
  useEffect(
    () => () => {
      for (const url of urls.current) URL.revokeObjectURL(url);
    },
    [],
  );

  async function onChange(event: ChangeEvent<HTMLInputElement>) {
    if (!enhanced) return;
    const chosen = Array.from(event.target.files ?? []);
    if (chosen.length === 0) {
      // A cancelled dialog clears the native list: put the shown photos back.
      setPicked((current) => [...current]);
      return;
    }
    setBusy(true);
    setNotice(null);
    const room = Math.max(0, max - picked.length);
    const taken = chosen.slice(0, room);
    const next: Picked[] = [];
    let tooBig = 0;
    for (const original of taken) {
      const file = await downscaleImage(original);
      if (file.size > maxFileMb * 1024 * 1024) {
        tooBig += 1;
        continue;
      }
      next.push({
        key: `${file.name}-${file.size}-${file.lastModified}-${Math.random()}`,
        file,
        url: URL.createObjectURL(file),
      });
    }
    const notices: string[] = [];
    if (chosen.length > room) notices.push(`Можно не больше ${max} фото`);
    if (tooBig > 0) notices.push(`Фото больше ${maxFileMb} МБ не добавлены`);
    setNotice(notices.length > 0 ? notices.join('. ') : null);
    setPicked((current) => [...current, ...next].slice(0, max));
    setBusy(false);
  }

  function remove(key: string) {
    setNotice(null);
    setPicked((current) => current.filter((item) => item.key !== key));
  }

  const full = enhanced && picked.length >= max;
  const hintText =
    hint ?? `До ${max} фото, каждое до ${maxFileMb} МБ. Перед отправкой мы уменьшим снимки.`;
  const describedBy = fieldDescribedBy(id, { hint: hintText, error });

  return (
    <div className={cn('min-w-0', className)}>
      <span id={`${id}-label`} className="mb-1.5 block text-sm font-medium text-ink">
        {label}
      </span>

      {enhanced && picked.length > 0 ? (
        <ul className="mb-3 grid grid-cols-3 gap-2 sm:max-w-md" aria-label="Выбранные фото">
          {picked.map((item, index) => (
            <li
              key={item.key}
              className="relative aspect-square overflow-hidden rounded border-[1.5px] border-line-strong bg-paper-2"
            >
              {/* eslint-disable-next-line @next/next/no-img-element -- a local blob: preview */}
              <img
                src={item.url}
                alt={`Фото ${index + 1}`}
                className="h-full w-full object-cover"
              />
              <button
                type="button"
                onClick={() => remove(item.key)}
                disabled={disabled}
                aria-label={`Удалить фото ${index + 1}`}
                className="absolute top-1 right-1 inline-flex size-8 items-center justify-center rounded bg-ink/80 text-paper hover:bg-ink focus-visible:outline-2 focus-visible:outline-accent"
              >
                <IconClose size={16} />
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <input
          ref={inputRef}
          id={id}
          name={name}
          type="file"
          accept="image/*"
          multiple={max > 1}
          // Never disabled because it is full: a disabled input is left out of the form post.
          disabled={disabled}
          onChange={(event) => void onChange(event)}
          aria-labelledby={`${id}-label`}
          aria-describedby={describedBy}
          aria-invalid={error ? true : undefined}
          className={cn(
            enhanced
              ? 'peer sr-only'
              : 'block w-full text-sm text-ink file:mr-3 file:min-h-11 file:rounded file:border-[1.5px] file:border-ink file:bg-transparent file:px-4 file:font-semibold file:text-ink',
          )}
        />
        {enhanced ? (
          <label
            htmlFor={id}
            className={cn(
              'inline-flex min-h-11 cursor-pointer items-center justify-center gap-2 rounded border-[1.5px] border-ink px-5 text-[0.9375rem] font-semibold text-ink',
              'transition-colors duration-150 hover:bg-ink hover:text-paper',
              'peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-accent',
              (disabled || full) && 'pointer-events-none border-line text-faint',
            )}
          >
            <span aria-hidden="true">+</span>
            {full ? 'Больше нельзя' : picked.length === 0 ? 'Добавить фото' : 'Добавить ещё'}
          </label>
        ) : null}
        {enhanced ? (
          <span className="font-mono text-sm text-muted" aria-live="polite">
            {busy ? 'Уменьшаем…' : `${picked.length} из ${max}`}
          </span>
        ) : null}
      </div>

      <p id={`${id}-hint`} className="mt-1.5 text-sm text-muted">
        {hintText}
      </p>
      {notice ? (
        <p className="mt-1.5 text-sm text-muted" role="status">
          {notice}
        </p>
      ) : null}
      {error ? (
        <p id={`${id}-error`} className="mt-1.5 flex items-start gap-1.5 text-sm text-danger">
          <IconAlert size={16} className="mt-0.5 shrink-0" />
          <span className="min-w-0">{error}</span>
        </p>
      ) : null}
    </div>
  );
}
