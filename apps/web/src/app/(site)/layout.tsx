import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { DemoStrip } from '@/components/DemoStrip';
import { Footer } from '@/components/Footer';
import { MobileCartBar } from '@/components/MobileCartBar';
import { SiteHeader } from '@/components/SiteHeader';
import { getBrand } from '@/server/brand';
import { requestCartCount } from '@/server/cart/count';
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
    title: { default: `${brand.name} — автозапчасти по артикулу`, template: `%s — ${brand.name}` },
    description:
      'Автозапчасти по артикулу с ценой и датой получения. Со склада в городе — оплата при получении.',
    robots: brand.noindexAll ? { index: false, follow: false } : undefined,
  };
}

export default async function SiteLayout({ children }: { children: ReactNode }) {
  const brand = getBrand();
  // One query by the cart cookie; a database failure shows 0 instead of failing the page.
  const cartCount = await requestCartCount();
  return (
    <div className="flex min-h-screen min-w-0 flex-col">
      <a
        href="#main"
        className="sr-only z-50 bg-accent px-4 py-2 font-semibold text-ink focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
      >
        К содержимому
      </a>
      {brand.demoData ? <DemoStrip demoMode={isDemoMode()} /> : null}
      <SiteHeader brandName={brand.name} cartCount={cartCount} />
      {/* A centred column by default; a page rooted in <FullBleed> lays out full-width
          Sections itself (.site-main in globals.css). */}
      <main id="main" className="site-main flex-1">
        {children}
      </main>
      <Footer brand={brand} year={new Date().getFullYear()} />
      <MobileCartBar cartCount={cartCount} />
    </div>
  );
}
