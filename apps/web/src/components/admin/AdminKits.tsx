/**
 * /admin/kits (step 5, docs/kits.md): the list of maintenance kits and the editor of one kit.
 * Plain forms, no client JavaScript: «Проверить» sends the editor's form by GET to its own page
 * (the draft with the live check of every line at the supplier), «Сохранить» posts it; the
 * status of a saved kit changes with its own small forms (publish, unpublish, delete with the
 * «подтверждаю» tick).
 */
import type { KitLineState } from '@detaly/domain';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { CAR_BRANDS } from '@/lib/brands';
import { kitPath } from '@/lib/kit-paths';
import { plural } from '@/lib/plural';
import { CONFIRM_FIELD, CONFIRM_VALUE } from '@/server/admin/destructive';
import {
  KIT_FIELDS,
  KIT_STATUS_LABELS,
  makeName,
  type AdminKitCheck,
  type AdminKitCheckLine,
  type AdminKitRow,
  type KitFieldErrors,
  type KitFormValues,
} from '@/server/admin/kits';
import type { KitRecord } from '@/server/kits/catalog';
import { dateTime } from './format';

const BUTTON =
  'inline-flex min-h-11 items-center rounded-md bg-accent px-4 py-2 font-semibold text-white hover:bg-accent-strong';
const SECONDARY =
  'inline-flex min-h-11 items-center rounded-md border border-line-strong bg-card px-4 py-2 font-semibold hover:border-ink';
const DANGER =
  'inline-flex min-h-11 items-center rounded-md border border-danger bg-card px-4 py-2 font-semibold text-danger hover:bg-danger-soft';
const INPUT = 'w-full min-w-0 rounded-md border border-line-strong bg-card px-3 py-2 min-h-11';
const ACTION = '/api/admin/kits';

const LINES_EXAMPLE = `MANN W914/2 1 — Фильтр масляный
или KNECHT OC90
MANN C26003 1 — Фильтр воздушный
NGK BKR6E 4 — Свечи зажигания`;

function Section({
  title,
  children,
  testId,
}: {
  title: string;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <section className="min-w-0 rounded-card border border-line bg-card p-4" data-testid={testId}>
      <h2 className="mb-3 text-lg font-semibold">{title}</h2>
      {children}
    </section>
  );
}

function Done({ text }: { text: string }) {
  return (
    <p
      className="rounded-card border border-local bg-local-soft px-4 py-2 text-local wrap-anywhere"
      role="status"
      data-testid="admin-done"
    >
      {text}
    </p>
  );
}

function ErrorLine({ text }: { text: string }) {
  return (
    <p
      className="rounded-card border border-danger bg-danger-soft px-4 py-2 text-danger wrap-anywhere"
      role="alert"
      data-testid="admin-kit-error"
    >
      {text}
    </p>
  );
}

function StatusBadge({ status }: { status: keyof typeof KIT_STATUS_LABELS }) {
  return (
    <span
      className={`inline-flex rounded-full px-2.5 py-0.5 text-sm font-semibold ${
        status === 'published' ? 'bg-local-soft text-local' : 'bg-paper-2 text-muted'
      }`}
      data-testid="kit-status"
      data-status={status}
    >
      {KIT_STATUS_LABELS[status]}
    </span>
  );
}

// ---------------------------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------------------------

/** «4 позиции + 2 аналога». */
function lineCount(row: AdminKitRow): string {
  const mains = `${row.mainLines} ${plural(row.mainLines, 'позиция', 'позиции', 'позиций')}`;
  if (row.alternatives === 0) return mains;
  return `${mains} + ${row.alternatives} ${plural(row.alternatives, 'аналог', 'аналога', 'аналогов')}`;
}

