import type { Metadata } from 'next';
import { InnerPage, PageBand, PageBody } from '@/components/page/PageBand';
import { VinSent } from '@/components/vin/VinSent';
import { getBrand } from '@/server/brand';
import { isDemoMode } from '@/server/mode';

// Reads env (the pickup hours, DEMO_MODE) at request time.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Заявка принята',
  robots: { index: false, follow: false },
};

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/** /vin/sent: the request is in, the proposal comes by SMS (or the demo: `?demo=1`). */
export default async function VinSentPage({ searchParams }: { searchParams: SearchParams }) {
  const demo = isDemoMode() && (await searchParams).demo !== undefined;
  return (
    <InnerPage>
      <PageBand eyebrow="Подбор по VIN" title="Заявка отправлена" />
      <PageBody>
        <VinSent channel={{ kind: 'sms' }} hours={getBrand().pickup.hours} demo={demo} />
      </PageBody>
    </InnerPage>
  );
}
