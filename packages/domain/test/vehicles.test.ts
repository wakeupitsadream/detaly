// Step 6 (docs/garage.md): «Моя машина» — the pure helpers: the checkout block's input, the make
// of the storefront, the «Марка и модель» of a VIN request, the merge rules (one row per car),
// the mileage rule and the words. VINs here are synthetic (valid by ISO 3779 shape only).
import { describe, expect, it } from 'vitest';
import {
  cleanVehicleText,
  findVehicleMatch,
  formatMileage,
  isValidVin,
  matchCarMake,
  mergeMileage,
  mergeVehicle,
  normalizeVin,
  parseCarText,
  parseMileage,
  parseVehicleInput,
  sameMakeModel,
  VEHICLE_MESSAGES,
  VEHICLE_SOURCES,
  vehicleLabel,
  vehicleShortLabel,
  vehicleSourceOf,
  vehicleYearMax,
  vinTail,
  type CarMake,
  type StoredVehicle,
  type VehicleData,
} from '../src';

const MAKES: CarMake[] = [
  { slug: 'lada', name: 'Lada', aliases: ['лада', 'ваз', 'vaz'] },
  { slug: 'hyundai', name: 'Hyundai', aliases: ['хендай', 'хёндай', 'хундай'] },
  { slug: 'kia', name: 'Kia', aliases: ['киа'] },
  { slug: 'land-rover', name: 'Land Rover', aliases: ['ленд ровер'] },
  { slug: 'skoda', name: 'Škoda', aliases: ['шкода'] },
];
const TODAY = '2026-10-09';
const VIN_A = 'XTA21099043456789';
const VIN_B = 'Z94CB41BAER123456';

function parse(raw: Record<string, unknown>) {
  return parseVehicleInput(raw, { makes: MAKES, today: TODAY });
}

function data(over: Partial<VehicleData> = {}): VehicleData {
  return {
    makeSlug: 'lada',
    make: 'Lada',
    model: 'Vesta',
    engine: null,
    year: null,
    vin: null,
    mileageKm: null,
    ...over,
  };
}

let seq = 0;
function stored(over: Partial<StoredVehicle> = {}): StoredVehicle {
  seq += 1;
  return {
    id: `00000000-0000-7000-8000-${String(seq).padStart(12, '0')}`,
    makeSlug: 'lada',
    make: 'Lada',
    model: 'Vesta',
    engine: null,
    year: null,
    vin: null,
    mileageKm: null,
    mileageAt: null,
    source: 'checkout',
    updatedAt: new Date('2026-10-01T00:00:00Z'),
    ...over,
  };
}

describe('VIN (moved to @detaly/domain, re-exported by @detaly/vin)', () => {
  it('normalises and validates as before; the tail shows 4 characters only', () => {
    expect(normalizeVin(' xta 21099-0 4345 6789 ')).toBe(VIN_A);
    expect(normalizeVin('ХТА21099043456789')).toBe(VIN_A);
    expect(normalizeVin('XTA2109904345678O')).toBeNull();
    expect(isValidVin(VIN_B)).toBe(true);
    expect(vinTail(VIN_A)).toBe('…6789');
    expect(vinTail('short')).toBe('');
    expect(vinTail(null)).toBe('');
  });
});

describe('the make of the storefront', () => {
  it('matches the slug, the name and the aliases whatever the case and the script', () => {
    expect(matchCarMake('LADA', MAKES)?.slug).toBe('lada');
    expect(matchCarMake('Лада', MAKES)?.slug).toBe('lada');
    expect(matchCarMake('ваз', MAKES)?.slug).toBe('lada');
    expect(matchCarMake('Хёндай', MAKES)?.slug).toBe('hyundai');
    expect(matchCarMake('land-rover', MAKES)?.slug).toBe('land-rover');
    expect(matchCarMake('Skoda', MAKES)?.slug).toBe('skoda');
    expect(matchCarMake('Tesla', MAKES)).toBeNull();
    expect(matchCarMake('   ', MAKES)).toBeNull();
  });
});

