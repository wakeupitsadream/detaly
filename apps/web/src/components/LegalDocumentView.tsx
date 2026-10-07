import type { ReactNode } from 'react';
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

/**
 * The head of a body for display: the lawyer's opening note (a «> …» block) and the top «# »
 * title are lifted out, so the sheet puts the title first, the edition under it and the note
 * as a standard Notice; the rest is the text. Display only — the stored text stays as it is.
 */
export function splitLegalHead(body: string): {
  title: string | null;
  note: string | null;
  rest: string;
} {
  const lines = body.split('\n');
  let index = 0;
  const skipBlank = () => {
    while (index < lines.length && (lines[index] ?? '').trim() === '') index += 1;
  };
  skipBlank();
  const noteLines: string[] = [];
  while (index < lines.length && /^>/.test(lines[index] ?? '')) {
    noteLines.push((lines[index] ?? '').replace(/^>\s?/, ''));
    index += 1;
  }
  skipBlank();
  const heading = /^#[ \t]+(.+?)\s*#*\s*$/.exec(lines[index] ?? '');
  if (!heading) return { title: null, note: null, rest: body };
  index += 1;
  return {
    title: heading[1] ?? null,
    note: noteLines.length > 0 ? noteLines.join('\n').trim() : null,
    rest: lines.slice(index).join('\n').replace(/^\s+/, ''),
  };
}

/** Every markdown heading one level down («#» -> «##»): the document inside another page. */
function demoteHeadings(body: string): string {
  return body.replace(/^(#{1,5})(?=[ \t])/gm, '#$1');
}

/**
 * A legal document for reading (docs/design-v2.md, /docs/*): the title first (as on every other
 * page), the edition line with «Черновик» under it, the lawyer's draft note as a standard
 * Notice, then `toc` (the folded contents on phones) and the text 17/28 in a 68ch column
 * (.legal in globals.css) with headings in the site's h2/h3 sizes. `sheet` frames it as a white card from md (the /docs
 * pages); without it the caller frames it. `embedded` (the memo under a disclosure on /returns)
 * moves every heading one level down, so the page keeps its single h1. `anchors` gives the h2
 * sections ids for the table of contents (LegalToc, from headingAnchors(legalBodyForView(doc))).
 */
export function LegalDocumentView({
  doc,
  sheet = false,
  embedded = false,
  anchors = false,
  toc,
  className,
}: {
  doc: LegalDocument;
  sheet?: boolean;
  embedded?: boolean;
  anchors?: boolean;
  /** Shown under the title block, above the text (the folded table of contents, with its own
   * bottom margin). */
  toc?: ReactNode;
  className?: string;
}) {
  const draft = legalIsDraft(doc);
  const head = splitLegalHead(legalBodyForView(doc));
  const body = embedded ? demoteHeadings(head.rest) : head.rest;
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
      {/* A body whose title is not at its top keeps it in the text (one h1). */}
      {head.title !== null || !hasTopHeading(head.rest) ? (
        <Title className={cn('mb-4 max-w-[68ch]', embedded ? 'text-h2' : 'text-h1')}>
          {head.title ?? blankMissingLegalValues(doc.title)}
        </Title>
      ) : null}
      <div className="mb-6 flex max-w-[68ch] min-w-0 flex-wrap items-center justify-between gap-x-6 gap-y-2 border-b border-line pb-4 md:mb-8">
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
      {/* The body's own draft note, else ours for an unpublished text: one notice is enough. */}
      {head.note ? (
        <Notice tone="wait" role="note" className="mb-6 max-w-[68ch]" data-testid="legal-note">
          <Markdown source={head.note} className="[&_p]:m-0" />
        </Notice>
      ) : doc.isDraft ? (
        <Notice tone="wait" role="note" className="mb-6 max-w-[68ch]">
          Черновик документа: действующая редакция ещё не опубликована.
        </Notice>
      ) : null}
      {toc}
      <Markdown
        source={body}
        anchorLevel={anchors && !embedded ? 2 : undefined}
        className="legal max-w-[68ch] [&_h2]:scroll-mt-28 [&_h2]:text-h2 [&_h3]:text-h3 [&_h4]:text-h3"
      />
    </article>
  );
}
