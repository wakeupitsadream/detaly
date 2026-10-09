/**
 * Addresses of the maintenance kit pages (step 5, docs/kits.md): /to lists the makes with
 * published kits, /to/<make> their models, /to/<make>/<model> every kit of the model as a section
 * with the kit slug as its anchor. Plain functions: pages, components, the sitemap and the home
 * tiles share them.
 */
export const KITS_PATH = '/to';

export function kitMakePath(makeSlug: string): string {
  return `${KITS_PATH}/${makeSlug}`;
}

export function kitModelPath(makeSlug: string, modelSlug: string): string {
  return `${KITS_PATH}/${makeSlug}/${modelSlug}`;
}

/** One kit: its section on the model page. */
export function kitPath(kit: { makeSlug: string; modelSlug: string; slug: string }): string {
  return `${kitModelPath(kit.makeSlug, kit.modelSlug)}#${kit.slug}`;
}

/** POST target of «Весь набор в корзину». */
export const KIT_CART_PATH = '/api/cart/kits';

/** What the VIN prompts of the kit pages ask the master for. */
export const KIT_VIN_NEED = 'Запчасти для ТО';
