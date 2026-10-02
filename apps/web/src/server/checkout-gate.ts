/**
 * Whether online checkout (a form collecting personal data) may be shown and accepted
 * (decision Д4, PLAN: "РКН до публикации форм"):
 * - RKN_NOTICE_NUMBER must be set (the operator is registered with Roskomnadzor);
 * - the offer, privacy policy and PD consent texts must exist; with NODE_ENV=production they
 *   must be published versions (a consent to a draft is no proof). Outside production drafts
 *   are accepted, and consents record the draft's version and sha256.
 * - the pickup point must be known (PICKUP_ADDRESS and PICKUP_HOURS): pickup is the only way
 *   to receive an order, and the client must see where and when before ordering.
 * The marketing consent document is optional: without it the checkbox is not shown.
 */
import type { Env } from '@detaly/config';
import type { Executor } from '@detaly/db';
import type { DocumentKind } from '@detaly/domain';
import { getDb } from './db';
import { demoDocument } from './demo/documents';
import { getPublishedDocument, type LegalDocument } from './documents';
import { serverEnv } from './env';
import { errorInfo } from './errors';
import { getLogger } from './logger';
import { isDemoMode } from './mode';

export interface CheckoutDocuments {
  offer: LegalDocument;
  privacy: LegalDocument;
  consentPd: LegalDocument;
  consentMarketing: LegalDocument | null;
}

export type CheckoutGate =
  | { open: true; docs: CheckoutDocuments }
  | { open: false; reason: 'rkn' | 'documents' | 'pickup'; message: string };

export const CHECKOUT_CLOSED_DOCUMENTS_MESSAGE = 'Оформление на сайте временно недоступно.';

/** Phone the closed gate sends clients to (the pickup point, else the seller's). */
export function gatePhone(env: Pick<Env, 'PICKUP_PHONE' | 'SELLER_REQUISITES_PHONE'>) {
  return env.PICKUP_PHONE ?? env.SELLER_REQUISITES_PHONE ?? null;
}

/** Text of the closed gate before Roskomnadzor registration, with the point's phone. */
export function rknClosedMessage(
  env: Pick<Env, 'PICKUP_PHONE' | 'SELLER_REQUISITES_PHONE'>,
): string {
  const phone = gatePhone(env);
  return phone
    ? `Оформление на сайте скоро откроется. Пока закажите по телефону ${phone}.`
    : 'Оформление на сайте скоро откроется. Пока закажите в пункте выдачи.';
}

interface GateLogger {
  warn(details: Record<string, unknown>, message: string): void;
}

export interface CheckoutGateOptions {
  env: Env;
  /** The database or a transaction. */
  db: Executor;
  /** Receives a warning (document kinds only, no PD) when documents close the gate. */
  logger?: GateLogger;
}

const REQUIRED = { offer: 'offer', privacy: 'privacy', consentPd: 'consent_pd' } as const;

export async function getCheckoutGate({
  env,
  db,
  logger,
}: CheckoutGateOptions): Promise<CheckoutGate> {
  if (!env.RKN_NOTICE_NUMBER) {
    return { open: false, reason: 'rkn', message: rknClosedMessage(env) };
  }
  if (!env.PICKUP_ADDRESS || !env.PICKUP_HOURS) {
    logger?.warn({}, 'checkout closed: PICKUP_ADDRESS or PICKUP_HOURS is not set');
    return { open: false, reason: 'pickup', message: CHECKOUT_CLOSED_DOCUMENTS_MESSAGE };
  }
  const production = env.NODE_ENV === 'production';
  const usable = (doc: LegalDocument | null): doc is LegalDocument =>
    doc !== null && (!production || !doc.isDraft);

  const [offer, privacy, consentPd, consentMarketing] = await Promise.all(
    (['offer', 'privacy', 'consent_pd', 'consent_marketing'] as const).map((kind) =>
      getPublishedDocument(kind, { db, env }),
    ),
  );
  const found = { offer, privacy, consentPd } as const;
  const missing: DocumentKind[] = [];
  for (const key of Object.keys(REQUIRED) as (keyof typeof REQUIRED)[]) {
    if (!usable(found[key] ?? null)) missing.push(REQUIRED[key]);
  }
  if (missing.length > 0 || !offer || !privacy || !consentPd) {
    logger?.warn({ missing, production }, 'checkout closed: legal documents are not published');
    return { open: false, reason: 'documents', message: CHECKOUT_CLOSED_DOCUMENTS_MESSAGE };
  }
  return {
    open: true,
    docs: {
      offer,
      privacy,
      consentPd,
      consentMarketing: usable(consentMarketing ?? null) ? (consentMarketing ?? null) : null,
    },
  };
}

/**
 * DEMO_MODE gate: open, so the storefront shows «В корзину» and «Оформить заказ» as in
 * production; nothing collects personal data anyway (the checkout page shows the demo notice
 * and POST /api/checkout answers 403). The documents are the bundled ones. Closed only when a
 * required text is missing from the bundle.
 */
export function demoCheckoutGate(env: Env): CheckoutGate {
  const offer = demoDocument('offer', env);
  const privacy = demoDocument('privacy', env);
  const consentPd = demoDocument('consent_pd', env);
  if (!offer || !privacy || !consentPd) {
    return { open: false, reason: 'documents', message: CHECKOUT_CLOSED_DOCUMENTS_MESSAGE };
  }
  return {
    open: true,
    docs: { offer, privacy, consentPd, consentMarketing: demoDocument('consent_marketing', env) },
  };
}

/**
 * The gate for a page render: getCheckoutGate with the process env, database and logger. A
 * failure (database down) closes the gate for this render instead of failing the page.
 * DEMO_MODE: demoCheckoutGate.
 */
export async function currentCheckoutGate(): Promise<CheckoutGate> {
  if (isDemoMode()) return demoCheckoutGate(serverEnv());
  try {
    return await getCheckoutGate({ env: serverEnv(), db: getDb(), logger: getLogger() });
  } catch (error) {
    getLogger().warn(errorInfo(error), 'checkout gate failed');
    return { open: false, reason: 'documents', message: CHECKOUT_CLOSED_DOCUMENTS_MESSAGE };
  }
}
