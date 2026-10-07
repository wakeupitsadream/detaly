// content/legal bundled for DEMO_MODE (scripts/gen-legal-bundle.ts) must stay in sync with the
// sources, and render like the seed renders them.
import { readFileSync } from 'node:fs';
import { parseEnv } from '@detaly/config';
import { DEFAULT_LEGAL_DIR, readLegalSources } from '@detaly/db';
import { DOCUMENT_KINDS } from '@detaly/domain';
import { describe, expect, it } from 'vitest';
import { BUNDLE_PATH, renderBundle } from '../scripts/gen-legal-bundle';
import { demoDocument } from '@/server/demo/documents';
import { LEGAL_BUNDLE } from '@/server/demo/legal-bundle';

const REQUISITES = {
  SELLER_REQUISITES_NAME: 'Тестов Тест Тестович',
  SELLER_REQUISITES_INN: '0'.repeat(12),
  SELLER_REQUISITES_OGRNIP: '0'.repeat(15),
  SELLER_REQUISITES_ADDRESS: 'г. Оренбург, ул. Тестовая, 1',
  SELLER_REQUISITES_EMAIL: 'seller@example.test',
  SELLER_REQUISITES_PHONE: '+7 900 000-00-00',
  PICKUP_ADDRESS: 'г. Оренбург, ул. Тестовая, 1',
};

function demoEnv(overrides: Record<string, string> = {}) {
  return parseEnv({
    SESSION_SECRET: 'test-session-secret-0123456789abcdef',
    DEMO_MODE: 'true',
    ...overrides,
  });
}

describe('legal bundle', () => {
  it('matches content/legal (run `pnpm --filter @detaly/web gen:legal` after editing it)', async () => {
    const sources = await readLegalSources(DEFAULT_LEGAL_DIR);
    expect(LEGAL_BUNDLE).toEqual(sources);
    expect(readFileSync(BUNDLE_PATH, 'utf8')).toBe(await renderBundle(sources));
  });

  it('covers every document kind', () => {
    for (const kind of DOCUMENT_KINDS) {
      expect(
        LEGAL_BUNDLE.some((source) => source.kind === kind),
        kind,
      ).toBe(true);
    }
  });
});

describe('demoDocument', () => {
  it('shows the latest version as a draft by default, with visible gaps', () => {
    const doc = demoDocument('offer', demoEnv());
    expect(doc).toMatchObject({ kind: 'offer', isDraft: true, publishedAt: null });
    expect(doc?.bodyMd).toContain('[не задано: SELLER_INN]');
    expect(doc?.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(doc?.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('publishes the selected version when every requisite is set', () => {
    const version = LEGAL_BUNDLE.find((source) => source.kind === 'offer')!.version;
    // The bundled texts still carry the lawyer's draft banner: publishing them needs the
    // explicit LEGAL_ALLOW_DRAFT_PUBLISH, otherwise the draft is shown.
    const base = { ...REQUISITES, BRAND_NAME: 'Бренд', LEGAL_OFFER_VERSION: version };
    expect(demoDocument('offer', demoEnv(base))?.isDraft).toBe(true);
    const env = demoEnv({ ...base, LEGAL_ALLOW_DRAFT_PUBLISH: 'true' });
    const doc = demoDocument('offer', env);
    expect(doc).toMatchObject({ version, isDraft: false });
    expect(doc?.bodyMd).toContain(REQUISITES.SELLER_REQUISITES_INN);
    expect(doc?.bodyMd).not.toMatch(/\{\{|не задано/);
    // Without the requisites a publication would be incomplete: the draft is shown instead.
    expect(demoDocument('offer', demoEnv({ LEGAL_OFFER_VERSION: version }))?.isDraft).toBe(true);
  });

  it('returns null for a kind missing from the bundle', () => {
    expect(demoDocument('offer', demoEnv(), [])).toBeNull();
  });
});
