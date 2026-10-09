'use client';

/**
 * «Моя машина (необязательно)» of the checkout (step 6, docs/garage.md): a folded block after the
 * order's lines with make, model, engine, year, VIN and mileage. Only with GARAGE_ENABLED. Folded
 * by default; the summary repeats what it holds («Lada Vesta 1.6, 2019»), so a prefilled car is
 * never sent unseen, and «Не сохранять машину» empties it. Without JavaScript it is a plain
 * <details> whose inputs the form reads like any other.
 *
 * The values come from the cart's own context (a maintenance kit, the VIN request of a proposal,
 * «Купить снова»), never from the client's cars by a phone. In the demo the block shows a sample
 * car and, like the whole demo form, sends nothing.
 */
import { useEffect, useId, useState } from 'react';
import { IconBody, IconChevronDown } from '@/components/icons';
import { buttonClass } from '@/components/ui/Button';
import { Field, fieldDescribedBy } from '@/components/ui/Field';
import { inputClass } from '@/components/ui/Input';
import { CAR_BRANDS } from '@/lib/brands';
import {
  EMPTY_VEHICLE_FORM,
  vehicleFormLabel,
  type VehicleFormField,
  type VehicleFormValues,
  type VehiclePrefillView,
} from '@/lib/vehicle-form';

/** The input names the checkout form reads (FormData). */
export const VEHICLE_INPUT_NAMES: Readonly<Record<keyof VehicleFormValues, VehicleFormField>> = {
  make: 'vehicleMake',
  model: 'vehicleModel',
  engine: 'vehicleEngine',
  year: 'vehicleYear',
  vin: 'vehicleVin',
  mileage: 'vehicleMileage',
};

const PREFILL_NOTE: Record<VehiclePrefillView['source'], string> = {
  kit: 'Подставили машину из набора для ТО — проверьте и добавьте год.',
  proposal: 'Подставили машину из заявки на подбор по VIN.',
  bot: 'Подставили машину прошлого заказа.',
};

