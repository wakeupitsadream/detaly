import { DemoDataBanner } from '@/components/DemoDataBanner';
import { HowItWorks } from '@/components/HowItWorks';
import { SearchBar } from '@/components/SearchBar';
import { TrustBlock } from '@/components/TrustBlock';
import { VinCta } from '@/components/VinCta';
import { getBrand } from '@/server/brand';

export default function HomePage() {
  const brand = getBrand();
  return (
    <div className="space-y-10 md:space-y-14">
      <section className="space-y-5">
        <div className="space-y-3">
          <h1 className="text-3xl leading-tight font-bold md:text-4xl">
            Автозапчасти по артикулу — с ценой и датой получения
          </h1>
          <p className="max-w-2xl text-lg text-muted">
            Со склада в Оренбурге — оплата при получении. Под заказ — предоплата и точная дата,
            когда деталь будет в пункте выдачи.
          </p>
        </div>
        <SearchBar large />
        {brand.demoData ? <DemoDataBanner /> : null}
      </section>
      <VinCta />
      <HowItWorks now={new Date()} />
      <TrustBlock brand={brand} />
    </div>
  );
}
