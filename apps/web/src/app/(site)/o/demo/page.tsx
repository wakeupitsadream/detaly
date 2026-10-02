import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { OrderDetails } from '@/components/order/OrderDetails';
import { FullBleed } from '@/components/ui/Section';
import { getBrand } from '@/server/brand';
import { buildDemoOrderView } from '@/server/demo/order-fixture';
import { planInstallForDate } from '@/server/install';
import { isDemoMode } from '@/server/mode';
import { getSupplier } from '@/server/supplier';

// Reads env and the fixtures on every request (DEMO_MODE is a runtime switch).
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Пример заказа',
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};

/**
 * /o/demo: the sample order of DEMO_MODE (docs/design.md, section 5). The same OrderDetails
 * as /o/<token>, over server/demo/order-fixture.ts. Outside the demo the page does not exist
 * (a real order token is never this short).
 */
export default async function DemoOrderPage() {
  if (!isDemoMode()) notFound();
  const supplier = getSupplier();
  const view = await buildDemoOrderView({
    rossko: supplier.rossko,
    loadSettings: () => supplier.settings.get(),
  });
  const brand = getBrand();
  // The nearest lift slot, as on a real order page (planInstallForDate never throws).
  const install = view.promisedDate
    ? await planInstallForDate(view.promisedDate, new Date())
    : null;
  // The «Демо» strip above the header names this page as a sample (components/DemoStrip).
  return (
    <FullBleed>
      <OrderDetails
        view={view}
        install={install}
        pickup={brand.pickup}
        contactPhone={brand.contactPhone}
        cartReminder={null}
        demo
      />
    </FullBleed>
  );
}
