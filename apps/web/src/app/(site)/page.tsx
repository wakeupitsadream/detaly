import { formatRub, parseWorkHours, type WeekSchedule } from '@detaly/domain';
import { ArticleOrVin } from '@/components/home/ArticleOrVin';
import { Hero } from '@/components/home/Hero';
import type { HeroFact } from '@/components/home/HeroFacts';
import { InstallWindowDemo } from '@/components/home/InstallWindowDemo';
import { OrderRoute } from '@/components/home/OrderRoute';
import { PickupPointSection } from '@/components/home/PickupPointSection';
import { Eyebrow } from '@/components/ui/Eyebrow';
import { INSTALL_JOB_MIN, durationWords } from '@/lib/install-params';
import { FullBleed, Section } from '@/components/ui/Section';
import { getBrand } from '@/server/brand';
import { planInstallShowcase, type InstallShowcase } from '@/server/install';
import { getSupplier } from '@/server/supplier';

const DAY_SHORT = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'] as const;
const MONDAY_FIRST = [1, 2, 3, 4, 5, 6, 0] as const;

function clockShort(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? String(h) : `${h}:${String(m).padStart(2, '0')}`;
}

/**
 * "10–19" with "пн–пт — часы выдачи" when every working day has the same hours; null for a
 * schedule that does not fit one figure (the pickup section shows the full text anyway).
 */
function hoursFact(schedule: WeekSchedule | null): HeroFact | null {
  if (schedule === null) return null;
  const working = MONDAY_FIRST.filter((day) => schedule[day] !== null);
  const first = schedule[working[0] ?? 1];
  if (!first) return null;
  if (
    working.some(
      (d) => schedule[d]?.openMin !== first.openMin || schedule[d]?.closeMin !== first.closeMin,
    )
  ) {
    return null;
  }
  const positions = working.map((day) => MONDAY_FIRST.indexOf(day));
  const contiguous = positions.every((p, i) => i === 0 || p === positions[i - 1]! + 1);
  const days =
    working.length === 7
      ? 'ежедневно'
      : contiguous && working.length > 2
        ? `${DAY_SHORT[working[0]!]}–${DAY_SHORT[working[working.length - 1]!]}`
        : working.map((d) => DAY_SHORT[d]).join(', ');
  return {
    value: `${clockShort(first.openMin)}–${clockShort(first.closeMin)}`,
    label: `${days}, часы выдачи и установки`,
  };
}

async function onPickupMaxKop(): Promise<number | null> {
  try {
    return (await getSupplier().settings.get()).order.onPickupMaxTotalKop;
  } catch {
    return null;
  }
}

function InstallSection({ showcase }: { showcase: InstallShowcase }) {
  return (
    <Section id="install" aria-labelledby="install-title" className="scroll-mt-16">
      {/* Phones: heading, the widget, then how it works. Desktop: text left, widget right. */}
      <div className="grid min-w-0 gap-10 lg:grid-cols-12 lg:grid-rows-[auto_1fr] lg:gap-x-12 lg:gap-y-0">
        <div className="min-w-0 lg:col-span-5 lg:row-start-1">
          <Eyebrow>Расчёт до заказа</Eyebrow>
          <h2 id="install-title" className="mt-4 text-h1">
            Когда машина будет готова
          </h2>
          <p className="mt-5 max-w-md text-muted">
            Мы знаем срок поставки и загрузку подъёмников в сервисе. Поэтому ещё в поиске видно не
            только когда приедет деталь, но и когда вы уедете на машине.
          </p>
        </div>
        <div className="min-w-0 lg:col-span-7 lg:col-start-6 lg:row-span-2 lg:row-start-1 lg:pt-2">
          <InstallWindowDemo showcase={showcase} />
        </div>
        <div className="min-w-0 lg:col-span-5 lg:row-start-2">
          <ol className="max-w-md border-b border-line lg:mt-8">
            {[
              [
                'Дата поставки',
                'Срок склада поставщика плюс запас на дорогу — та же дата, что в поиске.',
              ],
              [
                'Загрузка подъёмников',
                'Сколько машин уже записано в сервис на каждый час рабочего дня.',
              ],
              [
                'Время работы',
                `Типовая замена — около ${durationWords(INSTALL_JOB_MIN, 'gen')}. Сложную работу мастер оценит сам.`,
              ],
            ].map(([title, text], index) => (
              <li
                key={title}
                className="grid grid-cols-[2.25rem_minmax(0,1fr)] gap-x-3 border-t border-line py-4"
              >
                <span className="font-mono text-sm font-semibold text-accent-ink">
                  {String(index + 1).padStart(2, '0')}
                </span>
                <span className="min-w-0">
                  <span className="block font-semibold">{title}</span>
                  <span className="mt-1 block text-sm text-muted">{text}</span>
                </span>
              </li>
            ))}
          </ol>
          <p className="mt-5 max-w-md text-sm text-muted">
            Это расчёт, а не запись: время подтверждает мастер. Установка — услуга сервиса, её
            оплачивают там.
          </p>
        </div>
      </div>
    </Section>
  );
}

export default async function HomePage() {
  const brand = getBrand();
  const now = new Date();
  const [showcase, maxKop] = await Promise.all([planInstallShowcase(now), onPickupMaxKop()]);

  const facts: HeroFact[] = [];
  if (maxKop !== null && maxKop > 0) {
    facts.push({
      value: `до ${formatRub(maxKop)}`,
      label: 'оплата при получении, если деталь в городе',
    });
  }
  facts.push({ value: '7 дней', label: 'на возврат без удержаний' });
  const hours = hoursFact(parseWorkHours(brand.pickup.hours));
  if (hours) facts.push(hours);
  facts.push({ value: '1 точка', label: 'выдачи — прямо в автосервисе' });

  return (
    <FullBleed>
      <Hero showcase={showcase} facts={facts} demoData={brand.demoData} />
      {showcase ? <InstallSection showcase={showcase} /> : null}
      <Section tone="sunken" aria-labelledby="start-title">
        <Eyebrow>С чего начать</Eyebrow>
        <h2 id="start-title" className="mt-4 text-h1">
          {/* No-break space: the dash never starts a line. */}
          Артикул знаете{' '}— или нет
        </h2>
        <ArticleOrVin className="mt-10" />
        <div className="mt-16 md:mt-20">
          <p className="text-label text-muted">Как проходит заказ</p>
          <OrderRoute className="mt-6" />
        </div>
      </Section>
      <PickupPointSection brand={brand} />
    </FullBleed>
  );
}
