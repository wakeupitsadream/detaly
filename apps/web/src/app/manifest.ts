import type { MetadataRoute } from 'next';
import { serverEnv } from '@/server/env';

// BRAND_NAME is read at request time (one image for every brand and stage).
export const dynamic = 'force-dynamic';

/** /manifest.webmanifest: the name and icon of a home-screen shortcut. */
export default function manifest(): MetadataRoute.Manifest {
  const name = serverEnv().BRAND_NAME;
  return {
    name: `${name} — автозапчасти`,
    short_name: name,
    start_url: '/',
    display: 'browser',
    background_color: '#ffffff',
    theme_color: '#b3291e',
    icons: [
      { src: '/icon.svg', type: 'image/svg+xml', sizes: 'any' },
      { src: '/apple-icon.png', type: 'image/png', sizes: '180x180' },
    ],
  };
}
