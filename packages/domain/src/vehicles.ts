/**
 * Step 6 (docs/garage.md, roadmap r09 part 2): «Моя машина» — the client's cars. Pure helpers:
 * the input of the optional checkout block (make, model, engine, year, VIN, mileage) checked and
 * normalised, the make matched against the storefront's makes, the free «Марка и модель» of a VIN
 * request read into the same fields, the merge rules that keep one row per car, the mileage rule
 * and the words a page or a bot shows.
 *
 * Founder decisions (fixed): no accounts — a car belongs to the client's phone (users); the whole
 * feature is behind GARAGE_ENABLED (personal data the policy does not name yet); the car is never
 * required for an order; a bot message carries at most the last 4 characters of a VIN.
 *
 * Merge rules (one row per car of a client):
 * - the same VIN is the same car;
 * - otherwise the same make and model with the same year (both unknown counts as the same) is the
 *   same car; when only one side knows the year, the one such car is (two or more: a new car);
 * - a car with another VIN is never the same car, whatever its make and model;
 * - an update fills what the stored car lacks (engine, year, VIN) and takes the client's engine
 *   and year when given; the make and the model stay as stored (their keys are equal anyway);
 * - the mileage only grows: a smaller reading is kept only as an explicit correction.
 */
import { slugify } from './kits';
import type { IsoDate } from './types';
import { normalizeVin } from './vin';
import type { VehicleSource } from './statuses';

/** Longest make as typed («Mercedes-Benz», «Land Rover»). */
export const VEHICLE_MAKE_MAX = 40;
/** Longest model («Niva Travel», «Granta Cross»). */
export const VEHICLE_MODEL_MAX = 60;
/** Longest engine («1.6 16V»). */
export const VEHICLE_ENGINE_MAX = 40;
/** The oldest year a car may be of. */
export const VEHICLE_YEAR_MIN = 1950;
/** The largest mileage a reading may say, km. */
export const VEHICLE_MILEAGE_MAX = 2_000_000;

/** A make of the storefront (CAR_BRANDS of the web): its slug, name and other spellings. */
export interface CarMake {
  slug: string;
  name: string;
  /** Other spellings a client types: «лада», «ваз», «хендай». */
  aliases?: readonly string[];
}

/** The fields of one car, checked and normalised. */
export interface VehicleData {
  /** The storefront make (CarMake.slug) when the make is one of them. */
  makeSlug: string | null;
  /** As shown: the storefront name of a known make («Lada»), else as typed. */
  make: string;
  model: string;
  engine: string | null;
  year: number | null;
  /** Normalised (isValidVin). */
  vin: string | null;
  mileageKm: number | null;
}

/** A car as stored (user_vehicles). */
export interface StoredVehicle extends Omit<VehicleData, 'mileageKm'> {
  id: string;
  mileageKm: number | null;
  /** The day of the mileage reading. */
  mileageAt: IsoDate | null;
  source: VehicleSource;
  updatedAt: Date;
}

export type VehicleField = 'make' | 'model' | 'engine' | 'year' | 'vin' | 'mileage';

export type VehicleInputResult =
  /** Every field blank: nothing is stored. */
  | { kind: 'empty' }
  | { kind: 'ok'; vehicle: VehicleData }
  | { kind: 'invalid'; errors: Partial<Record<VehicleField, string>> };

export const VEHICLE_MESSAGES = {
  makeMissing: 'Укажите марку — или очистите поля машины',
  makeLong: `Марка — не длиннее ${VEHICLE_MAKE_MAX} символов`,
  modelMissing: 'Укажите модель — или очистите поля машины',
  modelLong: `Модель — не длиннее ${VEHICLE_MODEL_MAX} символов`,
  engineLong: `Двигатель — не длиннее ${VEHICLE_ENGINE_MAX} символов`,
  vin: 'Проверьте VIN: 17 символов — латинские буквы и цифры',
  vinOiq: 'В VIN не бывает букв O, I и Q — скорее всего, это цифры 0 и 1',
  mileage: 'Пробег — целое число километров, например 85 000',
} as const;

/** «Год выпуска — четыре цифры, от 1950 до 2027». */
export function vehicleYearMessage(yearMax: number): string {
  return `Год выпуска — четыре цифры, от ${VEHICLE_YEAR_MIN} до ${yearMax}`;
}

