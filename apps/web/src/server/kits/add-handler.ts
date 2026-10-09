/**
 * POST /api/cart/kits — «Весь набор в корзину» on /to/<make>/<model> (step 5, docs/kits.md).
 *
 * The form posts only the kit id, the version of the kit the page showed and the choice of every
 * main line that has alternatives (`pick_<main line id>` = the line taken); never a price, an
 * offer or a quantity. The handler prices the published kit again by the VIN preview rule (the
 * supplier search through the shared cache, priceOffer) and adds every chosen line through the
 * existing cart service (addItem: the offer found again by its id, the stop list, stock and
 * multiplicity, the cart limits, priceOffer). A line the supplier does not offer now is skipped
 * and counted; the cart then says how many.
 *
 * Order: Origin (403) -> urlencoded body (400) within 8 KB (413) -> the published kit (404) -> the
 * version and the choices still match the kit (303 back with `?kit=changed`) -> pricing ->
 * addItem line by line -> 303 /cart?kit=<added>&kit_skipped=<n> (with `&error=<code>` when the
 * cart stopped taking lines: full, too many searches, too large a sum). Nothing on offer, or no
 * line could be added: 303 back to the kit with `?kit=empty` / `?kit_error=<code>`.
 *
 * Rate limit: the cart's (src/proxy.ts: writes to /api/cart/**). DEMO_MODE: the same handler
 * over the demo cart (server/demo/cart-http.ts) and the sample kits. Logs: the kit id and
 * counts, never the cart token.
 *
 * Step 6 (docs/garage.md): with GARAGE_ENABLED the cart remembers the kit (`rememberKit`,
 * carts.kit_id) once a line of it went in: the «Моя машина» block of the checkout is filled with
 * the kit's make, model and engine. A failure there never fails the kit (logged, the lines stay).
 */
import type { Env } from '@detaly/config';
import { readBoundedText } from '../body';
import { cartSetCookie, requestCookies } from '../cart/http';
import type { CartService } from '../cart/cart-service';
import { CART_ERROR_MESSAGES, isCartRequestError, type CartErrorCode } from '../cart/errors';
import { readCartToken } from '../cart-store';
import { errorInfo } from '../errors';
import { isSameOrigin } from '../request-guards';
import { messagePage, seeOther } from '../vin/http';
import type { KitRecord } from './catalog';
import { chosenOptions, type KitView } from './kit-view';
import { kitModelPath } from '@/lib/kit-paths';

/** The form: a kit id, a version and up to KIT_MAIN_LINES_MAX choices. */
export const MAX_KIT_FORM_BYTES = 8 * 1024;

/** Cart refusals after which no further line can be added. */
const CART_LEVEL: ReadonlySet<CartErrorCode> = new Set([
  'cart_full',
  'cart_total',
  'too_many_searches',
]);

export interface KitAddLogger {
  info(details: Record<string, unknown>, message: string): void;
  error(details: Record<string, unknown>, message: string): void;
}

export interface KitAddDeps {
  env: Pick<Env, 'APP_BASE_URL' | 'CART_TTL_DAYS'>;
  service: CartService;
  /** A published kit by id (the samples in the demo); null when there is none. */
  loadKit: (id: string) => Promise<KitRecord | null>;
  /** Prices the kit now (kit-view.ts priceKit with the shared supplier). */
  price: (kit: KitRecord) => Promise<KitView>;
  /** Step 6: GARAGE_ENABLED — the cart of `cartToken` was filled from `kitId` (carts.kit_id). */
  rememberKit?: (cartToken: string, kitId: string) => Promise<void>;
  logger?: KitAddLogger;
}

const KIT_ID_RE = /^[0-9a-z-]{1,64}$/;
const PICK_PREFIX = 'pick_';