export function AdminKitList({ rows, done }: { rows: AdminKitRow[]; done: string | null }) {
  return (
    <div className="flex min-w-0 flex-col gap-4" data-testid="admin-kits">
      {done ? <Done text={done} /> : null}
      <div className="flex flex-wrap items-center gap-3">
        <Link href="/admin/kits/new" className={BUTTON} data-testid="kit-new">
          Новый набор
        </Link>
        <p className="text-sm text-muted">
          Наборы для ТО по моделям: на сайте — только опубликованные, цены живые.
        </p>
      </div>
      <Section title={`Наборы: ${rows.length}`} testId="kits-list">
        {rows.length === 0 ? (
          <p className="text-sm text-muted">Наборов пока нет.</p>
        ) : (
          // A list, not a table: a kit reads in two lines on a phone too.
          <ul className="divide-y divide-line">
            {rows.map((row) => (
              <li
                key={row.id}
                className="flex min-w-0 items-start justify-between gap-3 py-3 first:pt-0 last:pb-0"
                data-testid="kit-row"
                data-status={row.status}
              >
                <div className="min-w-0">
                  <Link
                    href={`/admin/kits/${row.id}`}
                    className="font-semibold text-accent underline"
                    data-testid="kit-row-link"
                  >
                    {row.makeName} {row.model}
                  </Link>
                  <p className="text-sm wrap-anywhere">
                    {row.engine} · {row.years}
                  </p>
                  <p className="text-xs text-muted">
                    <span data-testid="kit-row-lines">{lineCount(row)}</span> · изменён{' '}
                    {dateTime(row.updatedAt)} · {row.updatedBy}
                  </p>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1">
                  <StatusBadge status={row.status} />
                  {row.status === 'published' ? (
                    <a
                      href={kitPath(row)}
                      className="text-xs text-accent underline"
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      на сайте
                    </a>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// The editor
// ---------------------------------------------------------------------------------------------

const STATE_TEXT: Record<KitLineState | 'parse', string> = {
  ok: 'найдено',
  unavailable: 'нет у поставщика',
  excluded: 'маркируемый товар',
  supplier: 'поставщик не ответил',
  invalid: 'ошибка в строке',
  parse: 'ошибка в строке',
};

const STATE_TONE: Record<KitLineState | 'parse', string> = {
  ok: 'text-local',
  unavailable: 'text-warn',
  excluded: 'text-danger',
  supplier: 'text-warn',
  invalid: 'text-danger',
  parse: 'text-danger',
};

function CheckRow({ line }: { line: AdminKitCheckLine }) {
  const role = line.role ?? (line.alternative ? null : line.roleFromOffer);
  const { offer } = line;
  return (
    <li
      className="grid min-w-0 grid-cols-[1.5rem_minmax(0,1fr)_auto] gap-x-3 gap-y-1 border-b border-line py-2.5 text-sm last:border-0"
      data-testid="kit-check-line"
      data-state={line.state}
      data-alternative={line.alternative ? 'yes' : 'no'}
    >
      <span className="text-muted tabular-nums">{line.line}</span>
      <div className="min-w-0 wrap-anywhere">
        {line.alternative ? <span className="text-muted">или </span> : null}
        {role ? (
          <span className="font-semibold">
            {role}
            {line.role === null && !line.alternative ? (
              <span className="ml-1 text-xs font-normal text-muted">(из названия)</span>
            ) : null}
          </span>
        ) : null}
        {offer ? (
          <span className="block">
            {offer.title}
            <span className="block text-xs text-muted">{offer.name}</span>
          </span>
        ) : line.part ? (
          <span className="block">{line.part}</span>
        ) : (
          <span className="block font-mono text-xs">{line.raw}</span>
        )}
      </div>
      <span className={`text-right font-semibold whitespace-nowrap ${STATE_TONE[line.state]}`}>
        {line.state === 'ok' ? '✓' : '✗'} {STATE_TEXT[line.state]}
      </span>
      <div className="col-start-2 col-end-4 min-w-0 text-muted">
        {line.state === 'parse' ? null : <span className="tabular-nums">× {line.qty}</span>}
        {offer ? (
          <>
            {' · '}
            <span className="font-semibold text-ink tabular-nums">{offer.lineTotalText}</span>
            <span className="text-xs tabular-nums">
              {' '}
              ({offer.priceText} / шт., закупка {offer.supplierPriceText})
            </span>
            {' · '}
            <span className="whitespace-nowrap">{offer.promiseText}</span>,{' '}
            {offer.isLocal ? 'в Оренбурге' : 'под заказ'}
          </>
        ) : null}
        {line.message ? (
          <span className={`block text-xs ${STATE_TONE[line.state]}`}>{line.message}</span>
        ) : null}
      </div>
    </li>
  );
}

function KitCheckView({ check, draftMode }: { check: AdminKitCheck; draftMode: boolean }) {
  return (
    <Section
      title={draftMode ? 'Проверка черновика у поставщика' : 'Проверка у поставщика'}
      testId="kit-check"
    >
      {check.lines.length > 0 ? (
        // A list, not a wide table: the verdict of a line stays in view on a phone.
        <ul className="min-w-0">
          {check.lines.map((line) => (
            <CheckRow key={`${line.line}:${line.raw}`} line={line} />
          ))}
        </ul>
      ) : null}
      <p className="mt-3 text-sm">
        Набор целиком (основные позиции):{' '}
        <span className="font-semibold tabular-nums" data-testid="kit-check-total">
          {check.totalText}
        </span>
        {check.promiseText ? <span>, получение {check.promiseText}</span> : null}
        <span className="ml-2 text-xs text-muted">проверено {dateTime(check.checkedAt)}</span>
      </p>
      {check.problems.length > 0 ? (
        <div className="mt-2 text-sm text-danger" data-testid="kit-check-problems">
          <p className="font-semibold">Опубликовать пока нельзя:</p>
          <ul className="list-disc pl-5">
            {check.problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="mt-2 text-sm font-semibold text-local" data-testid="kit-check-ok">
          Все основные позиции есть у поставщика, маркируемых товаров нет — можно публиковать.
        </p>
      )}
    </Section>
  );
}

function FieldError({ text }: { text: string | undefined }) {
  return text ? (
    <span className="text-sm text-danger" data-testid="kit-field-error">
      {text}
    </span>
  ) : null;
}

function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    <label className="flex min-w-0 flex-col gap-1">
      <span className="text-sm font-semibold">{label}</span>
      {children}
      {hint ? <span className="text-xs text-muted">{hint}</span> : null}
      <FieldError text={error} />
    </label>
  );
}

function StatusActions({ kit }: { kit: KitRecord }) {
  const hidden = (
    <>
      <input type="hidden" name="id" value={kit.id} />
      <input type="hidden" name="version" value={kit.version} />
    </>
  );
  return (
    <Section title="На сайте" testId="kit-status-actions">
      <p className="mb-3 flex flex-wrap items-center gap-2 text-sm">
        <StatusBadge status={kit.status} />
        {kit.status === 'published' && kit.publishedAt ? (
          <span className="text-muted">с {dateTime(kit.publishedAt)}</span>
        ) : null}
        {kit.status === 'published' ? (
          <a
            href={kitPath(kit)}
            className="text-accent underline"
            target="_blank"
            rel="noopener noreferrer"
            data-testid="kit-public-link"
          >
            Открыть на сайте
          </a>
        ) : null}
      </p>
      <div className="flex flex-wrap items-start gap-3">
        {kit.status === 'draft' ? (
          <form method="post" action={ACTION}>
            <input type="hidden" name="action" value="publish" />
            {hidden}
            <button type="submit" className={BUTTON} data-testid="kit-publish">
              Опубликовать
            </button>
          </form>
        ) : (
          <form method="post" action={ACTION}>
            <input type="hidden" name="action" value="unpublish" />
            {hidden}
            <button type="submit" className={SECONDARY} data-testid="kit-unpublish">
              Снять с публикации
            </button>
          </form>
        )}
        {kit.status === 'draft' ? (
          <form
            method="post"
            action={ACTION}
            className="flex flex-wrap items-center gap-3"
            data-testid="kit-delete-form"
          >
            <input type="hidden" name="action" value="delete" />
            {hidden}
            <label className="inline-flex min-h-11 items-center gap-2 text-sm">
              <input
                type="checkbox"
                name={CONFIRM_FIELD}
                value={CONFIRM_VALUE}
                required
                className="size-5"
              />
              подтверждаю
            </label>
            <button type="submit" className={DANGER} data-testid="kit-delete">
              Удалить черновик
            </button>
          </form>
        ) : null}
      </div>
    </Section>
  );
}

export interface AdminKitEditorProps {
  /** null: a new kit. */
  kit: KitRecord | null;
  values: KitFormValues;
  fieldErrors: KitFieldErrors;
  check: AdminKitCheck | null;
  /** The values are an unsaved draft (`?check=1`). */
  draftMode: boolean;
  done: string | null;
  error: string | null;
}

export function AdminKitEditor({
  kit,
  values,
  fieldErrors,
  check,
  draftMode,
  done,
  error,
}: AdminKitEditorProps) {
  const editorPath = `/admin/kits/${kit?.id ?? 'new'}`;
  return (
    <div className="flex min-w-0 flex-col gap-4" data-testid="admin-kit-editor">
      <p className="text-sm">
        <Link href="/admin/kits" className="text-accent underline">
          ← Все наборы
        </Link>
      </p>
      {done ? <Done text={done} /> : null}
      {error ? <ErrorLine text={error} /> : null}
      {kit ? (
        <p className="text-sm text-muted" data-testid="kit-meta">
          {makeName(kit.makeSlug)} {kit.model} {kit.engine} · изменён {dateTime(kit.updatedAt)}
        </p>
      ) : null}

      <Section title="Набор" testId="kit-form-section">
        <form method="post" action={ACTION} className="flex min-w-0 flex-col gap-4" id="kit-form">
          {kit ? (
            <>
              <input type="hidden" name="id" value={kit.id} />
              <input type="hidden" name="version" value={kit.version} />
            </>
          ) : null}
          <div className="grid min-w-0 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Марка" error={fieldErrors.make}>
              <select
                name={KIT_FIELDS.make}
                defaultValue={values.make}
                required
                className={INPUT}
                data-testid="kit-make"
              >
                <option value="">— выберите —</option>
                {CAR_BRANDS.map((brand) => (
                  <option key={brand.slug} value={brand.slug}>
                    {brand.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Модель" error={fieldErrors.model}>
              <input
                name={KIT_FIELDS.model}
                defaultValue={values.model}
                required
                maxLength={60}
                autoComplete="off"
                placeholder="Vesta"
                className={INPUT}
                data-testid="kit-model"
              />
            </Field>
            <Field label="Двигатель" error={fieldErrors.engine}>
              <input
                name={KIT_FIELDS.engine}
                defaultValue={values.engine}
                required
                maxLength={80}
                autoComplete="off"
                placeholder="1.6 16V, 106 л.с."
                className={INPUT}
                data-testid="kit-engine"
              />
            </Field>
            <div className="grid min-w-0 grid-cols-2 gap-3">
              <Field label="Год с" error={fieldErrors.yearsFrom}>
                <input
                  name={KIT_FIELDS.yearsFrom}
                  defaultValue={values.yearsFrom}
                  required
                  inputMode="numeric"
                  maxLength={4}
                  placeholder="2015"
                  className={`${INPUT} tabular-nums`}
                  data-testid="kit-years-from"
                />
              </Field>
              <Field label="по" hint="пусто — выпускается" error={fieldErrors.yearsTo}>
                <input
                  name={KIT_FIELDS.yearsTo}
                  defaultValue={values.yearsTo}
                  inputMode="numeric"
                  maxLength={4}
                  className={`${INPUT} tabular-nums`}
                  data-testid="kit-years-to"
                />
              </Field>
            </div>
          </div>
          <Field
            label="Заметка"
            hint="Для сотрудников. На сайт попадёт только время замены, если написать так: «замена ≈ 1 ч» — без цены."
            error={fieldErrors.note}
          >
            <input
              name={KIT_FIELDS.note}
              defaultValue={values.note}
              maxLength={300}
              autoComplete="off"
              placeholder="замена ≈ 1 ч"
              className={INPUT}
              data-testid="kit-note"
            />
          </Field>
          <label className="flex min-w-0 flex-col gap-1" htmlFor="kit-lines">
            <span className="text-sm font-semibold">Позиции</span>
            <span className="text-sm text-muted">
              По строке на позицию: БРЕНД АРТИКУЛ КОЛ-ВО — Название. Аналог — следующей строкой,
              начиная с «или »: клиент сможет выбрать его вместо позиции выше. Без названия возьмём
              его у поставщика. Масло, антифриз, тормозную жидкость и шины не включайте — это
              маркируемые товары.
            </span>
          </label>
          <textarea
            id="kit-lines"
            name={KIT_FIELDS.lines}
            defaultValue={values.lines}
            rows={9}
            required
            maxLength={2000}
            placeholder={LINES_EXAMPLE}
            className={`${INPUT} font-mono text-sm`}
            data-testid="kit-lines"
          />
          <div className="flex flex-wrap gap-3">
            <button
              type="submit"
              formMethod="get"
              formAction={editorPath}
              formNoValidate
              name="check"
              value="1"
              className={SECONDARY}
              data-testid="kit-check-button"
            >
              Проверить
            </button>
            <button
              type="submit"
              name="action"
              value="save"
              className={BUTTON}
              data-testid="kit-save"
            >
              Сохранить
            </button>
          </div>
          {kit?.status === 'published' ? (
            <p className="text-sm text-muted">
              Набор на сайте: сохранится только состав, где все основные позиции есть у поставщика.
            </p>
          ) : null}
        </form>
      </Section>

      {check ? <KitCheckView check={check} draftMode={draftMode} /> : null}

      {kit && !draftMode ? <StatusActions kit={kit} /> : null}
      {kit && draftMode ? (
        <p className="text-sm text-muted" data-testid="kit-draft-note">
          Это проверка несохранённых изменений: чтобы опубликовать, сначала сохраните.{' '}
          <Link href={editorPath} className="text-accent underline">
            Отменить изменения
          </Link>
        </p>
      ) : null}
    </div>
  );
}