describe('the checkout block', () => {
  it('blank everywhere is nothing to store', () => {
    expect(parse({})).toEqual({ kind: 'empty' });
    expect(parse({ make: '  ', model: '', vin: ' ', mileage: '' })).toEqual({ kind: 'empty' });
    expect(parseVehicleInput(null, { makes: MAKES, today: TODAY })).toEqual({ kind: 'empty' });
    expect(parseVehicleInput('Lada', { makes: MAKES, today: TODAY })).toEqual({ kind: 'empty' });
  });

  it('normalises a full car: the storefront name of the make, the VIN, the mileage', () => {
    expect(
      parse({
        make: ' лада ',
        model: 'Vesta  SW',
        engine: '1.6',
        year: '2019',
        vin: 'xta 2109904345 6789',
        mileage: '85 000 км',
      }),
    ).toEqual({
      kind: 'ok',
      vehicle: {
        makeSlug: 'lada',
        make: 'Lada',
        model: 'Vesta SW',
        engine: '1.6',
        year: 2019,
        vin: VIN_A,
        mileageKm: 85000,
      },
    });
  });

  it('keeps an unknown make as typed', () => {
    const result = parse({ make: 'Tesla', model: 'Model 3' });
    expect(result).toEqual({
      kind: 'ok',
      vehicle: data({ makeSlug: null, make: 'Tesla', model: 'Model 3' }),
    });
  });

  it('needs the make and the model once anything is typed', () => {
    expect(parse({ vin: VIN_A })).toEqual({
      kind: 'invalid',
      errors: { make: VEHICLE_MESSAGES.makeMissing, model: VEHICLE_MESSAGES.modelMissing },
    });
    expect(parse({ make: 'Lada', mileage: '1000' })).toEqual({
      kind: 'invalid',
      errors: { model: VEHICLE_MESSAGES.modelMissing },
    });
  });

  it('says which field is wrong', () => {
    const result = parse({
      make: 'L'.repeat(41),
      model: 'M'.repeat(61),
      engine: 'E'.repeat(41),
      year: '19',
      vin: 'XTA2109904345678O',
      mileage: '85,5',
    });
    expect(result.kind).toBe('invalid');
    if (result.kind !== 'invalid') return;
    expect(result.errors).toEqual({
      make: VEHICLE_MESSAGES.makeLong,
      model: VEHICLE_MESSAGES.modelLong,
      engine: VEHICLE_MESSAGES.engineLong,
      year: 'Год выпуска — четыре цифры, от 1950 до 2027',
      vin: VEHICLE_MESSAGES.vinOiq,
      mileage: VEHICLE_MESSAGES.mileage,
    });
    expect(parse({ make: 'Lada', model: 'Vesta', vin: '123' })).toEqual({
      kind: 'invalid',
      errors: { vin: VEHICLE_MESSAGES.vin },
    });
  });

  it('years from 1950 to next year', () => {
    expect(vehicleYearMax(TODAY)).toBe(2027);
    expect(parse({ make: 'Lada', model: 'Niva', year: '1950' }).kind).toBe('ok');
    expect(parse({ make: 'Lada', model: 'Niva', year: '2027' }).kind).toBe('ok');
    expect(parse({ make: 'Lada', model: 'Niva', year: '1949' }).kind).toBe('invalid');
    expect(parse({ make: 'Lada', model: 'Niva', year: '2028' }).kind).toBe('invalid');
    expect(parse({ make: 'Lada', model: 'Niva', year: 2019 })).toMatchObject({
      vehicle: { year: 2019 },
    });
  });

  it('cleans control characters and objects', () => {
    expect(cleanVehicleText('Ve\u0000sta\n')).toBe('Ve sta');
    expect(cleanVehicleText({ toString: () => 'x' })).toBe('');
    expect(parse({ make: { evil: true }, model: ['x'] })).toEqual({ kind: 'empty' });
  });
});

describe('mileage as people write it', () => {
  it.each([
    ['85000', 85000],
    ['85 000', 85000],
    ['85\u00a0000 км', 85000],
    ['120000km', 120000],
    ['0', 0],
    ['2000000', 2000000],
  ])('%s -> %d', (text, km) => {
    expect(parseMileage(text)).toBe(km);
  });

  it.each(['', '-5', '85,5', '85.000', 'много', '2000001', '1e5'])('%s -> null', (text) => {
    expect(parseMileage(text)).toBeNull();
  });

  it('formats with no-break spaces', () => {
    expect(formatMileage(85000)).toBe('85\u00a0000\u00a0км');
    expect(formatMileage(900)).toBe('900\u00a0км');
  });
});

