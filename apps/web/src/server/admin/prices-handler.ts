/**
 * POST /api/admin/prices (step 2, docs/pricing.md): the forms of /admin/prices.
 *
 * - record: one comparison — brand, article, competitor, its price and the delivery to Orenburg,
 *   its term in days, a link and a note. The server looks up our own best exact offer with the
 *   shared supplier client (through the 15-minute cache) and the current PricingConfig
 *   (bestExactOffer) and stores its snapshot next to the competitor's price. When the supplier
 *   has no such offer or does not answer, the comparison is stored without our side.
 * - delete: removes a mistaken record («подтверждаю» tick required).
 *
 * Order of checks as in the other admin handlers: Basic auth (401/404, again after the proxy)
 * -> Origin (403) -> urlencoded body (400/413) -> fields (422). Done: 303 back to the list with
 * `?done=`. Logs carry the action and the outcome only.
 */
import type { Env } from '@detaly/config';
import { eq, priceBenchmarks, type Database } from '@detaly/db';
import {
  BENCHMARK_COMPETITORS,
  formatRub,
  isOneOf,
  PRICE_GROUPS,
  type BenchmarkCompetitor,
  type PriceGroup,
} from '@detaly/domain';
import type { RosskoClient } from '@detaly/rossko';
import { ADMIN_RESPONSE_HEADERS } from '../admin-auth';
import { readBoundedText } from '../body';
import { errorInfo } from '../errors';
import { isSameOrigin } from '../request-guards';
import { normalizeSearchInput, SearchInputError } from '../search-service';
import type { SearchSettings } from '../settings';
import { CONFIRM_FIELD, CONFIRM_VALUE } from './destructive';
import { formField, parseRubToKop } from './form-fields';
import { adminAuthFailure, adminPage } from './http';
import { bestExactOffer, type OurOfferSnapshot } from './our-offer';
import {
  adminPricesHref,
  COMPETITOR_LABELS,
  parseAdminPricesQuery,
  type AdminPricesQuery,
} from './prices';
import { isUuid } from './queries';

/** A handful of short fields. */
export const MAX_ADMIN_PRICES_BODY_BYTES = 8 * 1024;
/** Largest competitor price accepted: 1 000 000 ₽. */
export const MAX_BENCHMARK_PRICE_KOP = 100_000_000;
/** Largest delivery accepted: 100 000 ₽. */
export const MAX_BENCHMARK_DELIVERY_KOP = 10_000_000;
export const BENCHMARK_BRAND_MAX = 64;
export const BENCHMARK_NOTE_MAX = 300;
export const BENCHMARK_URL_MAX = 500;
export const BENCHMARK_ETA_MAX_DAYS = 365;

export interface AdminPricesDeps {
  db: Database;
  env: Pick<Env, 'ADMIN_BASIC_AUTH' | 'APP_BASE_URL'>;
  supplier: {
    rossko: Pick<RosskoClient, 'search'>;
    settings: { get(): Promise<SearchSettings> };
  };
  logger?: {
    info(details: Record<string, unknown>, message: string): void;
    warn(details: Record<string, unknown>, message: string): void;
    error(details: Record<string, unknown>, message: string): void;
  };
  now?: () => Date;
}

export interface BenchmarkInput {
  brand: string;
  articleNorm: string;
  competitor: BenchmarkCompetitor;
  competitorPriceKop: number;
  competitorDeliveryKop: number;
  competitorEtaDays: number | null;
  sourceUrl: string | null;
  note: string | null;
  /** The group chosen by hand, used only when we have no such offer. */
  manualGroup: PriceGroup | null;
}

export type BenchmarkInputResult =
  { ok: true; input: BenchmarkInput } | { ok: false; message: string };

function parseUrl(raw: string): string | null | false {
  if (raw === '') return null;
  if (raw.length > BENCHMARK_URL_MAX) return false;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : false;
  } catch {
    return false;
  }
}

