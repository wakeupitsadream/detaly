/**
 * Environment schema: the single registry of every variable the system reads.
 * Every key here must appear in the root .env.example and vice versa (enforced by a test).
 *
 * Phase tags in comments: [ф0] phase 0, [ф1A]/[ф1B]/[ф1C], [ф2], [ф3], [infra] = read only by
 * compose/Caddy/backup containers, kept here so the registry is complete.
 *
 * Empty strings are treated as "not set" so a blank `KEY=` line in .env falls back to the
 * default. Values are never echoed in error messages (secrets).
 */
import { z } from 'zod';
import { ROSSKO_MODES, STAFF_ROLES, VIN_PROVIDERS } from '@detaly/domain/statuses';
import type { StaffSeed } from '@detaly/domain/types';

const optionalString = z.string().trim().min(1).optional();
/** An image served by the site itself: '/images/partner/logo.webp' (no host, no '..'). */
const sitePath = z
  .string()
  .trim()
  .regex(
    /^\/(?!\/)(?!.*\.\.)[\w./-]+\.(?:webp|png|svg|jpe?g)$/i,
    'expected a site path like /images/x.webp',
  );
const int = (min = 0) => z.coerce.number().int().min(min);
const bool = (defaultValue: boolean) => z.stringbool().default(defaultValue);

/** "a, b,,c" -> ['a','b','c'] */
const csvList = z.string().transform((value) =>
  value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0),
);

/** "3,6,9" -> [3,6,9] (positive integers). */
const csvPositiveInts = csvList.pipe(
  z.array(
    z
      .string()
      .regex(/^\d+$/, 'expected a positive integer')
      .transform(Number)
      .pipe(z.number().int().positive()),
  ),
);

/** Percent with at most two decimals, e.g. 28 or 27.5 (converted to basis points by callers). */
const percent = z.coerce
  .number()
  .min(0)
  .max(1000)
  .refine((value) => Math.abs(value * 100 - Math.round(value * 100)) < 1e-9, {
    message: 'at most two decimal places',
  });

const staffSeedEntry = z
  .object({
    name: z.string().trim().min(1),
    role: z.enum(STAFF_ROLES),
    tgUserId: z.number().int().positive().nullable().default(null),
    maxUserId: z.number().int().positive().nullable().default(null),
    isActive: z.boolean().default(true),
  })
  .strict()
  .refine((entry) => entry.tgUserId !== null || entry.maxUserId !== null, {
    message: 'tgUserId or maxUserId is required',
  });

/** JSON array of staff entries, e.g. [{"name":"Максим","role":"owner","tgUserId":123}]. */
const staffSeedJson = z
  .string()
  .transform((value, ctx): unknown => {
    try {
      return JSON.parse(value) as unknown;
    } catch {
      ctx.addIssue({ code: 'custom', message: 'invalid JSON' });
      return z.NEVER;
    }
  })
  .pipe(z.array(staffSeedEntry));