/** The latest year a car may be of on `today`: next year's models are on sale from the autumn. */
export function vehicleYearMax(today: IsoDate): number {
  return Number(today.slice(0, 4)) + 1;
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

/** A field as typed: control characters dropped, whitespace collapsed, trimmed. */
export function cleanVehicleText(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value !== 'string') return '';
  return (
    value
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .replace(/\s+/gu, ' ')
      .trim()
  );
}

/** Comparison key of a make or a model: transliterated, lower case, letters and digits only. */
export function vehicleKey(text: string): string {
  return slugify(text.replace(/ё/giu, 'е'), 200).replace(/-/g, '');
}

/** The storefront make a text names (slug, name or an alias), or null. */
export function matchCarMake(text: string, makes: readonly CarMake[]): CarMake | null {
  const key = vehicleKey(text);
  if (key === '') return null;
  for (const make of makes) {
    if (vehicleKey(make.slug) === key || vehicleKey(make.name) === key) return make;
    if ((make.aliases ?? []).some((alias) => vehicleKey(alias) === key)) return make;
  }
  return null;
}

/**
 * A mileage as people write it: '85000', '85 000', '85 000 км', '85000km'. null for anything
 * else (letters, a fraction, a negative number, more than VEHICLE_MILEAGE_MAX).
 */
export function parseMileage(value: unknown): number | null {
  const text = cleanVehicleText(value)
    .replace(/[\s\u00a0\u202f]+/gu, '')
    .replace(/(км|km)\.?$/iu, '');
  if (!/^\d{1,7}$/.test(text)) return null;
  const km = Number(text);
  return km <= VEHICLE_MILEAGE_MAX ? km : null;
}

/** '85 000 км' (no-break spaces, as prices). */
export function formatMileage(km: number): string {
  return `${String(km).replace(/\B(?=(\d{3})+(?!\d))/g, '\u00a0')}\u00a0км`;
}

/**
 * The fields of the checkout block: blank everywhere → empty; otherwise the make and the model
 * are required and every given field must be valid. A known make takes the storefront's name.
 */
export function parseVehicleInput(
  raw: unknown,
  ctx: { makes: readonly CarMake[]; today: IsoDate },
): VehicleInputResult {
  const source = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const text = {
    make: cleanVehicleText(source.make),
    model: cleanVehicleText(source.model),
    engine: cleanVehicleText(source.engine),
    year: cleanVehicleText(source.year),
    vin: cleanVehicleText(source.vin),
    mileage: cleanVehicleText(source.mileage),
  };
  if (Object.values(text).every((value) => value === '')) return { kind: 'empty' };

  const errors: Partial<Record<VehicleField, string>> = {};
  if (text.make === '' || !/[\p{L}\p{N}]/u.test(text.make)) {
    errors.make = VEHICLE_MESSAGES.makeMissing;
  } else if (text.make.length > VEHICLE_MAKE_MAX) {
    errors.make = VEHICLE_MESSAGES.makeLong;
  }
  if (text.model === '' || !/[\p{L}\p{N}]/u.test(text.model)) {
    errors.model = VEHICLE_MESSAGES.modelMissing;
  } else if (text.model.length > VEHICLE_MODEL_MAX) {
    errors.model = VEHICLE_MESSAGES.modelLong;
  }
  if (text.engine.length > VEHICLE_ENGINE_MAX) errors.engine = VEHICLE_MESSAGES.engineLong;

  const yearMax = vehicleYearMax(ctx.today);
  let year: number | null = null;
  if (text.year !== '') {
    year = /^\d{4}$/.test(text.year) ? Number(text.year) : Number.NaN;
    if (!(year >= VEHICLE_YEAR_MIN && year <= yearMax)) errors.year = vehicleYearMessage(yearMax);
  }

  let vin: string | null = null;
  if (text.vin !== '') {
    vin = normalizeVin(text.vin);
    if (vin === null) {
      errors.vin = /[OIQ]/iu.test(text.vin) ? VEHICLE_MESSAGES.vinOiq : VEHICLE_MESSAGES.vin;
    }
  }

  let mileageKm: number | null = null;
  if (text.mileage !== '') {
    mileageKm = parseMileage(text.mileage);
    if (mileageKm === null) errors.mileage = VEHICLE_MESSAGES.mileage;
  }

  if (Object.keys(errors).length > 0) return { kind: 'invalid', errors };
  const known = matchCarMake(text.make, ctx.makes);
  return {
    kind: 'ok',
    vehicle: {
      makeSlug: known?.slug ?? null,
      make: known?.name ?? text.make,
      model: text.model,
      engine: text.engine === '' ? null : text.engine,
      year,
      vin,
      mileageKm,
    },
  };
}

