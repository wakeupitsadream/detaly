import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { DemoStrip } from '@/components/DemoStrip';
import { Footer } from '@/components/Footer';
import { MobileCartBar } from '@/components/MobileCartBar';
import { SiteHeader } from '@/components/SiteHeader';
import { shareCard, titleTemplate } from '@/lib/seo';
import { getBrand, telHref } from '@/server/brand';
import { requestCartCount } from '@/server/cart/count';
import { kitMakes, publishedKits } from '@/server/kits/catalog';
import { isDemoMode } from '@/server/mode';

// Every page reads env (brand, requisites) and the database at request time, so
// `next build` needs neither.
export const dynamic = 'force-dynamic';

export function generateMetadata(): Metadata {
  const brand = getBrand();
  let metadataBase: URL | undefined;
  try {
    metadataBase = new URL(brand.siteUrl);
  } catch {
    metadataBase = undefined;
  }
  return {
    metadataBase,
    // Every page names itself (lib/seo.ts holds the wording); the brand closes each title.
    title: {
      default: `${brand.name} — автозапчасти по артикулу`,
      template: titleTemplate(brand.name),
    },
    // No description here: one text for every page told search engines nothing (audit perf-5);
    // a page without its own simply has none.
    robots: brand.noindexAll ? { index: false, follow: false } : undefined,
    // The share card of every page (perf-2): og:title and og:description follow the page.
    ...shareCard(brand.name),
  };
}

export default async function SiteLayout({ children }: { children: ReactNode }) {
  const brand = getBrand();
  // One query by the cart cookie; a database failure shows 0 instead of failing the page. The
  // kit list is the process's cached one (step 5): a failure only hides the footer link.
  const [cartCount, kits] = await Promise.all([requestCartCount(), publishedKits()]);
  return (
    <div className="flex min-h-screen min-w-0 flex-col">
      <a
        href="#main"
        // Off screen until focused, then a full 48 px button (focus:not-sr-only zeroed the
        // padding). No slide: reduced motion or not, it just appears.
        className="fixed top-2 left-2 z-50 inline-flex min-h-12 -translate-y-[200%] items-center rounded-control bg-bg px-4 py-3 font-semibold text-ink shadow-float focus:translate-y-0"
      >
        К содержимому
      </a>
      {brand.demoData ? <DemoStrip demoMode={isDemoMode()} /> : null}
      <SiteHeader
        brandName={brand.name}
        cartCount={cartCount}
        phone={brand.contactPhone}
        phoneHref={brand.contactPhone ? telHref(brand.contactPhone) : null}
        hours={brand.pickup.hours}
        pickupName={brand.pickup.name}
        pickupAddress={brand.pickup.address}
        emblemSrc={brand.pickupLogo?.emblemWhite ?? null}
      />
      {/* A centred column by default; a page rooted in <FullBleed> lays out full-width
          Sections itself (.site-main in globals.css). */}
      <main id="main" className="site-main flex-1">
        {children}
      </main>
      <Footer
        brand={brand}
        year={new Date().getFullYear()}
        kits={kitMakes(kits ?? []).length > 0}
      />
      <MobileCartBar cartCount={cartCount} />
    </div>
  );
}