const envShape = {
  // --- Application [ф0] ---
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  TZ: z.string().default('Asia/Yekaterinburg'),
  APP_BASE_URL: z.url().default('http://localhost:3000'),
  SESSION_SECRET: z.string().min(32),
  ADMIN_BASIC_AUTH: z
    .string()
    .regex(/^[^:]+:.+$/, 'expected user:password')
    .optional(),
  /** Required unless DEMO_MODE=true (see the refinement below); read via databaseUrl(env). */
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }).optional(),
  /** Required unless DEMO_MODE=true (see the refinement below); read via redisUrl(env). */
  REDIS_URL: z.url({ protocol: /^rediss?$/ }).optional(),
  /**
   * Storefront demo without Postgres and Redis (docs/design.md, section 5): fixture search,
   * cart in a signed cookie, checkout and orders disabled. Requires ROSSKO_MODE=fixtures and no
   * YooKassa settings.
   */
  DEMO_MODE: bool(false),
  GIT_SHA: z.string().default('dev'),
  NOINDEX_ALL: bool(false),
  TRUSTED_IP_HEADER: z.enum(['none', 'x-real-ip']).default('none'),
  HEARTBEAT_STALE_SEC: int(1).default(300),

  // --- Storage and backup [ф0] ---
  S3_ENDPOINT: z.url().optional(),
  S3_REGION: optionalString,
  S3_BUCKET: optionalString,
  S3_KEY: optionalString,
  S3_SECRET: optionalString,
  BACKUP_PASSPHRASE: optionalString,
  BACKUP_AGE_RECIPIENT: z
    .string()
    .regex(/^age1[0-9a-z]+$/, 'expected an age public key (age1...)')
    .optional(),

  // --- Photos: VIN requests, claims, packaging [ф1C] (@detaly/files, decision С18) ---
  /** none: photos off (forms hide the field); local: FILES_LOCAL_DIR (dev, e2e); s3: S3_*. */
  FILES_STORAGE: z.enum(['none', 'local', 's3']).default('none'),
  FILES_LOCAL_DIR: z.string().trim().min(1).default('var/files'),
  /** Bucket of the photos; default S3_BUCKET (backups live under BACKUP_PREFIX there). */
  FILES_S3_BUCKET: optionalString,
  FILES_S3_PREFIX: z.string().trim().min(1).default('files/'),
  /** One uploaded photo, megabytes (decision С19). */
  FILES_MAX_UPLOAD_MB: int(1).max(12).default(8),

  // --- Backup container [infra] (infra/backup/*.sh; see docs/runbook.md) ---
  BACKUP_STORAGE: z.enum(['s3', 'local']).default('s3'),
  BACKUP_PREFIX: z.string().trim().min(1).default('postgres'),
  BACKUP_RETENTION_DAYS: int(1).default(30),
  BACKUP_LOCAL_DIR: z.string().trim().min(1).default('/backups'),
  /** '1' = take a dump when the backup container starts (entrypoint.sh compares to '1'). */
  BACKUP_ON_START: z.enum(['0', '1']).default('0'),
  HEALTHWATCH_REPEAT_MIN: int(1).default(60),

  // --- Postgres container [infra]; compose builds DATABASE_URL for containers from these ---
  POSTGRES_USER: z.string().trim().min(1).default('detaly'),
  /** URL-safe: substituted into DATABASE_URL by compose; deploy.sh rejects empty and 'detaly'. */
  POSTGRES_PASSWORD: z
    .string()
    .regex(/^[A-Za-z0-9._~-]+$/, 'expected URL-safe characters (openssl rand -hex 24)')
    .optional(),
  POSTGRES_DB: z.string().trim().min(1).default('detaly'),

  // --- Deploy [infra] ---
  IMAGE_REGISTRY: z.string().trim().min(1).default('ghcr.io/wakeupitsadream'),
  IMAGE_TAG: optionalString,
  /** Image tag for the stage profile; defaults to IMAGE_TAG (deploy.sh stage sets it). */
  STAGE_IMAGE_TAG: optionalString,
  SITE_DOMAIN: optionalString,
  STAGE_DOMAIN: optionalString,
  ACME_EMAIL: z.email().optional(),
  STAGE_BASIC_AUTH_USER: optionalString,
  STAGE_BASIC_AUTH_HASH: optionalString,

  // --- Brand, seller requisites, pickup point [ф0] ---
  BRAND_NAME: z.string().trim().min(1).default('Детали'),
  // Full name of the sole proprietor WITHOUT the "ИП" prefix: the site and the legal texts add
  // "ИП" / "индивидуальный предприниматель" themselves. A leading prefix is stripped so that
  // "ИП Иванов И. И." does not render as "ИП ИП Иванов И. И.".
  SELLER_REQUISITES_NAME: z
    .string()
    .trim()
    .transform((value) =>
      value.replace(/^(?:ИП|индивидуальный\s+предприниматель)(?:\s+|\.\s*|$)/iu, '').trim(),
    )
    .pipe(z.string().min(1))
    .optional(),
  SELLER_REQUISITES_INN: z
    .string()
    .regex(/^\d{10}(\d{2})?$/, 'expected 10 or 12 digits')
    .optional(),
  SELLER_REQUISITES_OGRNIP: z
    .string()
    .regex(/^\d{15}$/, 'expected 15 digits')
    .optional(),
  SELLER_REQUISITES_ADDRESS: optionalString,
  SELLER_REQUISITES_EMAIL: z.email().optional(),
  SELLER_REQUISITES_PHONE: optionalString,
  PICKUP_POINT_NAME: optionalString,
  PICKUP_ADDRESS: optionalString,
  PICKUP_HOURS: optionalString,
  PICKUP_PHONE: optionalString,
  // Route links of the pickup point (plain <a>, opened in the maps app) [дизайн]
  PICKUP_MAP_URL_YANDEX: z.url({ protocol: /^https$/ }).optional(),
  PICKUP_MAP_URL_2GIS: z.url({ protocol: /^https$/ }).optional(),
  // Chat of the pickup point for a VIN request with a photo of the СТС, e.g. https://t.me/name
  PICKUP_TELEGRAM_URL: z.url({ protocol: /^https$/ }).optional(),
  // Logo of the pickup partner, a site path under public/ (CSP img-src 'self') [дизайн v2]:
  // the colour mark for white cards and the white emblem for the red header and dark panel.
  PICKUP_LOGO_SRC: sitePath.optional(),
  PICKUP_EMBLEM_WHITE_SRC: sitePath.optional(),
  STAFF_SEED_JSON: staffSeedJson.default([]),

  // --- Reviews [шаг 3] (docs/reviews.md): the shop's own cards in the map services ---
  // The reviews tab of the card (https). A platform is offered only when its link is set;
  // with neither set the review buttons, /review and the rating line do not exist.
  REVIEW_URL_YANDEX: z.url({ protocol: /^https$/ }).optional(),
  REVIEW_URL_2GIS: z.url({ protocol: /^https$/ }).optional(),

  // --- Fit check [шаг 4] (docs/fit-check.md): «Проверим, подойдёт ли» ---
  // The fit guarantee promise («Не подойдёт по применимости — вернём деньги», the section on
  // /returns, order_items.fit_guarantee at checkout). Off until the founder and the lawyer decide
  // who pays for such a return and the offer says so; off, the site shows only «Проверено
  // мастером».
  FIT_GUARANTEE_ENABLED: bool(false),

  // --- Installation partner [ф1C] (decision С6): without the name booking is hidden ---
  /** The service that installs parts and bills the client itself (e.g. «Сервис56»). */
  INSTALL_PARTNER_NAME: optionalString,
  /** «ИП …, ИНН …» in the text «установка оплачивается в сервисе по его чеку». */
  INSTALL_PARTNER_REQUISITES: optionalString,

  // --- Rossko [ф0] ---
  ROSSKO_MODE: z.enum(ROSSKO_MODES).default('fixtures'),
  ROSSKO_KEY1: optionalString,
  ROSSKO_KEY2: optionalString,
  ROSSKO_WSDL_BASE: z.url().default('https://api.rossko.ru/service/v2.1'),
  ROSSKO_DELIVERY_ID: optionalString,
  ROSSKO_ADDRESS_ID: optionalString,
  ROSSKO_PAYMENT_ID: optionalString,
  ROSSKO_LOCAL_STOCK_IDS: csvList.default([]),
  ROSSKO_RPM_LIMIT: int(1).default(250),
  ROSSKO_DAILY_LIMIT: int(1).default(90000),
  ROSSKO_QUOTA_BREAKER_PCT: int(1).max(100).default(70),
  ROSSKO_ALLOW_CHECKOUT: bool(false),
  ROSSKO_TIMEOUT_MS: int(1).default(15000),

  // --- Pricing and terms (defaults for `settings`; admin edits win) [ф0/ф1] ---
  PRICING_MARKUP_PCT: percent.default(28),
  PRICE_DRIFT_TOLERANCE_PCT: percent.default(3),
  MARGIN_FLOOR_PCT: percent.default(10),
  /** rubles */
  MIN_ORDER_TOTAL: int().default(0),
  MIN_MARGIN_RUB: int().default(0),
  ETA_BUFFER_DAYS: int().default(1),
  ORDER_PAYMENT_TTL_MIN: int(1).default(120),
  /** rubles */
  ON_PICKUP_MAX_TOTAL: int().default(15000),
  ON_PICKUP_CONFIRM_TTL_H: int(1).default(24),
  PICKUP_WINDOW_PREPAID_DAYS: int(1).default(10),
  PICKUP_WINDOW_COD_DAYS: int(1).default(7),
  SUPPLIER_RETURN_DAYS: int(1).default(14),
  SUPPLIER_INVOICE_LAG_DAYS: int().default(1),
  HANDED_COMPLETE_DAYS: int(1).default(7),
  HANDOVER_QR_TTL_MIN: int(1).default(15),
  NO_SHOW_LIMIT: int(1).default(2),
  REMINDER_DAYS: csvPositiveInts.default([3, 6, 9]),
  /** rubles */
  COURIER_FEE_RUB: int().default(0),
  /** Max-Age of the `cart` cookie in days [ф1A]. */
  CART_TTL_DAYS: int(1).default(30),

  // --- YooKassa [ф0 spike / ф1B] ---
  YOOKASSA_SHOP_ID: optionalString,
  YOOKASSA_SECRET_KEY: optionalString,
  YOOKASSA_API_URL: z.url().default('https://api.yookassa.ru/v3'),
  YOOKASSA_TAX_SYSTEM_CODE: z.coerce.number().int().min(1).max(6).optional(),
  YOOKASSA_VAT_CODE: z.coerce.number().int().min(1).max(12).optional(),
  YOOKASSA_WEBHOOK_IP_ALLOWLIST: csvList.default([]),
  YOOKASSA_RETURN_URL: z.url().optional(),

  // --- Bots and SMS [ф0 seller bot / ф1C / ф2] ---
  TG_SELLER_BOT_TOKEN: optionalString,
  TG_SELLER_CHAT_ID: z.coerce.number().int().optional(),
  TG_CLIENT_BOT_TOKEN: optionalString,
  TG_CLIENT_BOT_USERNAME: optionalString,
  MAX_BOT_TOKEN: optionalString,
  MAX_BOT_USERNAME: optionalString,
  MAX_WEBHOOK_SECRET: optionalString,
  SMS_PROVIDER: z.enum(['none', 'smsaero', 'smsc']).default('none'),
  SMS_API_KEY: optionalString,
  SMS_SENDER: optionalString,
  SMS_MONTHLY_BUDGET_RUB: int().optional(),
  /** [ф1B] SMS Aero login (e-mail) or smsc.ru login; the password/key is SMS_API_KEY. */
  SMS_LOGIN: optionalString,
  /**
   * [ф1B] Gateway URL override (tests, stage). Default by SMS_PROVIDER:
   * https://gate.smsaero.ru/v2 or https://smsc.ru/sys (VERIFY: both addresses with the provider).
   */
  SMS_API_URL: z.url().optional(),
  /** [ф1B] Price of one SMS in kopecks for the monthly budget (VERIFY: provider tariff). */
  SMS_PRICE_KOP: int().default(500),
  SMARTCAPTCHA_CLIENT_KEY: optionalString,
  SMARTCAPTCHA_SERVER_KEY: optionalString,

  // --- VIN [ф1C manual / ф3 catalogue] ---
  VIN_PROVIDER: z.enum(VIN_PROVIDERS).default('manual'),
  LAXIMO_LOGIN: optionalString,
  LAXIMO_KEY: optionalString,
  ACAT_TOKEN: optionalString,
  PARTSAPI_KEY: optionalString,
  VIN_MONTHLY_BUDGET_RUB: int().optional(),

  // --- Legal [ф0] ---
  LEGAL_OFFER_VERSION: optionalString,
  LEGAL_PRIVACY_VERSION: optionalString,
  LEGAL_CONSENT_PD_VERSION: optionalString,
  LEGAL_CONSENT_MARKETING_VERSION: optionalString,
  LEGAL_RETURN_MEMO_VERSION: optionalString,
  /**
   * Lets the seed publish a text that still calls itself a draft («Черновик, требует вычитки
   * юристом», «Для юриста:», «— уточнить»). Only for tests and e2e; never in production.
   */
  LEGAL_ALLOW_DRAFT_PUBLISH: bool(false),
  RKN_NOTICE_NUMBER: optionalString,
};

