// "When will the car be ready" on the server (docs/design.md, section 4): the planner over a
// load source, the texts pages show, and the live load from bookings. No database: the live
// source is tested through snapshotFromBookings.
import type { EtaSettings, OfferView } from '@detaly/domain';
import { describe, expect, it, vi } from 'vitest';
import { createInstallPlanner, relativeDay, shortDay, type LoadSource } from '@/server/install';
import { snapshotFromBookings } from '@/server/install/bookings-load-source';
import { INSTALL_JOB_MIN, INSTALL_LIFTS } from '@/server/install/config';
import { createDemoLoadSource } from '@/server/install/demo-load-source';

const TZ = 'Asia/Yekaterinburg';
const HOURS = 'Пн–Пт 10:00–19:00';
const ETA: EtaSettings = { bufferDays: 1, invoiceLagDays: 0, prepayInvoice: false };
const at = (date: string, time: string) => new Date(`${date}T${time}:00+05:00`);

const FREE: LoadSource = {
  kind: 'live',
  snapshot: () => Promise.resolve(() => ({ booked: 0, capacity: INSTALL_LIFTS })),
};

function offer(id: string, etaDate: string): OfferView {
  return {
    id,
    brand: 'MAHLE',
    article: 'OC 90',
    articleNorm: 'OC90',
    name: 'Фильтр масляный',
    isCross: false,
    isLocal: false,
    stockId: 'S1',
    available: 5,
    multiplicity: 1,
    priceClientKop: 50_000,
    priceText: '500 ₽',
    etaDate,
    promiseText: '',
    excluded: false,
    excludedReason: null,
  };
}

function planner(loadSource: LoadSource = FREE, hours: string | null = HOURS) {
  return createInstallPlanner({
    hours,
    loadSource,
    loadEta: () => Promise.resolve(ETA),
    timeZone: TZ,
  });
}

describe('install planner', () => {
  it('plans an offer from its pickup date (supplier date + buffer) with final texts', async () => {
    // Supplier date Wednesday 7 Oct + 1 day buffer = Thursday 8 Oct, the promiseText date.
    const plans = await planner().forOffers([offer('a', '2026-10-07')], at('2026-10-02', '15:00'));
    expect(plans.get('a')).toEqual({
      partText: 'к чт 8 октября',
      slotText: 'чт 8 окт с 12:00',
      carReadyText: 'к 14:00',
      demo: false,
      slotStartIso: '2026-10-08T12:00:00+05:00',
    });
  });

  it('says "сегодня" and "завтра" for near slots', async () => {
    const today = await planner().forDate('2026-10-05', at('2026-10-05', '09:10'));
    expect(today?.slotText).toBe('сегодня с 12:00');
    const tomorrow = await planner().forDate('2026-10-06', at('2026-10-05', '09:10'));
    expect(tomorrow?.slotText).toBe('завтра с 12:00');
    expect(shortDay('2026-05-01')).toBe('пт 1 мая');
    expect(relativeDay('2026-10-09', at('2026-10-05', '09:00'), TZ)).toBe('пт 9 окт');
  });

  it('marks plans from the demo source and keeps them deterministic', async () => {
    const demo = createDemoLoadSource({
      schedule: null,
      capacity: INSTALL_LIFTS,
      timeZone: TZ,
    });
    const a = await planner(demo).forDate('2026-10-08', at('2026-10-02', '15:00'));
    const b = await planner(demo).forDate('2026-10-08', at('2026-10-02', '15:00'));
    expect(a?.demo).toBe(true);
    expect(a).toEqual(b);
  });

  it('gives the home widget the slot day board', async () => {
    const parts = await planner().forPickupDates(['2026-10-08'], at('2026-10-02', '15:00'));
    const part = parts.get('2026-10-08');
    expect(part?.strip.map((h) => h.hour)).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18]);
    expect(part?.strip.filter((h) => h.inSlot).map((h) => h.hour)).toEqual([12, 13]);
  });

  it('a part in stock in Orenburg is at the point after the buffer', async () => {
    expect(await planner().localPickupDate(at('2026-10-02', '15:00'))).toBe('2026-10-03');
  });

  it('no plan without understood hours, an empty answer when the source fails', async () => {
    expect(
      (await planner(FREE, 'по звонку').forOffers([offer('a', '2026-10-07')], new Date())).size,
    ).toBe(0);
    expect(await planner(FREE, null).forDate('2026-10-08', new Date())).toBeNull();

    const onError = vi.fn();
    const broken = createInstallPlanner({
      hours: HOURS,
      loadSource: { kind: 'live', snapshot: () => Promise.reject(new Error('db down')) },
      loadEta: () => Promise.resolve(ETA),
      onError,
    });
    expect((await broken.forOffers([offer('a', '2026-10-07')], new Date())).size).toBe(0);
    expect(await broken.forDate('2026-10-08', new Date())).toBeNull();
    expect(onError).toHaveBeenCalledTimes(2);
  });
});

describe('live load from bookings', () => {
  it('a booking holds one lift for the job time from its slot', () => {
    const slot = at('2026-10-08', '14:00').getTime();
    const load = snapshotFromBookings([slot, slot], INSTALL_LIFTS, INSTALL_JOB_MIN);
    expect(load(at('2026-10-08', '13:00').getTime()).booked).toBe(0);
    expect(load(at('2026-10-08', '14:00').getTime()).booked).toBe(2);
    expect(load(at('2026-10-08', '15:00').getTime()).booked).toBe(2);
    expect(load(at('2026-10-08', '16:00').getTime()).booked).toBe(0);
  });

  it('a fully booked window moves the plan', async () => {
    const slot = at('2026-10-08', '12:00').getTime();
    const busy: LoadSource = {
      kind: 'live',
      snapshot: () => Promise.resolve(snapshotFromBookings([slot, slot], 2, 120)),
    };
    const plan = await planner(busy).forDate('2026-10-08', at('2026-10-02', '15:00'));
    expect(plan?.slotText).toBe('чт 8 окт с 14:00');
    expect(plan?.carReadyText).toBe('к 16:00');
  });
});
