import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { OrderDetails } from '@/components/order/OrderDetails';
import { Badge } from '@/components/ui/Badge';
import { getBrand } from '@/server/brand';
import { buildDemoOrderView } from '@/server/demo/order-fixture';
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
  return (
    <div className="min-w-0 space-y-4">
      <p
        className="mx-auto flex max-w-2xl min-w-0 flex-wrap items-center gap-2 text-sm text-muted"
        role="note"
        data-testid="demo-order-note"
      >
        <Badge tone="demo" className="font-semibold">
          Пример
        </Badge>
        Так выглядит страница заказа: ссылку на неё клиент получает сразу после оформления, а
        статусы приходят в мессенджер.
      </p>
      <OrderDetails
        view={view}
        pickup={brand.pickup}
        contactPhone={brand.contactPhone}
        cartReminder={null}
      />
    </div>
  );
}
