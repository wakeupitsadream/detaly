import type { MetadataRoute } from 'next';
import { serverEnv } from '@/server/env';

// Read at request time: NOINDEX_ALL differs between prod and stage with the same image.
export const dynamic = 'force-dynamic';

export default function robots(): MetadataRoute.Robots {
  const env = serverEnv();
  if (env.NOINDEX_ALL) {
    return { rules: [{ userAgent: '*', disallow: '/' }] };
  }
  // /search and /api/ are NOT disallowed: they carry X-Robots-Tag noindex (proxy.ts,
  // next.config), and a crawler that may not fetch a page never sees that header, so an
  // externally linked /search?q=… could be indexed as a bare URL. Private paths stay closed.
  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        disallow: ['/o/', '/p/', '/admin'],
      },
    ],
  };
}
