/**
 * DEMO_MODE: «Оформить заказ» of the demo checkout posts an EMPTY form here (no field of the
 * checkout form is sent). The proxy answers 303 to the sample order and empties the demo cart,
 * as a real order takes the lines out of the cart (src/proxy.ts, demoFormRedirect).
 */
export const DEMO_CHECKOUT_DONE_PATH = '/api/demo/checkout-done';
