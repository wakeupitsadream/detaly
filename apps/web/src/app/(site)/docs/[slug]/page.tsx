import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { IconDocument, IconPhone } from '@/components/icons';
import { legalBodyForView, LegalDocumentView } from '@/components/LegalDocumentView';
import { LegalToc } from '@/components/LegalToc';
import { Notice } from '@/components/page/Notice';
import { Chip, ChipRow } from '@/components/ui/Chip';
import { headingAnchors } from '@/lib/markdown';
import { getBrand, telHref } from '@/server/brand';
import { docKindForSlug, loadPublishedDocument } from '@/server/documents';

type Params = Promise<{ slug: string }>;

const TITLES: Record<string, string> = {
  offer: 'Публичная оферта',
  privacy: 'Политика обработки персональных данных',
  consent: 'Согласие на обработку персональных данных',
  'consent-marketing': 'Согласие на получение рекламы',
  'return-memo': 'Памятка о возврате товара',
};

/** Short names for the list of documents above the text. */
const NAV: readonly { slug: string; label: string }[] = [
  { slug: 'offer', label: 'Оферта' },
  { slug: 'privacy', label: 'Персональные данные' },
  { slug: 'consent', label: 'Согласие на обработку данных' },
  { slug: 'consent-marketing', label: 'Согласие на рекламу' },
  { slug: 'return-memo', label: 'Памятка о возврате' },
];

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { slug } = await params;
  const title = TITLES[slug];
  return title ? { title, alternates: { canonical: `/docs/${slug}` } } : { title: 'Документ' };
}

/** All documents as round chips on top: a scrolling row on phones, wrapped from md. */
function DocumentsNav({ current }: { current: string }) {
  return (
    <nav aria-label="Все документы" className="min-w-0" data-print-hide="">
      <ChipRow>
        {NAV.map((item) => (
          <Chip
            key={item.slug}
            href={`/docs/${item.slug}`}
            active={item.slug === current}
            aria-current={item.slug === current ? 'page' : undefined}
          >
            {item.label}
          </Chip>
        ))}
      </ChipRow>
    </nav>
  );
}

/** «Вопросы по документам» beside the text from lg: the phone and the requisites link. */
function Questions({ phone }: { phone: string | null }) {
  return (
    <aside
      className="min-w-0 space-y-3 rounded-tile bg-surface p-6"
      aria-labelledby="docs-questions"
      data-print-hide=""
    >
      <h2 id="docs-questions" className="text-h3">
        Вопросы по документам?
      </h2>
      {phone ? (
        <a
          href={telHref(phone)}
          className="inline-flex min-h-11 items-center gap-2 text-[1.25rem] font-extrabold whitespace-nowrap tabular-nums hover:text-brand"
        >
          <IconPhone size={24} className="shrink-0 text-brand" />
          {phone}
        </a>
      ) : null}
      <p className="text-small font-normal text-muted">
        Реквизиты продавца —{' '}
        <Link
          className="font-semibold text-brand underline underline-offset-4 hover:text-brand-hover"
          href="/about"
        >
          на странице «О нас»
        </Link>
        .
      </p>
    </aside>
  );
}

/**
 * /docs/<slug> (docs/design-v2.md, «Инфостраницы»): the list of documents on top, the text
 * 17/28 in a 68ch column. From lg the right column sticks under the search plate with the
 * table of contents (the h2 sections) and a short «Вопросы?» card; below lg the contents fold
 * into a <details> under the title block, so the document's name opens the first screen.
 */
export default async function DocumentPage({ params }: { params: Params }) {
  const { slug } = await params;
  const kind = docKindForSlug(slug);
  if (!kind) notFound();
  const doc = await loadPublishedDocument(kind);
  const brand = getBrand();
  const toc = doc ? headingAnchors(legalBodyForView(doc)) : [];
  return (
    <div className="min-w-0 space-y-6 md:space-y-8">
      <DocumentsNav current={slug} />
      <div className="grid min-w-0 gap-8 lg:grid-cols-[minmax(0,1fr)_18rem] lg:gap-10">
        {doc ? (
          <LegalDocumentView
            doc={doc}
            sheet
            anchors
            toc={<LegalToc items={toc} variant="folded" className="mb-6 max-w-[68ch] lg:hidden" />}
          />
        ) : (
          <div className="min-w-0 md:rounded-panel md:border md:border-line md:px-12 md:py-12">
            <p className="flex items-center gap-2 text-small text-muted">
              <IconDocument size={22} className="text-brand" />
              Документ
            </p>
            <h1 className="mt-4 text-h1">{TITLES[slug]}</h1>
            <Notice tone="info" className="mt-6 max-w-[68ch]">
              Документ готовится к публикации.
            </Notice>
          </div>
        )}
        {/* Sticky under the search plate; a long contents scrolls inside the column so the
            «Вопросы» card is never cut off below the screen (px-1: room for focus rings). */}
        <div className="min-w-0 space-y-6 lg:sticky lg:top-28 lg:-mx-1 lg:max-h-[calc(100dvh-8rem)] lg:self-start lg:overflow-y-auto lg:overscroll-contain lg:px-1 lg:pb-1">
          <LegalToc items={toc} variant="side" className="max-lg:hidden" />
          <Questions phone={brand.contactPhone} />
        </div>
      </div>
    </div>
  );
}
