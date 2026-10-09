import type { MetadataRoute } from 'next';
import { KITS_PATH, kitMakePath, kitModelPath } from '@/lib/kit-paths';
import { serverEnv } from '@/server/env';
import { kitMakes, kitModels, publishedKits } from '@/server/kits/catalog';

// Read at request time: NOINDEX_ALL and DEMO_MODE differ between prod, stage and the demo.
export const dynamic = 'force-dynamic';

/** Public pages worth indexing: no search, cart, checkout, orders or proposals. */
const SITEMAP_PATHS = [
  '/',
  '/vin',
  '/about',
  '/returns',
  '/docs/offer',
  '/docs/privacy',
  '/docs/consent',
  '/docs/consent-marketing',
  '/docs/return-memo',
] as const;

/**
 * Step 5 (docs/kits.md): /to, every make and every model with published kits (a kit is a section
 * of its model page). Only published kits: a draft never reaches a search engine; a database
 * failure leaves them out this time.
 */
async function kitPaths(): Promise<string[]> {
  const list = await publishedKits();
  const makes = kitMakes(list ?? []);
  if (makes.length === 0) return [];
  return [
    KITS_PATH,
    ...makes.flatMap(({ brand }) => [
      kitMakePath(brand.slug),
      ...kitModels(list ?? [], brand.slug).map((entry) =>
        kitModelPath(brand.slug, entry.modelSlug),
      ),
    ]),
  ];
}

/** /sitemap.xml: empty on a stage and in the demo (robots.txt closes them anyway). */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const env = serverEnv();
  if (env.NOINDEX_ALL || env.DEMO_MODE) return [];
  const paths = [...SITEMAP_PATHS, ...(await kitPaths())];
  return paths.map((path) => ({ url: new URL(path, env.APP_BASE_URL).toString() }));
}
