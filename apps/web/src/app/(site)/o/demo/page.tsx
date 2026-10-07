import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { OrderDetails } from '@/components/order/OrderDetails';
import { pickupRoutes } from '@/components/PickupRouteLinks';
import { FullBleed } from '@/components/ui/Section';
import { getBrand } from '@/server/brand';
import {
  buildDemoOrderServices,
  buildDemoOrderView,
  claimsByStatus,
} from '@/server/demo/order-fixture';
import { serverEnv } from '@/server/env';
import { planInstallForDate } from '@/server/install';
import { isDemoMode } from '@/server/mode';
import { FLASH_MESSAGES, parseDemoScreen, type OrderFlash } from '@/server/orders/flash';
import { installPartner } from '@/server/orders/order-services';
import { getSupplier } from '@/server/supplier';

// Reads env and the fixtures on every request (DEMO_MODE is a runtime switch).
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Пример заказа',
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const DEMO_FLASH = { link: 'demo_link', install: 'demo_install', claim: 'demo_claim' } as const;

/**
 * /o/demo: the sample order of DEMO_MODE (docs/design.md, section 5). The same OrderDetails
 * as /o/<token>, over server/demo/order-fixture.ts. Outside the demo the page does not exist
 * (a real order token is never this short).
 *
 * Phase 1C (decision С21): the forms of the sample are GETs to /o/demo?demo=<what> without a
 * single named personal field (server/demo/order-fixture.ts), and this page shows the screen
 * that follows (`?demo=`). Nothing is stored, no personal data is accepted.
 */
export default async function DemoOrderPage({ searchParams }: { searchParams?: SearchParams }) {
  if (!isDemoMode()) notFound();
  const supplier = getSupplier();
  const now = new Date();
  const view = await buildDemoOrderView({
    rossko: supplier.rossko,
    loadSettings: () => supplier.settings.get(),
    now,
  });
  const brand = getBrand();
  const screen = parseDemoScreen((await searchParams) ?? {});
  const all = buildDemoOrderServices({
    view,
    screen,
    hours: brand.pickup.hours,
    // Without INSTALL_PARTNER_NAME the demo names the pickup point (it is the one that installs).
    partner:
      installPartner(serverEnv()) ??
      (brand.pickup.name ? { name: brand.pickup.name, requisites: null } : null),
    now,
  });
  // «Претензия» only when the status allows one, as on a real order page.
  const services = claimsByStatus(all, { view, screen, now });
  let flash: OrderFlash | null = null;
  if (screen !== null) {
    const code = DEMO_FLASH[screen];
    const message = FLASH_MESSAGES[code];
    flash = { code, tone: message.tone, text: message.text, section: message.section };
  }
  // The nearest lift slot, as on a real order page (planInstallForDate never throws).
  const install = view.promisedDate ? await planInstallForDate(view.promisedDate, now) : null;
  // The «Демо» strip above the header names this page as a sample (components/DemoStrip).
  return (
    <FullBleed>
      <OrderDetails
        view={view}
        install={install}
        services={services}
        flash={flash}
        pickup={brand.pickup}
        routes={pickupRoutes(brand)}
        contactPhone={brand.contactPhone}
        cartReminder={null}
        demo
      />
    </FullBleed>
  );
}