function forbidden(): Response {
  return new Response(CART_ERROR_MESSAGES.forbidden_origin, {
    status: 403,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

/**
 * Back to the kit on its model page with a note for its section (`?kit=changed&for=<slug>`,
 * `?kit_error=qty&for=<slug>`, …).
 */
function backToKit(kit: KitRecord, query: string): Response {
  const path = kitModelPath(kit.makeSlug, kit.modelSlug);
  return seeOther(`${path}?${query}&for=${encodeURIComponent(kit.slug)}#${kit.slug}`);
}

export async function handleKitAdd(request: Request, deps: KitAddDeps): Promise<Response> {
  if (!isSameOrigin(request.headers, deps.env.APP_BASE_URL)) return forbidden();
  const back = { href: '/to', label: 'К наборам для ТО' };
  const type = (request.headers.get('content-type') ?? '').toLowerCase();
  if (!type.startsWith('application/x-www-form-urlencoded')) {
    return messagePage(400, 'Набор не добавлен', 'Не удалось прочитать форму', back);
  }
  try {
    const body = await readBoundedText(request, MAX_KIT_FORM_BYTES);
    if (!body.ok) return messagePage(413, 'Набор не добавлен', 'Форма слишком большая', back);
    const form = new URLSearchParams(body.text);
    const kitId = (form.get('kit') ?? '').trim();
    const kit = KIT_ID_RE.test(kitId) ? await deps.loadKit(kitId) : null;
    if (kit === null) {
      return messagePage(
        404,
        'Набор не найден',
        'Этот набор сейчас недоступен — откройте наборы для ТО заново',
        back,
      );
    }
    if ((form.get('version') ?? '') !== kit.version) return backToKit(kit, 'kit=changed');

    const view = await deps.price(kit);
    const groups = new Map(view.groups.map((group) => [group.mainLineId, group]));
    const picks = new Map<string, string>();
    for (const [name, value] of form) {
      if (!name.startsWith(PICK_PREFIX)) continue;
      const group = groups.get(name.slice(PICK_PREFIX.length));
      // A choice the page did not offer: the kit or the supplier changed since it was shown.
      if (!group?.options.some((option) => option.lineId === value && option.offer !== null)) {
        return backToKit(kit, 'kit=changed');
      }
      picks.set(group.mainLineId, value);
    }
    const chosen = chosenOptions(view, picks);
    const items = chosen.flatMap((option) => (option?.offer ? [option] : []));
    let skipped = chosen.length - items.length;
    if (items.length === 0) return backToKit(kit, 'kit=empty');

    let token = readCartToken(requestCookies(request));
    let added = 0;
    let stop: CartErrorCode | null = null;
    let firstLineError: CartErrorCode | null = null;
    for (const option of items) {
      try {
        const result = await deps.service.addItem({
          token,
          q: option.offer!.searchArticleNorm,
          offerId: option.offer!.offerKey,
          qty: option.qty,
        });
        token = result.token;
        added += 1;
      } catch (error) {
        if (!isCartRequestError(error)) throw error;
        if (CART_LEVEL.has(error.code)) {
          stop = error.code;
          break;
        }
        // This line only (its offer, stock or the supplier changed a moment ago): skip it.
        skipped += 1;
        firstLineError ??= error.code;
      }
    }
    deps.logger?.info(
      { kit: kit.id, lines: chosen.length, added, skipped, stop, lineError: firstLineError },
      'kit to cart',
    );
    const cookies = token ? [cartSetCookie(token, deps.env)] : [];
    if (added > 0 && token && deps.rememberKit) {
      try {
        await deps.rememberKit(token, kit.id);
      } catch (error) {
        deps.logger?.error({ ...errorInfo(error), kit: kit.id }, 'kit to cart: kit not remembered');
      }
    }
    if (added === 0) {
      if (stop !== null) return seeOther(`/cart?error=${stop}`, cookies);
      return backToKit(kit, `kit_error=${firstLineError ?? 'internal'}`);
    }
    const query = new URLSearchParams({ kit: String(added), kit_skipped: String(skipped) });
    if (stop !== null) query.set('error', stop);
    return seeOther(`/cart?${query.toString()}`, cookies);
  } catch (error) {
    deps.logger?.error(errorInfo(error), 'kit to cart failed');
    return messagePage(
      500,
      'Набор не добавлен',
      'Не получилось положить набор в корзину — попробуйте ещё раз',
      back,
    );
  }
}
