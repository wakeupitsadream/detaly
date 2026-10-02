import type { Metadata } from 'next';
import { LegalDocumentView } from '@/components/LegalDocumentView';
import { getBrand, telHref } from '@/server/brand';
import { getDb } from '@/server/db';
import { getPublishedDocument, type LegalDocument } from '@/server/documents';
import { serverEnv } from '@/server/env';
import { getLogger } from '@/server/logger';

export const metadata: Metadata = { title: 'Возврат и обмен' };

const RULES = [
  {
    title: '7 дней на возврат исправной детали',
    text: 'Не подошла или передумали — верните в течение 7 дней со дня получения. Нужны товарный вид, упаковка и отсутствие следов установки.',
  },
  {
    title: 'Без удержаний при самовывозе',
    text: 'Деньги возвращаем полностью. До получения от заказа можно отказаться в любой момент.',
  },
  {
    title: 'Деньги — в течение 10 дней',
    text: 'Тем же способом, которым вы платили, с чеком возврата. Наличными возврат не выдаём.',
  },
  {
    title: 'Брак — по гарантии',
    text: 'Замена, уменьшение цены или возврат денег. Сохраните деталь и упаковку, фото дефекта ускорят решение.',
  },
  {
    title: 'Подобрали мы — и не подошло',
    text: 'Если деталь подбирал наш мастер по VIN и она не подошла к автомобилю из заявки, вернём деньги полностью.',
  },
];

async function loadMemo(): Promise<LegalDocument | null> {
  try {
    return await getPublishedDocument('return_memo', { db: getDb(), env: serverEnv() });
  } catch (error) {
    getLogger().error({ err: error }, 'return memo unavailable');
    return null;
  }
}

export default async function ReturnsPage() {
  const brand = getBrand();
  const memo = await loadMemo();
  return (
    <div className="max-w-3xl space-y-8">
      <section className="space-y-3">
        <h1 className="text-2xl font-bold md:text-3xl">Возврат и обмен</h1>
        <p className="text-lg text-muted">Коротко и по-человечески. Полная памятка — ниже.</p>
      </section>
      <ul className="grid min-w-0 grid-cols-1 gap-3 md:grid-cols-2">
        {RULES.map((rule) => (
          <li key={rule.title} className="min-w-0 rounded-card border border-line bg-card p-4">
            <h2 className="font-semibold">{rule.title}</h2>
            <p className="mt-1 text-sm text-muted">{rule.text}</p>
          </li>
        ))}
      </ul>
      <section className="rounded-card border border-line bg-card p-5">
        <h2 className="font-semibold">Как вернуть</h2>
        <p className="mt-1 text-muted">
          Принесите деталь в пункт выдачи{brand.pickup.address ? `: ${brand.pickup.address}` : ''}
          {brand.contactPhone ? (
            <>
              {' '}
              или позвоните{' '}
              <a className="underline" href={telHref(brand.contactPhone)}>
                {brand.contactPhone}
              </a>
            </>
          ) : null}
          .
        </p>
      </section>
      {memo ? (
        <section className="rounded-card border border-line bg-card p-5 md:p-8">
          <LegalDocumentView doc={memo} />
        </section>
      ) : null}
    </div>
  );
}
