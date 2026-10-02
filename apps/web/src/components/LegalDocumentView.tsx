import { hasTopHeading, Markdown } from '@/lib/markdown';
import type { LegalDocument } from '@/server/documents';
import { IconDocument } from './icons';
import { Notice } from './page/Notice';
import { cn } from './ui/cn';

const DATE_FORMAT = new Intl.DateTimeFormat('ru-RU', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  timeZone: 'Asia/Yekaterinburg',
});

/**
 * A legal document as a sheet of paper: the edition line on top like the title block of a
 * drawing, a draft notice when it is not published, then the text (.legal in globals.css).
 * `sheet` frames it as a card (the /docs pages); without it the caller frames it (/returns).
 */
export function LegalDocumentView({
  doc,
  sheet = false,
  className,
}: {
  doc: LegalDocument;
  sheet?: boolean;
  className?: string;
}) {
  return (
    <article
      className={cn(
        'min-w-0',
        sheet &&
          'rounded border border-line bg-card px-5 py-6 sm:px-8 md:px-12 md:py-12 print:border-0 print:p-0',
        className,
      )}
      data-testid="legal-document"
    >
      <div className="mb-7 flex min-w-0 flex-wrap items-center justify-between gap-x-6 gap-y-1 border-b border-ink pb-3 text-label text-muted md:mb-10">
        <span className="inline-flex items-center gap-2">
          <IconDocument size={15} className="shrink-0 text-ink" />
          Редакция {doc.version}
        </span>
        <span>
          {/* The demo bundle publishes by env without a date: not a draft, so not «Не опубликована». */}
          {doc.publishedAt
            ? `Опубликована ${DATE_FORMAT.format(doc.publishedAt)}`
            : doc.isDraft
              ? 'Не опубликована'
              : 'Действующая редакция'}
        </span>
      </div>
      {doc.isDraft ? (
        <Notice tone="wait" role="note" className="mb-6">
          Черновик документа: действующая редакция ещё не опубликована.
        </Notice>
      ) : null}
      {hasTopHeading(doc.bodyMd) ? null : <h1 className="mb-6 text-h1">{doc.title}</h1>}
      <Markdown source={doc.bodyMd} className="legal" />
    </article>
  );
}