describe('«Марка и модель» of a VIN request', () => {
  it('reads the make, the model, the engine volume and the year', () => {
    expect(parseCarText('Lada Vesta 1.6 2019', MAKES, TODAY)).toEqual({
      makeSlug: 'lada',
      make: 'Lada',
      model: 'Vesta',
      engine: '1.6',
      year: 2019,
    });
    expect(parseCarText('Хендай Солярис 2015г', MAKES, TODAY)).toEqual({
      makeSlug: 'hyundai',
      make: 'Hyundai',
      model: 'Солярис',
      engine: null,
      year: 2015,
    });
    expect(parseCarText('ВАЗ 2109', MAKES, TODAY)).toMatchObject({ make: 'Lada', model: '2109' });
    expect(parseCarText('мой Land Rover Discovery 3,0л', MAKES, TODAY)).toMatchObject({
      makeSlug: 'land-rover',
      model: 'Discovery',
      engine: '3.0',
    });
    expect(parseCarText('2017 Kia Rio, АКПП', MAKES, TODAY)).toMatchObject({
      make: 'Kia',
      model: 'Rio АКПП',
      year: 2017,
    });
  });

  it('nothing it cannot read: no known make, no model, no text', () => {
    expect(parseCarText('Tesla Model 3', MAKES, TODAY)).toBeNull();
    expect(parseCarText('Lada 2019', MAKES, TODAY)).toBeNull();
    expect(parseCarText('', MAKES, TODAY)).toBeNull();
    expect(parseCarText(null, MAKES, TODAY)).toBeNull();
  });
});