/** The fields of the «Записать сравнение» form; a Russian message for the first bad one. */
export function parseBenchmarkForm(form: URLSearchParams): BenchmarkInputResult {
  const brand = formField(form, 'brand', 200).replace(/\s+/g, ' ');
  if (brand === '') return { ok: false, message: 'Укажите бренд' };
  if (brand.length > BENCHMARK_BRAND_MAX) {
    return { ok: false, message: `Бренд — до ${BENCHMARK_BRAND_MAX} символов` };
  }
  let articleNorm: string;
  try {
    articleNorm = normalizeSearchInput({ q: formField(form, 'article', 200) }).articleNorm;
  } catch (error) {
    if (error instanceof SearchInputError) return { ok: false, message: error.message };
    throw error;
  }
  const competitor = formField(form, 'competitor', 32);
  if (!isOneOf(BENCHMARK_COMPETITORS, competitor)) {
    return { ok: false, message: 'Выберите, где смотрели цену' };
  }
  const price = parseRubToKop(formField(form, 'price', 32));
  if (price === null || price <= 0 || price > MAX_BENCHMARK_PRICE_KOP) {
    return { ok: false, message: 'Цена конкурента — сумма в рублях, например 1 250 или 1250,50' };
  }
  const deliveryRaw = formField(form, 'delivery', 32);
  const delivery = deliveryRaw === '' ? 0 : parseRubToKop(deliveryRaw);
  if (delivery === null || delivery > MAX_BENCHMARK_DELIVERY_KOP) {
    return { ok: false, message: 'Доставка — сумма в рублях, 0 если самовывоз' };
  }
  const etaRaw = formField(form, 'eta', 8);
  let eta: number | null = null;
  if (etaRaw !== '') {
    if (!/^\d{1,3}$/.test(etaRaw) || Number(etaRaw) > BENCHMARK_ETA_MAX_DAYS) {
      return { ok: false, message: `Срок — целое число дней от 0 до ${BENCHMARK_ETA_MAX_DAYS}` };
    }
    eta = Number(etaRaw);
  }
  const url = parseUrl(formField(form, 'url', BENCHMARK_URL_MAX + 1));
  if (url === false) {
    return { ok: false, message: `Ссылка — адрес http(s), до ${BENCHMARK_URL_MAX} символов` };
  }
  const note = formField(form, 'note', BENCHMARK_NOTE_MAX + 1);
  if (note.length > BENCHMARK_NOTE_MAX) {
    return { ok: false, message: `Заметка — до ${BENCHMARK_NOTE_MAX} символов` };
  }
  const group = formField(form, 'group', 32);
  return {
    ok: true,
    input: {
      brand,
      articleNorm,
      competitor,
      competitorPriceKop: price,
      competitorDeliveryKop: delivery,
      competitorEtaDays: eta,
      sourceUrl: url,
      note: note === '' ? null : note,
      manualGroup: isOneOf(PRICE_GROUPS, group) ? group : null,
    },
  };
}

function backQuery(form: URLSearchParams): AdminPricesQuery {
  return parseAdminPricesQuery({
    group: form.get('back_group') ?? undefined,
    days: form.get('back_days') ?? undefined,
  });
}

function seeOther(location: string): Response {
  return new Response(null, {
    status: 303,
    headers: { ...ADMIN_RESPONSE_HEADERS, Location: location },
  });
}

type Lookup = { found: OurOfferSnapshot } | { found: null; reason: 'none' | 'supplier' };

async function lookupOurOffer(
  deps: AdminPricesDeps,
  input: BenchmarkInput,
  settings: SearchSettings,
  now: Date,
): Promise<Lookup> {
  let offers;
  try {
    // Through the cache and the shared limiter, like a search on the site.
    ({ offers } = await deps.supplier.rossko.search(input.articleNorm, { priority: 'search' }));
  } catch (error) {
    deps.logger?.warn({ ...errorInfo(error) }, 'admin prices: supplier search failed');
    return { found: null, reason: 'supplier' };
  }
  const found = bestExactOffer(
    offers,
    { brand: input.brand, articleNorm: input.articleNorm },
    settings,
    now,
  );
  return found ? { found } : { found: null, reason: 'none' };
}

export async function handleAdminPricesAction(
  request: Request,
  deps: AdminPricesDeps,
): Promise<Response> {
  try {
    return await handle(request, deps);
  } catch (error) {
    // Names and SQLSTATE only: a driver message carries the query parameters.
    deps.logger?.error({ ...errorInfo(error) }, 'admin prices action failed');
    return adminPage(500, 'Не удалось сохранить — попробуйте ещё раз', {
      href: '/admin/prices',
      label: 'К сравнению цен',
    });
  }
}

