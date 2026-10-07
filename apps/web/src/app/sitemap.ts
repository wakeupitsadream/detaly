import type { MetadataRoute } from 'next';
import { serverEnv } from '@/server/env';

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

/** /sitemap.xml: empty on a stage and in the demo (robots.txt closes them anyway). */
export default function sitemap(): MetadataRoute.Sitemap {
  const env = serverEnv();
  if (env.NOINDEX_ALL || env.DEMO_MODE) return [];
  return SITEMAP_PATHS.map((path) => ({ url: new URL(path, env.APP_BASE_URL).toString() }));
}
