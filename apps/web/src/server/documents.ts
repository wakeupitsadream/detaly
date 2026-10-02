/**
 * Legal documents for /docs/* and /returns, read only from `document_versions` (the seed
 * syncs content/legal with requisites already substituted).
 *
 * Choice of version for a kind:
 * 1. LEGAL_<KIND>_VERSION when set (the seed publishes exactly that version);
 * 2. otherwise the most recently published version;
 * 3. otherwise the latest draft, shown with a "черновик" banner.
 */
import type { Env } from '@detaly/config';
import { LEGAL_VERSION_ENV, type Executor } from '@detaly/db';
import type { DocumentKind } from '@detaly/domain';

export interface LegalDocument {
  /** document_versions.id: consents.document_version_id, orders.offer_version_id. */
  id: string;
  kind: DocumentKind;
  version: string;
  title: string;
  bodyMd: string;
  sha256: string;
  publishedAt: Date | null;
  /** Not published: pages show a draft banner. */
  isDraft: boolean;
}

/** URL slug -> document kind. */
export const DOC_SLUGS = {
  offer: 'offer',
  privacy: 'privacy',
  consent: 'consent_pd',
  'consent-marketing': 'consent_marketing',
  'return-memo': 'return_memo',
} as const satisfies Record<string, DocumentKind>;

export type DocSlug = keyof typeof DOC_SLUGS;

export function docKindForSlug(slug: string): DocumentKind | null {
  return Object.hasOwn(DOC_SLUGS, slug) ? DOC_SLUGS[slug as DocSlug] : null;
}

const COLUMNS = {
  id: true,
  kind: true,
  version: true,
  title: true,
  bodyMd: true,
  sha256: true,
  publishedAt: true,
} as const;

type Row = Omit<LegalDocument, 'isDraft'>;

function toDocument(row: Row | undefined): LegalDocument | null {
  return row ? { ...row, isDraft: row.publishedAt === null } : null;
}

export async function getPublishedDocument(
  kind: DocumentKind,
  { db, env }: { db: Executor; env: Env },
): Promise<LegalDocument | null> {
  const wanted = env[LEGAL_VERSION_ENV[kind]];
  if (wanted) {
    const row = await db.query.documentVersions.findFirst({
      columns: COLUMNS,
      where: (t, { and, eq }) => and(eq(t.kind, kind), eq(t.version, wanted)),
    });
    if (row) return toDocument(row);
  }
  const published = await db.query.documentVersions.findFirst({
    columns: COLUMNS,
    where: (t, { and, eq, isNotNull }) => and(eq(t.kind, kind), isNotNull(t.publishedAt)),
    orderBy: (t, { desc }) => [desc(t.publishedAt), desc(t.version)],
  });
  if (published) return toDocument(published);
  const draft = await db.query.documentVersions.findFirst({
    columns: COLUMNS,
    where: (t, { eq }) => eq(t.kind, kind),
    orderBy: (t, { desc }) => [desc(t.version), desc(t.createdAt)],
  });
  return toDocument(draft);
}