async function handle(request: Request, deps: AdminPricesDeps): Promise<Response> {
  const denied = adminAuthFailure(request, deps.env);
  if (denied) return denied;
  const list = { href: '/admin/prices', label: 'К сравнению цен' };
  if (!isSameOrigin(request.headers, deps.env.APP_BASE_URL)) {
    return adminPage(
      403,
      'Запрос отклонён: форма открыта не с этого сайта. Обновите страницу',
      list,
    );
  }
  const type = (request.headers.get('content-type') ?? '').toLowerCase();
  if (!type.includes('application/x-www-form-urlencoded')) {
    return adminPage(400, 'Не удалось прочитать форму', list);
  }
  const body = await readBoundedText(request, MAX_ADMIN_PRICES_BODY_BYTES);
  if (!body.ok) return adminPage(413, 'Форма слишком большая', list);
  const form = new URLSearchParams(body.text);
  const back = backQuery(form);
  const backLink = { href: adminPricesHref(back), label: 'К сравнению цен' };
  const action = formField(form, 'action', 16);
  const now = (deps.now ?? (() => new Date()))();

  if (action === 'delete') {
    const id = formField(form, 'id', 64);
    if (!isUuid(id)) return adminPage(404, 'Запись не найдена', backLink);
    if (form.get(CONFIRM_FIELD) !== CONFIRM_VALUE) {
      return adminPage(400, 'Отметьте «подтверждаю», чтобы удалить запись', backLink);
    }
    const deleted = await deps.db
      .delete(priceBenchmarks)
      .where(eq(priceBenchmarks.id, id))
      .returning({ id: priceBenchmarks.id });
    deps.logger?.info({ action, ok: deleted.length > 0 }, 'admin prices action');
    if (deleted.length === 0) return adminPage(404, 'Запись не найдена', backLink);
    return seeOther(adminPricesHref(back, 'Запись удалена'));
  }
  if (action !== 'record') return adminPage(400, 'Неизвестное действие', backLink);

  const parsed = parseBenchmarkForm(form);
  if (!parsed.ok) return adminPage(422, parsed.message, backLink);
  const { input } = parsed;
  const settings = await deps.supplier.settings.get();
  if (!settings.fromDatabase) {
    return adminPage(503, 'Не удалось загрузить настройки цен — попробуйте через минуту', backLink);
  }
  const lookup = await lookupOurOffer(deps, input, settings, now);
  const ours = lookup.found;
  await deps.db.insert(priceBenchmarks).values({
    brand: input.brand,
    article: input.articleNorm,
    priceGroup: ours?.priceGroup ?? input.manualGroup ?? 'other',
    competitor: input.competitor,
    competitorPriceKop: input.competitorPriceKop,
    competitorDeliveryKop: input.competitorDeliveryKop,
    competitorEtaDays: input.competitorEtaDays,
    sourceUrl: input.sourceUrl,
    note: input.note,
    ourSupplierKop: ours?.ourSupplierKop ?? null,
    ourPriceKop: ours?.ourPriceKop ?? null,
    ourIsLocal: ours?.ourIsLocal ?? null,
    ourEtaDays: ours?.ourEtaDays ?? null,
    capturedAt: now,
    capturedBy: 'admin',
  });
  deps.logger?.info(
    { action, ok: true, found: ours !== null, group: ours?.priceGroup ?? null },
    'admin prices action',
  );
  const title = `${input.brand} ${input.articleNorm}`;
  const total = input.competitorPriceKop + input.competitorDeliveryKop;
  const theirs = `${COMPETITOR_LABELS[input.competitor]} ${formatRub(total)}${
    input.competitorDeliveryKop > 0 ? ' с доставкой' : ''
  }`;
  let message: string;
  if (lookup.found !== null) {
    message = `Записано: ${title} — у нас ${formatRub(lookup.found.ourPriceKop)}, ${theirs}`;
  } else if (lookup.reason === 'supplier') {
    message = `Записано без нашей цены: поставщик не ответил. ${theirs}`;
  } else {
    message = `Записано без нашей цены: у поставщика нет ${title}. ${theirs}`;
  }
  return seeOther(adminPricesHref(back, message));
}
