// msw request handlers emulating YooKassa API v3 for tests ('@detaly/payments/testing').
// Step 0 stub: no handlers yet; implemented in work package P2.
import type { RequestHandler } from 'msw';

export function createYooKassaHandlers(_options: { apiUrl?: string } = {}): RequestHandler[] {
  return [];
}
