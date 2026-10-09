import { IconShield } from '../icons';

/**
 * Step 4 (docs/fit-check.md): the fit guarantee as /returns states it. A draft for the lawyer:
 * shown only with FIT_GUARANTEE_ENABLED, after the founder and the lawyer have approved it and
 * it is in the offer (content/legal is not changed by this text).
 */
export const FIT_GUARANTEE_RETURNS_TEXT =
  'Если мастер проверил деталь под ваш VIN, а она не подошла по применимости, вернём деньги ' +
  'полностью — даже если упаковка вскрыта. Гарантия не распространяется на детали, повреждённые ' +
  'при установке, и на детали, которые мастер не проверял.';

/** «Гарантия подбора» (#fit-guarantee: the guarantee line under «Проверено мастером» links here). */
export function FitGuaranteeNote() {
  return (
    <section
      id="fit-guarantee"
      aria-labelledby="returns-fit-guarantee"
      className="min-w-0 scroll-mt-28 rounded-tile border border-line bg-bg p-4 md:p-6"
      data-testid="returns-fit-guarantee"
    >
      <h2 id="returns-fit-guarantee" className="flex min-w-0 items-center gap-3 text-h3">
        <IconShield size={24} className="shrink-0 text-ok" />
        Гарантия подбора
      </h2>
      <p className="mt-2 text-body">{FIT_GUARANTEE_RETURNS_TEXT}</p>
    </section>
  );
}
