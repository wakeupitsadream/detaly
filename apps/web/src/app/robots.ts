import type { MetadataRoute } from 'next';
import { serverEnv } from '@/server/env';

// Read at request time: NOINDEX_ALL differs between prod and stage with the same image.
export const dynamic = 'force-dynamic';

export default function robots(): MetadataRoute.Robots {
  const env = serverEnv();
  if (env.NOINDEX_ALL) {
    return { rules: [{ userAgent: '*', disallow: '/' }] };
  }
  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        disallow: ['/search', '/api/', '/o/', '/p/', '/admin'],
      },
    ],
  };
}