// ---------------------------------------------------------------------------
// «Марка и модель» of a VIN request
// ---------------------------------------------------------------------------

const YEAR_TOKEN_RE = /^((?:19|20)\d{2})(?:г\.?|года?)?$/iu;
const ENGINE_TOKEN_RE = /^(\d)[.,](\d{1,2})(?:л\.?|l)?$/iu;

/**
 * The free text a client typed at /vin («Lada Vesta 1.6 2019», «Хендай Солярис 2015г») read
 * into the car fields for the checkout prefill: a known make among the first words, a year, an
 * engine volume, the rest is the model. null when no known make or no model is found: a prefill
 * the client never typed must not make the order fail.
 */
export function parseCarText(
  text: string | null | undefined,
  makes: readonly CarMake[],
  today: IsoDate,
): Omit<VehicleData, 'vin' | 'mileageKm'> | null {
  const words = cleanVehicleText(text)
    .split(' ')
    .map((word) => word.replace(/^[,;:()]+|[,;:()]+$/gu, ''))
    .filter((word) => word !== '');
  let make: CarMake | null = null;
  let start = -1;
  let length = 0;
  // The make is one of the first words, possibly two or three («Land Rover»).
  outer: for (let index = 0; index < Math.min(words.length, 3); index += 1) {
    for (let size = Math.min(3, words.length - index); size >= 1; size -= 1) {
      const found = matchCarMake(words.slice(index, index + size).join(' '), makes);
      if (found !== null) {
        make = found;
        start = index;
        length = size;
        break outer;
      }
    }
  }
  if (make === null) return null;
  const yearMax = vehicleYearMax(today);
  let year: number | null = null;
  let engine: string | null = null;
  const model: string[] = [];
  words.forEach((word, index) => {
    if (index >= start && index < start + length) return;
    const yearMatch = YEAR_TOKEN_RE.exec(word);
    if (yearMatch && year === null) {
      const value = Number(yearMatch[1]);
      if (value >= VEHICLE_YEAR_MIN && value <= yearMax) {
        year = value;
        return;
      }
    }
    const engineMatch = ENGINE_TOKEN_RE.exec(word);
    if (engineMatch && engine === null) {
      engine = `${engineMatch[1]}.${engineMatch[2]}`;
      return;
    }
    if (index > start) model.push(word);
  });
  const modelText = model.join(' ').slice(0, VEHICLE_MODEL_MAX).trim();
  if (modelText === '' || !/[\p{L}\p{N}]/u.test(modelText)) return null;
  return { makeSlug: make.slug, make: make.name, model: modelText, engine, year };
}

// ---------------------------------------------------------------------------
// Merge rules
// ---------------------------------------------------------------------------

type Identity = Pick<VehicleData, 'makeSlug' | 'make' | 'model'>;

/**
 * The same make (the storefront slug when both have one, else the transliterated text) and the
 * same model (transliterated: «Веста» is «Vesta»).
 */
export function sameMakeModel(a: Identity, b: Identity): boolean {
  if (a.makeSlug !== null && b.makeSlug !== null) {
    if (a.makeSlug !== b.makeSlug) return false;
  } else if (vehicleKey(a.make) !== vehicleKey(b.make)) {
    return false;
  }
  return vehicleKey(a.model) === vehicleKey(b.model);
}

function newestFirst(a: StoredVehicle, b: StoredVehicle): number {
  return b.updatedAt.getTime() - a.updatedAt.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
}

/**
 * The stored car of the client that `input` is (see the module comment), or null for a new car.
 */
export function findVehicleMatch(
  cars: readonly StoredVehicle[],
  input: Pick<VehicleData, 'makeSlug' | 'make' | 'model' | 'year' | 'vin'>,
): StoredVehicle | null {
  if (input.vin !== null) {
    const byVin = cars.find((car) => car.vin === input.vin);
    if (byVin) return byVin;
  }
  const candidates = cars.filter(
    (car) =>
      sameMakeModel(car, input) &&
      (car.vin === null || input.vin === null || car.vin === input.vin),
  );
  const exact = candidates.filter((car) => car.year === input.year).sort(newestFirst);
  if (exact.length > 0) return exact[0] as StoredVehicle;
  const loose = candidates.filter((car) => car.year === null || input.year === null);
  return loose.length === 1 ? (loose[0] as StoredVehicle) : null;
}

export interface MileageMerge {
  km: number | null;
  /** The stored mileage changes. */
  changed: boolean;
  /** The reading was smaller than the stored mileage and not a correction: kept as stored. */
  lower: boolean;
}