export function VehicleBlock({
  prefill,
  demoValues = null,
  errors = {},
}: {
  prefill: VehiclePrefillView | null;
  /** DEMO_MODE: the sample car (the form sends nothing anyway). */
  demoValues?: VehicleFormValues | null;
  /** The server's messages by field (422). */
  errors?: Partial<Record<VehicleFormField, string>>;
}) {
  const id = useId();
  const initial = demoValues ?? prefill?.values ?? EMPTY_VEHICLE_FORM;
  const [values, setValues] = useState<VehicleFormValues>(initial);
  const [open, setOpen] = useState(false);
  const hasErrors = Object.values(errors).some(Boolean);
  // A refused submit opens the block at its fields.
  useEffect(() => {
    if (hasErrors) setOpen(true);
  }, [hasErrors]);
  const label = vehicleFormLabel(values);
  const set = (key: keyof VehicleFormValues) => (event: { target: { value: string } }) =>
    setValues((current) => ({ ...current, [key]: event.target.value }));
  const fieldId = (key: keyof VehicleFormValues) => `${id}-${key}`;
  const control = (key: keyof VehicleFormValues, hint?: string) => ({
    id: fieldId(key),
    name: VEHICLE_INPUT_NAMES[key],
    value: values[key],
    onChange: set(key),
    'aria-invalid': errors[VEHICLE_INPUT_NAMES[key]] ? true : undefined,
    'aria-describedby': fieldDescribedBy(fieldId(key), {
      hint,
      error: errors[VEHICLE_INPUT_NAMES[key]],
    }),
  });
  const vinHint =
    prefill?.source === 'bot' && prefill.vinHint
      ? `VIN ${prefill.vinHint} уже сохранён — вводить заново не нужно`
      : '17 символов, есть в СТС';
  const mileageHint = 'Необязательно — по одометру';

  return (
    <details
      className="details-plain group min-w-0 rounded-tile border border-line bg-bg"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
      data-testid="checkout-vehicle"
      data-prefill={prefill?.source ?? (demoValues ? 'demo' : 'none')}
    >
      <summary
        className="flex min-h-16 items-center gap-3 rounded-tile px-4 py-3 hover:bg-surface md:px-5"
        data-testid="checkout-vehicle-summary"
      >
        <IconBody size={28} className="shrink-0 text-brand" />
        <span className="min-w-0 flex-1">
          <span className="block text-[1.0625rem] leading-snug font-bold">
            Моя машина <span className="font-normal text-muted">(необязательно)</span>
          </span>
          {label ? (
            <span
              className="mt-0.5 block text-small font-normal wrap-anywhere text-ink"
              data-testid="checkout-vehicle-label"
            >
              {label}
            </span>
          ) : (
            <span className="mt-0.5 block text-small font-normal text-muted">
              Для какой машины эти детали
            </span>
          )}
        </span>
        <IconChevronDown
          size={22}
          className="shrink-0 text-muted transition-transform duration-150 group-open:rotate-180"
        />
      </summary>
      <div className="min-w-0 space-y-4 border-t border-line px-4 pt-4 pb-5 md:px-5">
        <p className="text-small font-normal text-muted">
          Сохраним машину к вашему номеру телефона: в Telegram-боте её заказы можно будет повторить
          одной кнопкой. Можно оставить пустым — на заказ это не влияет.
        </p>
        {demoValues ? (
          <p className="text-small font-semibold" data-testid="checkout-vehicle-demo">
            Демо: пример машины, никуда не отправляется.
          </p>
        ) : prefill ? (
          <p className="text-small font-semibold" data-testid="checkout-vehicle-prefill">
            {PREFILL_NOTE[prefill.source]}
          </p>
        ) : null}
        <div className="grid min-w-0 gap-4 sm:grid-cols-2">
          <Field id={fieldId('make')} label="Марка" error={errors.vehicleMake}>
            <input
              {...control('make')}
              type="text"
              autoComplete="off"
              maxLength={40}
              list={`${id}-makes`}
              placeholder="Lada"
              className={inputClass()}
            />
          </Field>
          <Field id={fieldId('model')} label="Модель" error={errors.vehicleModel}>
            <input
              {...control('model')}
              type="text"
              autoComplete="off"
              maxLength={60}
              placeholder="Vesta"
              className={inputClass()}
            />
          </Field>
          <Field id={fieldId('engine')} label="Двигатель" error={errors.vehicleEngine}>
            <input
              {...control('engine')}
              type="text"
              autoComplete="off"
              maxLength={40}
              placeholder="1.6"
              className={inputClass()}
            />
          </Field>
          <Field id={fieldId('year')} label="Год выпуска" error={errors.vehicleYear}>
            <input
              {...control('year')}
              type="text"
              inputMode="numeric"
              autoComplete="off"
              maxLength={4}
              placeholder="2019"
              className={inputClass({ className: 'tabular-nums' })}
            />
          </Field>
        </div>
        <datalist id={`${id}-makes`}>
          {CAR_BRANDS.map((brand) => (
            <option key={brand.slug} value={brand.name} />
          ))}
        </datalist>
        <Field id={fieldId('vin')} label="VIN" hint={vinHint} error={errors.vehicleVin}>
          <input
            {...control('vin', vinHint)}
            type="text"
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            maxLength={24}
            placeholder="17 символов"
            // As on /vin: the typed VIN in capitals, the placeholder as written.
            className={inputClass({ mono: true, className: 'uppercase placeholder:normal-case' })}
          />
        </Field>
        <Field
          id={fieldId('mileage')}
          label="Пробег, км"
          hint={mileageHint}
          error={errors.vehicleMileage}
          className="sm:max-w-[50%] sm:pr-2"
        >
          <input
            {...control('mileage', mileageHint)}
            type="text"
            inputMode="numeric"
            autoComplete="off"
            maxLength={12}
            placeholder="85 000"
            className={inputClass({ className: 'tabular-nums' })}
          />
        </Field>
        {label || values.vin || values.mileage ? (
          <button
            type="button"
            className={buttonClass({ variant: 'secondary' })}
            onClick={() => setValues(EMPTY_VEHICLE_FORM)}
            data-testid="checkout-vehicle-clear"
          >
            Не сохранять машину
          </button>
        ) : null}
      </div>
    </details>
  );
}
