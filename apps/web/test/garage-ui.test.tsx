// Step 6 (docs/garage.md) on the pages, rendered without a database: the «Моя машина» block of
// the checkout (none without the switch, folded, the prefill and its note, the VIN hint of «Купить
// снова», the fields sent in `vehicle`), the demo (the block over a sample car, the button still
// posts an empty form), the «Для: …» line of the order page, the «Купить снова» variant of /p and
// the cars of the admin order card.
import { parseEnv } from '@detaly/config';
import { minimalEnvSource } from '@detaly/config/testing';
import type { OrderItemView } from '@/server/orders/order-view';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type * as Navigation from 'next/navigation';
import { describe, expect, it, vi } from 'vitest';
import { CheckoutForm, type CheckoutFormProps } from '@/components/checkout/CheckoutForm';
import { VehicleBlock } from '@/components/checkout/VehicleBlock';
import { ItemsBlock } from '@/components/order/OrderSections';
import { ProposalSheet } from '@/components/vin/ProposalSheet';
import {
  DEMO_VEHICLE_EXAMPLE,
  vehicleFormLabel,
  type VehiclePrefillView,
} from '@/lib/vehicle-form';
import { demoVehicleBlock } from '@/server/garage/checkout-block';
import type { ProposalPageView } from '@/server/vin/proposal-page';

vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof Navigation>()),
  usePathname: () => '/',
  useSearchParams: () => null,
  useRouter: () => ({ refresh: () => undefined, push: () => undefined }),
}));

const render = <P extends object>(component: (props: P) => unknown, props: P): string =>
  renderToStaticMarkup(createElement(component as never, props as never));

function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const formProps: CheckoutFormProps = {
  part: 'all',
  expectedTotalKop: 128_000,
  itemsHash: 'a'.repeat(64),
  checkoutKey: '01890000-0000-7000-8000-000000000001',
  documents: {
    offerVersionId: '01890000-0000-7000-8000-000000000002',
    consentPdVersionId: '01890000-0000-7000-8000-000000000003',
    consentMarketingVersionId: null,
  },
  expectedScheme: 'pay_on_handover',
  expectedPromisedDate: '2026-10-10',
  marketingAvailable: false,
  blockedMessage: null,
  contactPhone: null,
};

const KIT_PREFILL: VehiclePrefillView = {
  source: 'kit',
  values: { make: 'Lada', model: 'Vesta', engine: '1.6 16V', year: '', vin: '', mileage: '' },
  vinHint: null,
};

