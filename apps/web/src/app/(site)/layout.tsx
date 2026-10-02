import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { Footer } from '@/components/Footer';
import { SiteHeader } from '@/components/SiteHeader';
import { getBrand } from '@/server/brand';

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

export default function SiteLayout({ children }: { children: ReactNode }) {
  const brand = getBrand();
  return (
    <div className="flex min-h-screen min-w-0 flex-col">
      <SiteHeader brandName={brand.name} />
      <main className="mx-auto w-full max-w-5xl min-w-0 flex-1 px-4 py-6 md:py-10">{children}</main>
      <Footer brand={brand} year={new Date().getFullYear()} />
    </div>
  );
}
