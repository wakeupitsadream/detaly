import type { Metadata } from 'next';
import { BrandGrid } from '@/components/home/BrandGrid';
import { CategoryGrid } from '@/components/home/CategoryGrid';
import { PickupCard } from '@/components/home/PickupCard';
import { WhyUs } from '@/components/home/WhyUs';
import { IconSts } from '@/components/icons';
import { Container } from '@/components/ui/Container';
import { CtaCard } from '@/components/ui/CtaCard';
import { VinCtaArt } from '@/components/vin/VinCtaArt';
import { FullBleed, Section } from '@/components/ui/Section';
import { brandedTitle, PAGE_SEO } from '@/lib/seo';
import { vinRequestHref } from '@/lib/vin-link';
import { getBrand } from '@/server/brand';
import { kitMakeSlugs, publishedKits } from '@/server/kits/catalog';
import { storefrontRating } from '@/server/reviews/rating';

/**
 * «Автозапчасти в Оренбурге по артикулу и VIN — {BRAND_NAME}» (lib/seo.ts). Absolute: the
 * layout's title template does not reach a page of its own segment.
 */
export function generateMetadata(): Metadata {
  return {
    title: { absolute: brandedTitle(PAGE_SEO.home.title, getBrand().name) },
    description: PAGE_SEO.home.description,
    alternates: { canonical: '/' },
  };
}

/**
 * Home (docs/design-v2.md, section 4 «Главная»): the search and the page's h1 («Автозапчасти в
 * Оренбурге — по артикулу и VIN», HomeHeadline) live in the brand header, then makes (those with
 * published maintenance kits lead to /to/<make>, step 5),
 * categories, the dark panel of advantages (with the shop's rating on its map cards when there
 * is one to show, step 3), the pickup point and the VIN prompt. Pictures and short captions
 * instead of paragraphs.
 */
export default async function HomePage() {
  const brand = getBrand();
  const [rating, kits] = await Promise.all([storefrontRating(), publishedKits()]);
  return (
    <FullBleed>
      <Section aria-labelledby="brands-title" className="pt-8! lg:pt-12!">
        {/* Step 5: a make with published kits leads to them (null list: no kits shown). */}
        <BrandGrid kitMakes={kitMakeSlugs(kits)} />
      </Section>
      <Section aria-labelledby="categories-title" className="pt-0!">
        <CategoryGrid />
      </Section>
      <Container className="grid gap-12 pb-12 lg:gap-[4.5rem] lg:pb-[4.5rem]">
        <WhyUs brandName={brand.name} rating={rating} />
        <PickupCard brand={brand} />
        <CtaCard
          title="Не знаете артикул?"
          titleId="vin-cta-title"
          text="Мастер подберёт деталь по VIN бесплатно."
          art={<VinCtaArt />}
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
