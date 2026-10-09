'use client';

import { useEffect } from 'react';

/**
 * With JavaScript, the total of a kit follows the client's choices (step 5, docs/kits.md):
 * without it the card shows the default choice and the cart gets what the radios say anyway.
 * Every option on offer carries its line total (`data-kop`, kopecks, priced on the server by
 * priceOffer), its supplier date (`data-eta`) and the promise of that date (`data-promise`); the
 * lines without a choice are the `base`. The promise of the kit is the promise of its latest
 * line (promisedDate only looks at the latest date), so no date arithmetic happens here.
 */
export function KitChoiceSync({
  formId,
  base,
}: {
  formId: string;
  base: { kop: number; eta: string | null; promise: string | null };
}) {
  useEffect(() => {
    const form = document.getElementById(formId);
    if (!(form instanceof HTMLFormElement)) return;
    const money = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });
    const update = () => {
      let kop = base.kop;
      let latest: { eta: string; promise: string } | null =
        base.eta && base.promise ? { eta: base.eta, promise: base.promise } : null;
      for (const input of form.querySelectorAll<HTMLInputElement>('input[type="radio"]:checked')) {
        kop += Number(input.dataset.kop ?? 0);
        const eta = input.dataset.eta;
        const promise = input.dataset.promise;
        if (eta && promise && (latest === null || eta > latest.eta)) latest = { eta, promise };
      }
      const total = form.querySelector('[data-testid="kit-total"]');
      // Prices are whole rubles (priceOffer rounds up to a ruble).
      if (total) total.textContent = `${money.format(Math.round(kop / 100))}\u00a0₽`;
      const promise = form.querySelector('[data-kit-promise]');
      if (promise && latest) promise.textContent = latest.promise;
    };
    form.addEventListener('change', update);
    return () => form.removeEventListener('change', update);
  }, [formId, base.kop, base.eta, base.promise]);
  return null;
}
