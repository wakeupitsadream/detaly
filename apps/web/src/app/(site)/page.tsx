import { BrandGrid } from '@/components/home/BrandGrid';
import { CategoryGrid } from '@/components/home/CategoryGrid';
import { PickupCard } from '@/components/home/PickupCard';
import { WhyUs } from '@/components/home/WhyUs';
import { IconSts } from '@/components/icons';
import { Container } from '@/components/ui/Container';
import { CtaCard } from '@/components/ui/CtaCard';
import { FullBleed, Section } from '@/components/ui/Section';
import { vinRequestHref } from '@/lib/vin-link';
import { getBrand } from '@/server/brand';

/**
 * Home (docs/design-v2.md, section 4 «Главная»): the search lives in the brand header, then
 * makes, categories, the dark panel of advantages, the pickup point and the VIN prompt.
 * Pictures and short captions instead of paragraphs.
 */
export default function HomePage() {
  const brand = getBrand();
  return (
    <FullBleed>
      {/* The header carries the search; the page title is for screen readers and search engines. */}
      <h1 className="sr-only">{brand.name}: автозапчасти по артикулу и VIN в Оренбурге</h1>
      <Section aria-labelledby="brands-title" className="pt-8! lg:pt-12!">
        <BrandGrid />
      </Section>
      <Section aria-labelledby="categories-title" className="pt-0!">
        <CategoryGrid />
      </Section>
      <Container className="grid gap-12 pb-12 lg:gap-[4.5rem] lg:pb-[4.5rem]">
        <WhyUs
          brandName={brand.name}
          pickupName={brand.pickup.name}
          emblemSrc={brand.pickupLogo?.emblemWhite ?? null}
        />
        <PickupCard brand={brand} />
        <CtaCard
          title="Не знаете артикул?"
          titleId="vin-cta-title"
          text="Мастер подберёт деталь по VIN бесплатно."
          action={{
            href: vinRequestHref(),
            label: 'Подобрать по VIN',
            icon: <IconSts size={22} />,
          }}
          testId="home-vin-cta"
        />
      </Container>
    </FullBleed>
  );
}
