import { hasTopHeading, Markdown } from '@/lib/markdown';
import { blankMissingLegalValues, legalBlanksNotice, missingLegalValues } from '@/lib/requisites';
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
 * the title block above says it already, and the seed's «[не задано: …]» markers of a draft
 * become blanks (one notice above explains them). Display only: the stored text and its hash
 * stay.
 */
export function legalBodyForView(doc: Pick<LegalDocument, 'bodyMd' | 'version'>): string {
  return blankMissingLegalValues(
    doc.bodyMd.replace(new RegExp(`^Редакция ${escapeRe(doc.version)}\\.?[ \\t]*\\n?`, 'm'), ''),
  );
}

/**
 * Draft for the reader: not published, or published by env while the text still opens with
 * the lawyer's draft note. Such a page must never call itself «Действующая редакция».
 */
export function legalIsDraft(doc: Pick<LegalDocument, 'bodyMd' | 'isDraft'>): boolean {
  return doc.isDraft || BODY_DRAFT_RE.test(doc.bodyMd);
}

/** Every markdown heading one level down («#» -> «##»): the document inside another page. */
function demoteHeadings(body: string): string {
  return body.replace(/^(#{1,5})(?=[ \t])/gm, '#$1');
}

/**
 * A legal document for reading (docs/design-v2.md, /docs/*): the edition line on top, a draft
 * notice when it is not published, then the text 17/28 in a 68ch column (.legal in globals.css)
 * with headings in the site's h2/h3 sizes. `sheet` frames it as a white card from md (the /docs
 * pages); without it the caller frames it. `embedded` (the memo under a disclosure on /returns)
 * moves every heading one level down, so the page keeps its single h1.
 */
export function LegalDocumentView({
  doc,
  sheet = false,
  embedded = false,
  className,
}: {
  doc: LegalDocument;
  sheet?: boolean;
  embedded?: boolean;
  className?: string;
}) {
  const bodyDraft = BODY_DRAFT_RE.test(doc.bodyMd);
  const draft = legalIsDraft(doc);
  const view = legalBodyForView(doc);
  const body = embedded ? demoteHeadings(view) : view;
  const blanks = legalBlanksNotice(missingLegalValues(`${doc.title}\n${doc.bodyMd}`));
  const Title = embedded ? 'h2' : 'h1';
  return (
    <article
      className={cn(
        'min-w-0',
        sheet &&
          'md:rounded-panel md:border md:border-line md:px-12 md:py-12 print:border-0 print:p-0',
        className,
      )}
      data-testid="legal-document"
    >
      <div className="mb-6 flex max-w-[68ch] min-w-0 flex-wrap items-center justify-between gap-x-6 gap-y-2 border-b border-line pb-4 md:mb-10">
        <span className="inline-flex items-center gap-2 text-small text-muted">
          <IconDocument size={22} className="shrink-0 text-brand" />
          Редакция
          {/* The version as written: no uppercase, «d1» stays «d1». */}
          <span className="font-bold text-ink tabular-nums">{doc.version}</span>
        </span>
        {draft ? (
          <Badge tone="wait" data-testid="legal-draft">
            Черновик
          </Badge>
        ) : (
          <span className="text-small text-muted">
            {/* The demo bundle publishes by env without a date: not a draft, so a current one. */}
            {doc.publishedAt
              ? `Опубликована ${DATE_FORMAT.format(doc.publishedAt)}`
              : 'Действующая редакция'}
          </span>
        )}
        {/* The blanks are told in the edition row, not in a plate of their own: a draft text
            opens with the lawyer's note already, and two plates in a row pushed the title off
            the first screen. */}
        {blanks ? (
          <p className="basis-full text-small text-muted" data-testid="legal-blanks">
            {blanks}
          </p>
        ) : null}
      </div>
      {/* The body opens with its own draft note: one notice is enough. */}
      {doc.isDraft && !bodyDraft ? (
        <Notice tone="wait" role="note" className="mb-6 max-w-[68ch]">
          Черновик документа: действующая редакция ещё не опубликована.
        </Notice>
      ) : null}
      {hasTopHeading(view) ? null : (
        <Title className={cn('mb-6 max-w-[68ch]', embedded ? 'text-h2' : 'text-h1')}>
          {blankMissingLegalValues(doc.title)}
        </Title>
      )}
      <Markdown
        source={body}
        className="legal max-w-[68ch] [&_h2]:text-h2 [&_h3]:text-h3 [&_h4]:text-h3"
      />
    </article>
  );
}
