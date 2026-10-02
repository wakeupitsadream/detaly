import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { IconDocument } from '@/components/icons';
import { LegalDocumentView } from '@/components/LegalDocumentView';
import { Notice } from '@/components/page/Notice';
import { Chip, ChipRow } from '@/components/ui/Chip';
import { cn } from '@/components/ui/cn';
import { Eyebrow } from '@/components/ui/Eyebrow';
import { docKindForSlug, loadPublishedDocument } from '@/server/documents';

type Params = Promise<{ slug: string }>;

const TITLES: Record<string, string> = {
  offer: 'Публичная оферта',
  privacy: 'Политика обработки персональных данных',
  consent: 'Согласие на обработку персональных данных',
  'consent-marketing': 'Согласие на получение рекламы',
  'return-memo': 'Памятка о возврате товара',
};

/** Short names for the list of documents beside the sheet. */
const NAV: readonly { slug: string; label: string }[] = [
  { slug: 'offer', label: 'Оферта' },
  { slug: 'privacy', label: 'Политика ПДн' },
  { slug: 'consent', label: 'Согласие на обработку ПДн' },
  { slug: 'consent-marketing', label: 'Согласие на рекламу' },
  { slug: 'return-memo', label: 'Памятка о возврате' },
];

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { slug } = await params;
  return { title: TITLES[slug] ?? 'Документ' };
}

/** All documents: a scrolling chip row on phones, a list with index numbers from lg. */
function DocumentsNav({ current }: { current: string }) {
  return (
    <nav aria-label="Все документы" className="min-w-0" data-print-hide="">
      <ChipRow className="lg:hidden">
        {NAV.map((item) => (
          <Chip key={item.slug} href={`/docs/${item.slug}`} active={item.slug === current}>
            {item.label}
          </Chip>
        ))}
      </ChipRow>
      <div className="hidden lg:block">
        <Eyebrow>Документы</Eyebrow>
        <ol className="mt-4 border-t border-line">
          {NAV.map((item, index) => {
            const active = item.slug === current;
            return (
              <li key={item.slug} className="border-b border-line">
                <Link
                  href={`/docs/${item.slug}`}
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    'flex min-h-11 items-baseline gap-3 py-3 pr-2 text-sm transition-colors',
                    active ? 'font-semibold text-ink' : 'text-muted hover:text-ink',
                  )}
                >
                  <span
                    className={cn('font-mono text-xs', active ? 'text-accent-ink' : 'text-faint')}
                  >
                    {String(index + 1).padStart(2, '0')}
                  </span>
                  {item.label}
                </Link>
              </li>
            );
          })}
        </ol>
        <p className="mt-6 text-sm text-muted">
          Вопросы по документам — по телефону пункта выдачи или в{' '}
          <Link className="underline underline-offset-4 hover:text-ink" href="/about">
            реквизитах продавца
          </Link>
          .
        </p>
      </div>
    </nav>
  );
}

export default async function DocumentPage({ params }: { params: Params }) {
  const { slug } = await params;
  const kind = docKindForSlug(slug);
  if (!kind) notFound();
  const doc = await loadPublishedDocument(kind);
  return (
    <div className="grid min-w-0 gap-6 lg:grid-cols-[15rem_minmax(0,1fr)] lg:gap-12">
      <div className="min-w-0 lg:sticky lg:top-24 lg:self-start">
        <DocumentsNav current={slug} />
      </div>
      {doc ? (
        <LegalDocumentView doc={doc} sheet />
      ) : (
        <div className="min-w-0 rounded border border-line bg-card px-5 py-8 md:px-12 md:py-12">
          <p className="flex items-center gap-2 text-label text-muted">
            <IconDocument size={15} className="text-ink" />
            Документ
          </p>
          <h1 className="mt-4 text-h1">{TITLES[slug]}</h1>
          <Notice tone="info" className="mt-6">
            Документ готовится к публикации.
          </Notice>
        </div>
      )}
    </div>
  );
}
