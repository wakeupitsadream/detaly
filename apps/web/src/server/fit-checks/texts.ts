/**
 * Texts of the step 4 fit check shared by server handlers and server components (pure, no env).
 */

/** The closed gate (as the closed /vin): checks open together with online orders. */
export function fitClosedText(phone: string | null): string {
  return phone
    ? `Проверка откроется вместе с заказами на сайте. Пока позвоните: ${phone}`
    : 'Проверка откроется вместе с заказами на сайте. Пока спросите в пункте выдачи.';
}
