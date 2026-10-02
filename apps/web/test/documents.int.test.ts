// getPublishedDocument against the seeded test database: env version first, then the latest
// published version, then the latest draft.
import { createDb, documentVersions, sha256Hex, type Db } from '@detaly/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { docKindForSlug, getPublishedDocument } from '@/server/documents';
import { intEnv, webDatabaseUrl } from './helpers';

let db: Db;

beforeAll(() => {
  db = createDb(webDatabaseUrl(), { max: 2 });
});

afterAll(async () => {
  // Remove the rows this file inserted (the seed only creates *-d1 versions).
  await db.$client`delete from document_versions where version like 'web-test-%'`;
  await db.close();
});

function row(kind: 'privacy' | 'consent_marketing', version: string, publishedAt: Date | null) {
  const bodyMd = `# ${kind} ${version}\n\nТекст.\n`;
  return {
    kind,
    version,
    title: `${kind} ${version}`,
    bodyMd,
    sha256: sha256Hex(bodyMd),
    sourcePath: `test/${kind}/${version}.md`,
    publishedAt,
  };
}

describe('docKindForSlug', () => {
  it('maps public slugs to document kinds', () => {
    expect(docKindForSlug('offer')).toBe('offer');
    expect(docKindForSlug('privacy')).toBe('privacy');
    expect(docKindForSlug('consent')).toBe('consent_pd');
    expect(docKindForSlug('return-memo')).toBe('return_memo');
    expect(docKindForSlug('consent_pd')).toBeNull();
    expect(docKindForSlug('__proto__')).toBeNull();
  });
});

describe('getPublishedDocument', () => {
  it('shows the seeded draft when nothing is published', async () => {
    const doc = await getPublishedDocument('offer', { db, env: intEnv() });
    expect(doc).toMatchObject({ kind: 'offer', version: '2026-10-d1', isDraft: true });
    expect(doc?.bodyMd).toContain('# ');
  });

  it('prefers the latest published version over newer drafts', async () => {
    await db
      .insert(documentVersions)
      .values([
        row('privacy', 'web-test-a', new Date('2026-10-01T00:00:00Z')),
        row('privacy', 'web-test-b', new Date('2026-10-02T00:00:00Z')),
        row('privacy', 'web-test-z', null),
      ]);
    const doc = await getPublishedDocument('privacy', { db, env: intEnv() });
    expect(doc).toMatchObject({ version: 'web-test-b', isDraft: false });
  });

  it('takes LEGAL_<KIND>_VERSION first, even when another version was published later', async () => {
    await db
      .insert(documentVersions)
      .values([
        row('consent_marketing', 'web-test-old', new Date('2026-10-01T00:00:00Z')),
        row('consent_marketing', 'web-test-new', new Date('2026-10-02T00:00:00Z')),
      ]);
    const pinned = await getPublishedDocument('consent_marketing', {
      db,
      env: intEnv({ LEGAL_CONSENT_MARKETING_VERSION: 'web-test-old' }),
    });
    expect(pinned).toMatchObject({ version: 'web-test-old', isDraft: false });

    // An env version without a row falls back to the latest published one.
    const missing = await getPublishedDocument('consent_marketing', {
      db,
      env: intEnv({ LEGAL_CONSENT_MARKETING_VERSION: 'web-test-missing' }),
    });
    expect(missing).toMatchObject({ version: 'web-test-new' });
  });
});
