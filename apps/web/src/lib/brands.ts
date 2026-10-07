/**
 * Car makes for the «Выберите марку» grid (redesign 2, docs/PLAN.md). Logos are trimmed WebP
 * files in public/images/brands, taken from the MIT-licensed filippofilip95/car-logos-dataset
 * (the marks stay the property of their owners; see docs/assets.md). A logo with a wordmark
 * under the emblem is cropped to the emblem: the tile prints the name anyway, and the small
 * wordmark made those tiles look emptier than the rest. Order is the order on the home page:
 * the makes most common in Orenburg first, the first FEATURED_BRANDS_COUNT are shown before
 * «Все марки». Plain data, so server components and tests import it without React.
 */
export interface CarBrand {
  /** File name in public/images/brands without the extension. */
  slug: string;
  /** Name as a buyer reads it, also the alt text of the logo. */
  name: string;
  /** Intrinsic logo size in pixels, for next/image without layout shift. */
  width: number;
  height: number;
  /**
   * Optical scale of the logo inside its box (1 when unset). A wide oval or a wordmark plate
   * fills the whole box width and looks twice the size of a compact emblem (Renault, VW, the
   * Mercedes star), so those are drawn smaller to even the tiles out by area, not by width.
   */
  scale?: number;
}

export const CAR_BRANDS: readonly CarBrand[] = [
  { slug: 'lada', name: 'Lada', width: 240, height: 101, scale: 0.85 },
  { slug: 'kia', name: 'Kia', width: 239, height: 120, scale: 0.8 },
  { slug: 'hyundai', name: 'Hyundai', width: 155, height: 79, scale: 0.85 },
  { slug: 'renault', name: 'Renault', width: 96, height: 120 },
  { slug: 'toyota', name: 'Toyota', width: 185, height: 120 },
  { slug: 'volkswagen', name: 'Volkswagen', width: 120, height: 120 },
  { slug: 'skoda', name: 'Škoda', width: 91, height: 90 },
  { slug: 'nissan', name: 'Nissan', width: 143, height: 120 },
  { slug: 'chevrolet', name: 'Chevrolet', width: 240, height: 106, scale: 0.85 },
  { slug: 'ford', name: 'Ford', width: 240, height: 90, scale: 0.8 },
  { slug: 'mitsubishi', name: 'Mitsubishi', width: 93, height: 81 },
  { slug: 'mazda', name: 'Mazda', width: 111, height: 89 },
  { slug: 'haval', name: 'Haval', width: 240, height: 42 },
  { slug: 'chery', name: 'Chery', width: 222, height: 120, scale: 0.85 },
  { slug: 'geely', name: 'Geely', width: 208, height: 120, scale: 0.85 },
  { slug: 'mercedes-benz', name: 'Mercedes-Benz', width: 78, height: 77 },
  { slug: 'bmw', name: 'BMW', width: 120, height: 120 },
  { slug: 'audi', name: 'Audi', width: 240, height: 85, scale: 0.85 },
  { slug: 'opel', name: 'Opel', width: 155, height: 120 },
  { slug: 'peugeot', name: 'Peugeot', width: 83, height: 86 },
  { slug: 'daewoo', name: 'Daewoo', width: 190, height: 120, scale: 0.85 },
  { slug: 'honda', name: 'Honda', width: 184, height: 120 },
  { slug: 'lexus', name: 'Lexus', width: 86, height: 61 },
  { slug: 'uaz', name: 'УАЗ', width: 208, height: 120 },
  { slug: 'exeed', name: 'Exeed', width: 240, height: 21 },
  { slug: 'changan', name: 'Changan', width: 240, height: 65 },
  { slug: 'omoda', name: 'Omoda', width: 195, height: 24 },
  { slug: 'jetour', name: 'Jetour', width: 240, height: 23 },
  { slug: 'citroen', name: 'Citroën', width: 170, height: 120 },
  { slug: 'subaru', name: 'Subaru', width: 203, height: 120 },
  { slug: 'suzuki', name: 'Suzuki', width: 240, height: 107 },
  { slug: 'datsun', name: 'Datsun', width: 223, height: 120 },
  { slug: 'gaz', name: 'ГАЗ', width: 108, height: 120 },
  { slug: 'land-rover', name: 'Land Rover', width: 229, height: 120 },
  { slug: 'volvo', name: 'Volvo', width: 120, height: 120 },
  { slug: 'infiniti', name: 'Infiniti', width: 240, height: 116 },
];

export const FEATURED_BRANDS_COUNT = 24;

export function brandLogoSrc(brand: Pick<CarBrand, 'slug'>): string {
  return `/images/brands/${brand.slug}.webp`;
}
