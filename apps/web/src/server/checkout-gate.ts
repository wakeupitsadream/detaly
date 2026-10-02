/**
 * Whether online checkout (a form collecting personal data) may be shown and accepted
 * (decision Д4, PLAN: "РКН до публикации форм"):
 * - RKN_NOTICE_NUMBER must be set (the operator is registered with Roskomnadzor);
 * - the offer, privacy policy and PD consent texts must exist; with NODE_ENV=production they
 *   must be published versions (a consent to a draft is no proof). Outside production drafts
 *   are accepted, and consents record the draft's version and sha256.
 * The marketing consent document is optional: without it the checkbox is not shown.
 */
import type { Env } from '@detaly/config';
import type { Executor } from '@detaly/db';
import type { DocumentKind } from '@detaly/domain';
import { getPublishedDocument, type LegalDocument } from './documents';

export interface CheckoutDocuments {
  offer: LegalDocument;
  privacy: LegalDocument;
  consentPd: LegalDocument;
  consentMarketing: LegalDocument | null;
}

export type CheckoutGate =
  | { open: true; docs: CheckoutDocuments }
  | { open: false; reason: 'rkn' | 'documents'; message: string };

export const CHECKOUT_CLOSED_DOCUMENTS_MESSAGE = 'Оформление временно недоступно';

/** Text of the closed gate before Roskomnadzor registration, with the point's phone. */
export function rknClosedMessage(
  env: Pick<Env, 'PICKUP_PHONE' | 'SELLER_REQUISITES_PHONE'>,
): string {
  const phone = env.PICKUP_PHONE ?? env.SELLER_REQUISITES_PHONE;
  const how = phone ? `по телефону ${phone}` : 'по телефону пункта выдачи';
  return (
    'Онлайн-оформление откроется после регистрации оператора персональных данных. ' +
    `Пока заказать можно ${how}.`
  );
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
