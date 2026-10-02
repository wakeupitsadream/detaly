import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { LegalDocumentView } from '@/components/LegalDocumentView';
import { getDb } from '@/server/db';
import { docKindForSlug, getPublishedDocument } from '@/server/documents';
import { serverEnv } from '@/server/env';

type Params = Promise<{ slug: string }>;

const TITLES: Record<string, string> = {
  offer: 'Публичная оферта',
  privacy: 'Политика обработки персональных данных',
  consent: 'Согласие на обработку персональных данных',
  'consent-marketing': 'Согласие на получение рекламы',
  'return-memo': 'Памятка о возврате товара',
};

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { slug } = await params;
  return { title: TITLES[slug] ?? 'Документ' };
}

export default async function DocumentPage({ params }: { params: Params }) {
  const { slug } = await params;
  const kind = docKindForSlug(slug);
  if (!kind) notFound();
  const doc = await getPublishedDocument(kind, { db: getDb(), env: serverEnv() });
  if (!doc) {
    return (
      <div className="space-y-3">
        <h1 className="text-2xl font-bold">{TITLES[slug]}</h1>
        <p className="text-muted">Документ готовится к публикации.</p>
      </div>
    );
  }
  return <LegalDocumentView doc={doc} />;
}