/** The mileage only grows; a smaller reading wins only as an explicit correction. */
export function mergeMileage(
  stored: number | null,
  reading: number | null,
  options: { correction?: boolean } = {},
): MileageMerge {
  if (reading === null) return { km: stored, changed: false, lower: false };
  if (stored === null || reading > stored) return { km: reading, changed: true, lower: false };
  if (reading === stored) return { km: stored, changed: false, lower: false };
  if (options.correction === true) return { km: reading, changed: true, lower: false };
  return { km: stored, changed: false, lower: true };
}

/** The columns written for a car (user_vehicles without ids and times). */
export interface VehicleWrite {
  makeSlug: string | null;
  make: string;
  model: string;
  engine: string | null;
  year: number | null;
  vin: string | null;
  mileageKm: number | null;
  mileageAt: IsoDate | null;
  source: VehicleSource;
}

export interface VehicleMergeResult {
  write: VehicleWrite;
  /** Something differs from the stored car (always true for a new one). */
  changed: boolean;
  mileage: MileageMerge;
}

/**
 * What to store for `input` on top of `existing` (null: a new car). `source` is where this data
 * came from and is written only when something changes; `today` dates a new mileage reading.
 */
export function mergeVehicle(
  existing: StoredVehicle | null,
  input: VehicleData,
  ctx: { source: VehicleSource; today: IsoDate; correction?: boolean },
): VehicleMergeResult {
  if (existing === null) {
    const mileage = mergeMileage(null, input.mileageKm);
    return {
      write: {
        makeSlug: input.makeSlug,
        make: input.make,
        model: input.model,
        engine: input.engine,
        year: input.year,
        vin: input.vin,
        mileageKm: mileage.km,
        mileageAt: mileage.km === null ? null : ctx.today,
        source: ctx.source,
      },
      changed: true,
      mileage,
    };
  }
  const mileage = mergeMileage(existing.mileageKm, input.mileageKm, {
    correction: ctx.correction,
  });
  const next = {
    makeSlug: existing.makeSlug ?? input.makeSlug,
    make: existing.makeSlug === null && input.makeSlug !== null ? input.make : existing.make,
    model: existing.model,
    engine: input.engine ?? existing.engine,
    year: input.year ?? existing.year,
    vin: existing.vin ?? input.vin,
    mileageKm: mileage.km,
    mileageAt: mileage.changed ? ctx.today : existing.mileageAt,
  };
  const changed =
    next.makeSlug !== existing.makeSlug ||
    next.make !== existing.make ||
    next.engine !== existing.engine ||
    next.year !== existing.year ||
    next.vin !== existing.vin ||
    mileage.changed;
  return {
    write: { ...next, source: changed ? ctx.source : existing.source },
    changed,
    mileage,
  };
}

/**
 * Where the car of a checkout came from: the prefill's source when the client kept its make and
 * model (`kit`, `proposal`, `bot`), `checkout` when the client typed it.
 */
export function vehicleSourceOf(
  input: Identity,
  prefill: (Identity & { source: VehicleSource }) | null,
): VehicleSource {
  return prefill !== null && sameMakeModel(input, prefill) ? prefill.source : 'checkout';
}

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

/** Where the latest data of a car came from, in the admin's words. */
export const VEHICLE_SOURCE_LABELS: Readonly<Record<VehicleSource, string>> = {
  checkout: 'указал при оформлении',
  proposal: 'из заявки по VIN',
  kit: 'из набора для ТО',
  handover: 'пробег при выдаче',
  bot: '«Купить снова» в боте',
};

/** «Lada Vesta» (the make is not repeated when the model starts with it). */
export function vehicleShortLabel(vehicle: Pick<VehicleData, 'make' | 'model'>): string {
  const model = vehicle.model.trim();
  const make = vehicle.make.trim();
  return vehicleKey(model).startsWith(vehicleKey(make)) && vehicleKey(make) !== ''
    ? model
    : `${make} ${model}`.trim();
}

/** «Lada Vesta 1.6, 2019», «Lada Vesta, 2019», «Lada Vesta 1.6». */
export function vehicleLabel(
  vehicle: Pick<VehicleData, 'make' | 'model' | 'engine' | 'year'>,
): string {
  const name = [vehicleShortLabel(vehicle), vehicle.engine?.trim() || null]
    .filter((part): part is string => part !== null && part !== '')
    .join(' ');
  return vehicle.year !== null ? `${name}, ${vehicle.year}` : name;
}
