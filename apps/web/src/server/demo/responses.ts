/**
 * Answers of the routes that do not exist in DEMO_MODE. src/proxy.ts refuses the same paths
 * first; the handlers check again so a route never reaches the database when the proxy is
 * bypassed (a matcher change, a direct call in tests).
 */
const NO_STORE = { 'Cache-Control': 'no-store' } as const;

/** Admin, webhooks and the order API: 404 as if the route did not exist. */
export function demoNotFound(): Response {
  return Response.json({ error: 'not_found' }, { status: 404, headers: NO_STORE });
}

export const DEMO_CHECKOUT_MESSAGE =
  'Это демо: оформление заказа отключено. Посмотрите пример заказа по ссылке /o/demo.';

/** POST /api/checkout: nothing is created and no personal data is accepted. */
export function demoCheckoutForbidden(): Response {
  return Response.json(
    { error: 'demo', message: DEMO_CHECKOUT_MESSAGE },
    { status: 403, headers: NO_STORE },
  );
}