/** YooKassa settings a demo must not carry: it never takes money. */
const DEMO_FORBIDDEN_YOOKASSA = [
  'YOOKASSA_SHOP_ID',
  'YOOKASSA_SECRET_KEY',
  'YOOKASSA_TAX_SYSTEM_CODE',
  'YOOKASSA_VAT_CODE',
  'YOOKASSA_RETURN_URL',
] as const;

export const envSchema = z.object(envShape).superRefine((env, ctx) => {
  if (env.DEMO_MODE === true) {
    if (env.ROSSKO_MODE !== 'fixtures') {
      ctx.addIssue({
        code: 'custom',
        path: ['ROSSKO_MODE'],
        message: 'must be fixtures when DEMO_MODE=true',
      });
    }
    for (const key of DEMO_FORBIDDEN_YOOKASSA) {
      if (env[key] !== undefined) {
        ctx.addIssue({ code: 'custom', path: [key], message: 'not allowed when DEMO_MODE=true' });
      }
    }
    if ((env.YOOKASSA_WEBHOOK_IP_ALLOWLIST ?? []).length > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['YOOKASSA_WEBHOOK_IP_ALLOWLIST'],
        message: 'not allowed when DEMO_MODE=true',
      });
    }
    // The demo never stores files (decision С21).
    if (env.FILES_STORAGE !== 'none') {
      ctx.addIssue({
        code: 'custom',
        path: ['FILES_STORAGE'],
        message: 'must be none when DEMO_MODE=true',
      });
    }
  } else {
    for (const key of ['DATABASE_URL', 'REDIS_URL'] as const) {
      if (!env[key]) {
        ctx.addIssue({ code: 'custom', path: [key], message: 'required unless DEMO_MODE=true' });
      }
    }
  }
  if (env.FILES_STORAGE === 's3') {
    for (const key of ['S3_ENDPOINT', 'S3_KEY', 'S3_SECRET'] as const) {
      if (!env[key]) {
        ctx.addIssue({ code: 'custom', path: [key], message: 'required when FILES_STORAGE=s3' });
      }
    }
    if (!env.FILES_S3_BUCKET && !env.S3_BUCKET) {
      ctx.addIssue({
        code: 'custom',
        path: ['FILES_S3_BUCKET'],
        message: 'FILES_S3_BUCKET or S3_BUCKET is required when FILES_STORAGE=s3',
      });
    }
  }
  if (env.ROSSKO_MODE === 'live') {
    for (const key of ['ROSSKO_KEY1', 'ROSSKO_KEY2'] as const) {
      if (!env[key]) {
        ctx.addIssue({ code: 'custom', path: [key], message: 'required when ROSSKO_MODE=live' });
      }
    }
  }
});

