import { hasTopHeading, Markdown } from '@/lib/markdown';
import type { LegalDocument } from '@/server/documents';

const DATE_FORMAT = new Intl.DateTimeFormat('ru-RU', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  timeZone: 'Asia/Yekaterinburg',
});

export function LegalDocumentView({ doc }: { doc: LegalDocument }) {
  return (
    <article className="min-w-0 space-y-4" data-testid="legal-document">
      {doc.isDraft ? (
        <p
          className="rounded-xl border border-warn/30 bg-warn-soft px-4 py-3 text-sm text-warn"
          role="note"
        >
          Черновик документа: действующая редакция ещё не опубликована.
        </p>
      ) : null}
      <p className="text-sm text-muted">
        Редакция {doc.version}
        {doc.publishedAt ? `, опубликована ${DATE_FORMAT.format(doc.publishedAt)}` : ''}
      </p>
      {hasTopHeading(doc.bodyMd) ? null : <h1 className="text-2xl font-bold">{doc.title}</h1>}
      <Markdown source={doc.bodyMd} className="legal" />
    </article>
  );
}
