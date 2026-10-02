import { hasTopHeading, Markdown } from '@/lib/markdown';
import type { LegalDocument } from '@/server/documents';
import { IconDocument } from './icons';
import { Notice } from './page/Notice';
import { Badge } from './ui/Badge';
import { cn } from './ui/cn';

const DATE_FORMAT = new Intl.DateTimeFormat('ru-RU', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  timeZone: 'Asia/Yekaterinburg',
});

/** The lawyer's note opening a text that is not final: «> **Черновик, требует вычитки…»». */
const BODY_DRAFT_RE = /^>\s*\*\*Черновик/m;

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * What the sheet shows of the body: the «Редакция 2026-10-d1.» line under the title is dropped,
 * the title block above says it already. Display only: the stored text and its hash stay.
 */
export function legalBodyForView(doc: Pick<LegalDocument, 'bodyMd' | 'version'>): string {
  return doc.bodyMd.replace(
    new RegExp(`^Редакция ${escapeRe(doc.version)}\\.?[ \\t]*\\n?`, 'm'),
    '',
  );
}

/**
 * Draft for the reader: not published, or published by env while the text still opens with
 * the lawyer's draft note. Such a page must never call itself «Действующая редакция».
 */
export function legalIsDraft(doc: Pick<LegalDocument, 'bodyMd' | 'isDraft'>): boolean {
  return doc.isDraft || BODY_DRAFT_RE.test(doc.bodyMd);
}

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
  const bodyDraft = BODY_DRAFT_RE.test(doc.bodyMd);
  const draft = legalIsDraft(doc);
  const body = legalBodyForView(doc);
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
      <div className="mb-7 flex min-w-0 flex-wrap items-center justify-between gap-x-6 gap-y-2 border-b border-ink pb-3 md:mb-10">
        <span className="inline-flex items-center gap-2 text-label text-muted">
          <IconDocument size={15} className="shrink-0 text-ink" />
          Редакция
          {/* The version as written: no uppercase, «d1» stays «d1». */}
          <span className="font-mono text-sm font-semibold tracking-normal text-ink normal-case">
            {doc.version}
          </span>
        </span>
        {draft ? (
          <Badge tone="wait" className="font-semibold" data-testid="legal-draft">
            Черновик
          </Badge>
        ) : (
          <span className="text-label text-muted">
            {/* The demo bundle publishes by env without a date: not a draft, so a current one. */}
            {doc.publishedAt
              ? `Опубликована ${DATE_FORMAT.format(doc.publishedAt)}`
              : 'Действующая редакция'}
          </span>
        )}
      </div>
      {/* The body opens with its own draft note: one notice is enough. */}
      {doc.isDraft && !bodyDraft ? (
        <Notice tone="wait" role="note" className="mb-6">
          Черновик документа: действующая редакция ещё не опубликована.
        </Notice>
      ) : null}
      {hasTopHeading(body) ? null : <h1 className="mb-6 text-h1">{doc.title}</h1>}
      <Markdown source={body} className="legal" />
    </article>
  );
}