export type Env = z.output<typeof envSchema>;
export type EnvKey = keyof typeof envShape;

/** All variable names known to the system, in schema order. */
export const ENV_KEYS = Object.keys(envShape) as EnvKey[];

// Compile-time check: STAFF_SEED_JSON entries match the shared StaffSeed contract.
const _staffSeedCheck: StaffSeed[] = [] as Env['STAFF_SEED_JSON'];
void _staffSeedCheck;

export class EnvError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Invalid environment:\n  ${issues.join('\n  ')}`);
    this.name = 'EnvError';
    this.issues = issues;
  }
}

type EnvSource = Record<string, string | undefined>;

/** Host names Vercel sets for a deployment (system env, docs/demo-vercel.md). */
const VERCEL_HOST_RE = /^[a-z0-9.-]+$/i;

/**
 * DEMO_MODE on Vercel without APP_BASE_URL: the host Vercel exposes (production: the project's
 * VERCEL_PROJECT_PRODUCTION_URL, a preview: its own VERCEL_URL), so the same-origin checks
 * of the cart accept the demo's own address. Never used outside the demo or over an explicit
 * APP_BASE_URL.
 */
function demoVercelBaseUrl(source: EnvSource, input: Record<string, string>): string | null {
  if (input.APP_BASE_URL !== undefined || input.DEMO_MODE === undefined) return null;
  if (!/^(?:true|1|yes|on|y|enabled)$/i.test(input.DEMO_MODE.trim())) return null;
  // A preview answers on its own deployment host; production on the project's main domain.
  const hosts =
    source.VERCEL_ENV === 'production'
      ? [source.VERCEL_PROJECT_PRODUCTION_URL, source.VERCEL_URL]
      : [source.VERCEL_URL, source.VERCEL_PROJECT_PRODUCTION_URL];
  const host = hosts
    .map((value) => value?.trim())
    .find((value) => value && VERCEL_HOST_RE.test(value));
  return host ? `https://${host}` : null;
}