describe('the «Моя машина» block of the checkout', () => {
  it('is not there without GARAGE_ENABLED (no `vehicle` prop): no field, no word of a car', () => {
    const html = render(CheckoutForm, formProps);
    expect(html).not.toContain('data-testid="checkout-vehicle"');
    expect(html).not.toMatch(/name="vehicle/);
    expect(text(html)).not.toContain('Моя машина');
    expect(render(CheckoutForm, { ...formProps, vehicle: null })).not.toContain('checkout-vehicle');
  });

  it('is folded, says it is optional and names every field for the form', () => {
    const html = render(CheckoutForm, { ...formProps, vehicle: { prefill: null } });
    const block = /<details[^>]*data-testid="checkout-vehicle"[^>]*>/.exec(html)?.[0] ?? '';
    expect(block).not.toBe('');
    // Folded: no `open` attribute.
    expect(block).not.toMatch(/\sopen(=|\s|>)/);
    expect(text(html)).toContain('Моя машина (необязательно)');
    for (const name of [
      'vehicleMake',
      'vehicleModel',
      'vehicleEngine',
      'vehicleYear',
      'vehicleVin',
      'vehicleMileage',
    ]) {
      const input = new RegExp(`<input[^>]*name="${name}"[^>]*>`).exec(html)?.[0] ?? '';
      expect(input, name).not.toBe('');
      // Optional: never required, never pre-ticked by the browser.
      expect(input, name).not.toMatch(/\srequired/);
    }
    // Empty and folded: no clear button, the summary asks what the parts are for.
    expect(html).not.toContain('checkout-vehicle-clear');
    expect(text(html)).toContain('Для какой машины эти детали');
  });

  it('a prefill shows in the folded summary, so nothing is sent unseen', () => {
    const html = render(VehicleBlock, { prefill: KIT_PREFILL });
    expect(html).toMatch(/data-prefill="kit"/);
    expect(text(html)).toContain('Lada Vesta 1.6 16V');
    expect(text(html)).toContain('Подставили машину из набора для ТО');
    expect(html).toMatch(/<input[^>]*name="vehicleMake"[^>]*value="Lada"/);
    expect(html).toContain('data-testid="checkout-vehicle-clear"');
    expect(text(html)).toContain('Не сохранять машину');
  });

  it('«Купить снова»: the stored VIN is never in the page, only its last 4 characters', () => {
    const html = render(VehicleBlock, {
      prefill: {
        source: 'bot',
        values: { make: 'Lada', model: 'Vesta', engine: '1.6', year: '2019', vin: '', mileage: '' },
        vinHint: '…6789',
      },
    });
    expect(text(html)).toContain('VIN …6789 уже сохранён');
    expect(html).toMatch(/<input[^>]*name="vehicleVin"[^>]*value=""/);
    expect(text(html)).toContain('Подставили машину прошлого заказа');
  });

  it('shows the server’s messages under the fields', () => {
    const html = render(VehicleBlock, {
      prefill: null,
      errors: { vehicleVin: 'В VIN не бывает букв O, I и Q', vehicleMake: 'Укажите марку' },
    });
    expect(text(html)).toContain('В VIN не бывает букв O, I и Q');
    expect(html).toMatch(/<input[^>]*aria-invalid="true"[^>]*name="vehicleVin"/);
  });

  it('the summary label', () => {
    expect(vehicleFormLabel(DEMO_VEHICLE_EXAMPLE)).toBe('Lada Vesta 1.6, 2019');
    expect(vehicleFormLabel({ ...DEMO_VEHICLE_EXAMPLE, engine: '', year: '' })).toBe('Lada Vesta');
    expect(vehicleFormLabel({ ...DEMO_VEHICLE_EXAMPLE, make: '', model: '', engine: '' })).toBe('');
  });
});

describe('the demo: the block renders, nothing is sent', () => {
  it('GARAGE_ENABLED decides the demo block (off by default)', () => {
    const demoEnv = (garage?: string) =>
      parseEnv(
        minimalEnvSource({
          DEMO_MODE: 'true',
          DATABASE_URL: undefined,
          REDIS_URL: undefined,
          ...(garage ? { GARAGE_ENABLED: garage } : {}),
        }),
      );
    expect(demoVehicleBlock(demoEnv())).toBeNull();
    expect(demoVehicleBlock(demoEnv('false'))).toBeNull();
    expect(demoVehicleBlock(demoEnv('true'))).toEqual({
      prefill: null,
      demoValues: DEMO_VEHICLE_EXAMPLE,
    });
  });

  it('the sample car is shown, and the demo button still posts the empty separate form', () => {
    const html = render(CheckoutForm, {
      ...formProps,
      demo: { action: '/api/demo/checkout-done' },
      vehicle: demoVehicleBlock({ GARAGE_ENABLED: true }),
    });
    expect(html).toMatch(/data-prefill="demo"/);
    expect(text(html)).toContain('Демо: пример машины, никуда не отправляется');
    expect(text(html)).toContain('Lada Vesta 1.6, 2019');
    expect(html).toMatch(
      /<button type="submit" form="demo-checkout-done"[^>]*data-testid="demo-checkout-submit"/,
    );
    const done = /<form id="demo-checkout-done"[^>]*>(.*?)<\/form>/s.exec(html);
    expect(done?.[1]).toBe('');
  });
});

const ITEM: OrderItemView = {
  id: 'i1',
  brand: 'Knecht',
  article: 'OC 90',
  name: 'Фильтр масляный',
  qty: 1,
  isLocal: true,
  priceClientKop: 64_000,
  lineTotalKop: 64_000,
  state: 'ordered',
  stateLabel: 'Заказана у поставщика',
  waiting: true,
  inactive: false,
  canCancel: false,
  fitChecked: false,
  fitGuarantee: false,
};

describe('the order page', () => {
  it('«Для: Lada Vesta 1.6, 2019» with a car, nothing without', () => {
    const props = { items: [ITEM], subtotalKop: 64_000, courierFeeKop: 0, totalKop: 64_000 };
    const withCar = render(ItemsBlock, {
      ...props,
      vehicle: { label: 'Lada Vesta 1.6, 2019' },
    });
    expect(withCar).toContain('data-testid="order-vehicle"');
    expect(text(withCar)).toContain('Для: Lada Vesta 1.6, 2019');
    const without = render(ItemsBlock, props);
    expect(without).not.toContain('order-vehicle');
    expect(text(without)).not.toContain('Для:');
  });
});

const PROPOSAL: ProposalPageView = {
  comment: 'Не вошли: CASTROL EDGE 5W-40 — не продаём онлайн',
  lines: [
    {
      id: 'l1',
      brand: 'Knecht',
      article: 'OC 90',
      name: 'Фильтр масляный',
      qty: 1,
      isLocal: true,
      priceText: '640 ₽',
      lineTotalText: '640 ₽',
      promiseText: 'к пт 10 октября',
      status: 'ok',
    },
  ],
  totalKop: 64_000,
  totalText: '640 ₽',
  itemsCount: 1,
  promiseText: 'к пт 10 октября',
  expired: false,
  expiresText: '16 октября',
  stale: false,
  changed: false,
  unavailable: 0,
};

describe('/p of «Купить снова»', () => {
  it('the order it repeats, the note of what did not go in; no master, no «подобрали мы»', () => {
    const html = render(ProposalSheet, {
      view: { ...PROPOSAL, repeat: { orderNumber: 'DT-000123' } },
      mode: { kind: 'live', action: '/api/proposals/x/take' },
      contactPhone: null,
    });
    expect(text(html)).toContain('Что было в заказе DT-000123');
    expect(html).toContain('data-testid="proposal-repeat-note"');
    expect(text(html)).toContain('Не вошли: CASTROL EDGE 5W-40');
    expect(text(html)).not.toContain('Комментарий мастера');
    expect(html).not.toContain('proposal-guarantee');
  });

  it('a master’s proposal is as it was', () => {
    const html = render(ProposalSheet, {
      view: { ...PROPOSAL, comment: 'Берите оригинал' },
      mode: { kind: 'live', action: '/api/proposals/x/take' },
      contactPhone: null,
    });
    expect(text(html)).toContain('Что подобрал мастер');
    expect(text(html)).toContain('Комментарий мастера');
    expect(html).toContain('proposal-guarantee');
  });

  it('an expired repeat link asks to press «Купить снова» again', () => {
    const html = render(ProposalSheet, {
      view: { ...PROPOSAL, expired: true, repeat: { orderNumber: 'DT-000123' } },
      mode: { kind: 'expired' },
      contactPhone: '+7 900 000-00-01',
    });
    expect(text(html)).toContain('Нажмите «Купить снова» в Telegram ещё раз');
    expect(text(html)).not.toContain('Попросите мастера');
  });
});
