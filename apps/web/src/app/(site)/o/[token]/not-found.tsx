import { IconHome, IconPhone, IconSearch } from '@/components/icons';
import { EmptyPanel } from '@/components/page/EmptyPanel';
import { ButtonLink } from '@/components/ui/Button';
import { getBrand, telHref } from '@/server/brand';

/**
 * /o/<token> with a link that leads nowhere (a cut or mistyped token): inside the site layout,
 * so the header, the footer and the phone of the point are there. The client is told where the
 * link comes from and gets the call button when a phone is set.
 */
export default function OrderNotFound() {
  const phone = getBrand().contactPhone;
  return (
    <div className="flex min-w-0 flex-col justify-center px-4 py-16 md:px-6 lg:px-8">
      <EmptyPanel
        icon={<IconSearch size={64} />}
        eyebrow="Ошибка 404"
        title="Заказ не найден"
        titleAs="h1"
        titleId="order-not-found-title"
        text="Проверьте ссылку из сообщения о заказе: она должна открываться целиком."
        testId="order-not-found"
        actions={
          <>
            {phone ? (
              <ButtonLink href={telHref(phone)} size="lg" icon={<IconPhone size={20} />}>
                Позвонить {phone}
              </ButtonLink>
            ) : null}
            <ButtonLink
              href="/"
              variant={phone ? 'secondary' : 'primary'}
              size="lg"
              className={phone ? 'bg-bg' : undefined}
              icon={<IconHome size={20} />}
            >
              На главную
            </ButtonLink>
          </>
        }
      />
    </div>
  );
}
