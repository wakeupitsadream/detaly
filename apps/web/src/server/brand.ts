/**
 * Brand, seller requisites and the pickup point, only from env (BRAND_NAME,
 * SELLER_REQUISITES_*, PICKUP_*): nothing of it is hard-coded in the source.
 */
import type { Env } from './env';
import { serverEnv } from './env';

export interface Brand {
  name: string;
  siteUrl: string;
  seller: {
    name: string | null;
    inn: string | null;
    ogrnip: string | null;
    address: string | null;
    email: string | null;
    phone: string | null;
  };
  pickup: {
    name: string | null;
    address: string | null;
    hours: string | null;
    phone: string | null;
  };
  /** Routes to the pickup point and its chat (PICKUP_MAP_URL_*, PICKUP_TELEGRAM_URL). */
  pickupLinks?: {
    yandexMap: string | null;
    twoGisMap: string | null;
    telegram: string | null;
  };
  /**
   * Marks of the pickup partner (PICKUP_LOGO_SRC, PICKUP_EMBLEM_WHITE_SRC), site paths under
   * public/: the colour logo for white cards, the white emblem for the red header and the dark
   * panel. Null: a pin icon stands instead.
   */
  pickupLogo?: {
    color: string | null;
    emblemWhite: string | null;
  };
  /** Phone for questions and VIN requests: pickup point first, then the seller. */
  contactPhone: string | null;
  /** ROSSKO_MODE=fixtures: prices and stock are synthetic. */
  demoData: boolean;
  noindexAll: boolean;
}

export function brandFromEnv(env: Env): Brand {
  return {
    name: env.BRAND_NAME,
    siteUrl: env.APP_BASE_URL,
    seller: {
      name: env.SELLER_REQUISITES_NAME ?? null,
      inn: env.SELLER_REQUISITES_INN ?? null,
      ogrnip: env.SELLER_REQUISITES_OGRNIP ?? null,
      address: env.SELLER_REQUISITES_ADDRESS ?? null,
      email: env.SELLER_REQUISITES_EMAIL ?? null,
      phone: env.SELLER_REQUISITES_PHONE ?? null,
    },
    pickup: {
      name: env.PICKUP_POINT_NAME ?? null,
      address: env.PICKUP_ADDRESS ?? null,
      hours: env.PICKUP_HOURS ?? null,
      phone: env.PICKUP_PHONE ?? null,
    },
    pickupLinks: {
      yandexMap: env.PICKUP_MAP_URL_YANDEX ?? null,
      twoGisMap: env.PICKUP_MAP_URL_2GIS ?? null,
      telegram: env.PICKUP_TELEGRAM_URL ?? null,
    },
    pickupLogo: {
      color: env.PICKUP_LOGO_SRC ?? null,
      emblemWhite: env.PICKUP_EMBLEM_WHITE_SRC ?? null,
    },
    contactPhone: env.PICKUP_PHONE ?? env.SELLER_REQUISITES_PHONE ?? null,
    demoData: env.ROSSKO_MODE === 'fixtures',
    // DEMO_MODE is never indexed either (fixture prices, nothing can be ordered).
    noindexAll: env.NOINDEX_ALL || env.DEMO_MODE,
  };
}

export function getBrand(): Brand {
  return brandFromEnv(serverEnv());
}

/** 'tel:' href from a human-written phone: '+7 (3532) 00-00-00' -> 'tel:+73532000000'. */
export function telHref(phone: string): string {
  return `tel:${phone.replace(/[^\d+]/g, '')}`;
}