describe('merge rules: one row per car', () => {
  it('the same VIN is the same car, whatever the model says', () => {
    const car = stored({ vin: VIN_A, model: 'Granta' });
    const other = stored({ model: 'Vesta' });
    expect(findVehicleMatch([other, car], data({ vin: VIN_A }))).toBe(car);
  });

  it('the same make, model and year is the same car (transliterated, case-blind)', () => {
    const car = stored({ year: 2019 });
    expect(findVehicleMatch([car], data({ model: 'веста', year: 2019 }))).toBe(car);
    expect(findVehicleMatch([car], data({ make: 'Лада', makeSlug: null, year: 2019 }))).toBe(car);
    expect(findVehicleMatch([car], data({ year: 2018 }))).toBeNull();
    expect(findVehicleMatch([car], data({ model: 'Granta', year: 2019 }))).toBeNull();
    expect(findVehicleMatch([car], data({ makeSlug: 'kia', make: 'Kia', year: 2019 }))).toBeNull();
  });

  it('an unknown year on one side matches the one such car; two of them make a new car', () => {
    const noYear = stored();
    expect(findVehicleMatch([noYear], data({ year: 2019 }))).toBe(noYear);
    const y2015 = stored({ year: 2015 });
    expect(findVehicleMatch([y2015], data())).toBe(y2015);
    const y2019 = stored({ year: 2019 });
    expect(findVehicleMatch([y2015, y2019], data())).toBeNull();
    // An exact year wins over a loose one.
    expect(findVehicleMatch([noYear, y2019], data({ year: 2019 }))).toBe(y2019);
  });

  it('a car with another VIN is never the same car', () => {
    const car = stored({ vin: VIN_B, year: 2019 });
    expect(findVehicleMatch([car], data({ vin: VIN_A, year: 2019 }))).toBeNull();
    // Without a VIN on the input the stored VIN does not get in the way.
    expect(findVehicleMatch([car], data({ year: 2019 }))).toBe(car);
  });

  it('a new car takes the input and dates its mileage', () => {
    const result = mergeVehicle(null, data({ vin: VIN_A, mileageKm: 1000, year: 2019 }), {
      source: 'checkout',
      today: TODAY,
    });
    expect(result).toEqual({
      changed: true,
      mileage: { km: 1000, changed: true, lower: false },
      write: {
        makeSlug: 'lada',
        make: 'Lada',
        model: 'Vesta',
        engine: null,
        year: 2019,
        vin: VIN_A,
        mileageKm: 1000,
        mileageAt: TODAY,
        source: 'checkout',
      },
    });
    expect(mergeVehicle(null, data(), { source: 'kit', today: TODAY }).write).toMatchObject({
      mileageKm: null,
      mileageAt: null,
      source: 'kit',
    });
  });

  it('an update fills what is missing, keeps the make and model, writes the source of the change', () => {
    const car = stored({ model: 'Vesta', engine: '1.6', source: 'kit' });
    const result = mergeVehicle(car, data({ model: 'веста', vin: VIN_A, year: 2019 }), {
      source: 'checkout',
      today: TODAY,
    });
    expect(result.changed).toBe(true);
    expect(result.write).toMatchObject({
      model: 'Vesta',
      engine: '1.6',
      year: 2019,
      vin: VIN_A,
      source: 'checkout',
    });
  });

  it('an unknown make becomes the storefront make once the client names it', () => {
    const car = stored({ makeSlug: null, make: 'лада' });
    expect(mergeVehicle(car, data(), { source: 'checkout', today: TODAY }).write).toMatchObject({
      makeSlug: 'lada',
      make: 'Lada',
    });
  });

  it('the same data again changes nothing (idempotent) and keeps the old source', () => {
    const car = stored({ year: 2019, vin: VIN_A, mileageKm: 5000, mileageAt: '2026-09-01' });
    const result = mergeVehicle(car, data({ year: 2019, vin: VIN_A, mileageKm: 5000 }), {
      source: 'handover',
      today: TODAY,
    });
    expect(result.changed).toBe(false);
    expect(result.write.source).toBe('checkout');
    expect(result.write.mileageAt).toBe('2026-09-01');
  });

  it('the mileage only grows; a smaller one is kept only as a correction', () => {
    expect(mergeMileage(null, 100)).toEqual({ km: 100, changed: true, lower: false });
    expect(mergeMileage(100, 150)).toEqual({ km: 150, changed: true, lower: false });
    expect(mergeMileage(150, 150)).toEqual({ km: 150, changed: false, lower: false });
    expect(mergeMileage(150, 100)).toEqual({ km: 150, changed: false, lower: true });
    expect(mergeMileage(150, 100, { correction: true })).toEqual({
      km: 100,
      changed: true,
      lower: false,
    });
    expect(mergeMileage(150, null)).toEqual({ km: 150, changed: false, lower: false });

    const car = stored({ mileageKm: 90000, mileageAt: '2026-09-01' });
    const lower = mergeVehicle(car, data({ mileageKm: 80000 }), {
      source: 'handover',
      today: TODAY,
    });
    expect(lower).toMatchObject({ changed: false, mileage: { lower: true } });
    expect(lower.write).toMatchObject({ mileageKm: 90000, mileageAt: '2026-09-01' });
    const corrected = mergeVehicle(car, data({ mileageKm: 80000 }), {
      source: 'handover',
      today: TODAY,
      correction: true,
    });
    expect(corrected.write).toMatchObject({
      mileageKm: 80000,
      mileageAt: TODAY,
      source: 'handover',
    });
  });

  it('the source of a checkout: the prefill when its make and model were kept', () => {
    const prefill = { makeSlug: 'lada', make: 'Lada', model: 'Vesta', source: 'kit' as const };
    expect(vehicleSourceOf(data({ model: 'VESTA' }), prefill)).toBe('kit');
    expect(vehicleSourceOf(data({ model: 'Granta' }), prefill)).toBe('checkout');
    expect(vehicleSourceOf(data(), null)).toBe('checkout');
    expect(sameMakeModel(data(), data({ makeSlug: null, make: 'LADA' }))).toBe(true);
  });

  it('every source is a known one', () => {
    expect([...VEHICLE_SOURCES]).toEqual(['checkout', 'proposal', 'kit', 'handover', 'bot']);
  });
});

describe('words', () => {
  it('«Lada Vesta 1.6, 2019» and its shorter forms', () => {
    expect(vehicleLabel({ make: 'Lada', model: 'Vesta', engine: '1.6', year: 2019 })).toBe(
      'Lada Vesta 1.6, 2019',
    );
    expect(vehicleLabel({ make: 'Lada', model: 'Vesta', engine: null, year: 2019 })).toBe(
      'Lada Vesta, 2019',
    );
    expect(vehicleLabel({ make: 'Lada', model: 'Vesta', engine: '1.6', year: null })).toBe(
      'Lada Vesta 1.6',
    );
    expect(vehicleShortLabel({ make: 'Lada', model: 'Lada Vesta' })).toBe('Lada Vesta');
    expect(vehicleShortLabel({ make: 'Kia', model: 'Rio' })).toBe('Kia Rio');
  });
});
