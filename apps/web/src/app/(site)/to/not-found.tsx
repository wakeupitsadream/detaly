import type { Metadata } from 'next';
import { IconBox, IconSts } from '@/components/icons';
import { EmptyPanel } from '@/components/page/EmptyPanel';
import { ButtonLink } from '@/components/ui/Button';
import { KIT_VIN_NEED, KITS_PATH } from '@/lib/kit-paths';
import { vinRequestHref } from '@/lib/vin-link';

/**
 * «Набор не найден»: a make or a model without published kits (step 5, docs/kits.md), inside
 * the site layout. Next renders this boundary for a notFound() of the kit pages (status 404),
 * and the <title> of the shell comes from here.
 */
export const metadata: Metadata = { title: 'Набор не найден' };

export default function KitNotFound() {
  return (
    <div className="flex min-w-0 flex-col justify-center px-4 py-16 md:px-6 lg:px-8">
      <EmptyPanel
        icon={<IconBox size={64} />}
        eyebrow="Ошибка 404"
        title="Набор не найден"
        titleAs="h1"
        titleId="kit-not-found-title"
        text="Такого набора для ТО на сайте нет. Посмотрите другие или пришлите VIN."
        testId="kit-not-found"
        actions={
          <>
            <ButtonLink href={KITS_PATH} size="lg" icon={<IconBox size={20} />}>
              Все наборы
            </ButtonLink>
            <ButtonLink
              href={vinRequestHref({ need: KIT_VIN_NEED })}
              variant="secondary"
              size="lg"
              className="bg-bg"
              icon={<IconSts size={20} className="text-brand" />}
            >
              Подбор по VIN
            </ButtonLink>
          </>
        }
      />
    </div>
  );
}