/**
 * GIT_SHA on Vercel (the demo) when it is not set explicitly: the short commit of the build
 * from VERCEL_GIT_COMMIT_SHA, so a log line tells which deployment wrote it. Production sets
 * GIT_SHA itself (infra/deploy.sh).
 */
function vercelGitSha(source: EnvSource, input: Record<string, string>): string | null {
  if (input.GIT_SHA !== undefined) return null;
  const sha = source.VERCEL_GIT_COMMIT_SHA?.trim();
  return sha && /^[0-9a-f]{7,40}$/i.test(sha) ? sha.slice(0, 7).toLowerCase() : null;
}

/** Parses an env-like record (default process.env). Throws EnvError listing bad keys. */
export function parseEnv(source: EnvSource = process.env): Env {
  const input: Record<string, string> = {};
  for (const key of ENV_KEYS) {
    const value = source[key];
    if (value !== undefined && value !== '') input[key] = value;
  }
  const vercelBaseUrl = demoVercelBaseUrl(source, input);
  if (vercelBaseUrl) input.APP_BASE_URL = vercelBaseUrl;
  const vercelSha = vercelGitSha(source, input);
  if (vercelSha) input.GIT_SHA = vercelSha;
  const result = envSchema.safeParse(input);
  if (!result.success) {
    throw new EnvError(
      result.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
    );
  }
  return result.data;
}

/** DATABASE_URL of a parsed env; throws when it is absent (only possible with DEMO_MODE=true). */
export function databaseUrl(env: Pick<Env, 'DATABASE_URL'>): string {
  if (!env.DATABASE_URL) throw new EnvError(['DATABASE_URL: not set (DEMO_MODE=true?)']);
  return env.DATABASE_URL;
}

/** REDIS_URL of a parsed env; throws when it is absent (only possible with DEMO_MODE=true). */
export function redisUrl(env: Pick<Env, 'REDIS_URL'>): string {
  if (!env.REDIS_URL) throw new EnvError(['REDIS_URL: not set (DEMO_MODE=true?)']);
  return env.REDIS_URL;
}

let cached: Env | undefined;

/**
 * Lazily parsed and cached process.env. Never call at module top level in code that
 * Next.js may evaluate during `next build`.
 */
export function getEnv(): Env {
  cached ??= parseEnv(process.env);
  return cached;
}

/** Test helper: forget the cached value so the next getEnv() re-reads process.env. */
export function resetEnvCache(): void {
  cached = undefined;
}
