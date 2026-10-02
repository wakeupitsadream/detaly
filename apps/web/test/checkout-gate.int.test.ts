// getCheckoutGate against the seeded test database (decision Д4). The seed leaves every legal
// document as a draft; published rows are inserted only inside a rolled-back transaction, so
// documents.int.test.ts (which expects the seeded drafts) is not affected.
import { createDb, documentVersions, sha256Hex, type Db, type Executor } from '@detaly/db';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  CHECKOUT_CLOSED_DOCUMENTS_MESSAGE,
  getCheckoutGate,
  rknClosedMessage,
} from '@/server/checkout-gate';
import { intEnv, webDatabaseUrl } from './helpers';

let db: Db;

beforeAll(() => {
  db = createDb(webDatabaseUrl(), { max: 2 });
});

afterAll(async () => {
  await db.close();
});

class Rollback extends Error {}

/** Runs `fn` in a transaction that is always rolled back. */
async function inRolledBackTx<T>(fn: (tx: Executor) => Promise<T>): Promise<T> {
  let result: T | undefined;
  try {
    await db.transaction(async (tx) => {
      result = await fn(tx);
      throw new Rollback();
    });
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  }
  return result as T;
}

function published(
  kind: 'offer' | 'privacy' | 'consent_pd' | 'consent_marketing',
  version: string,
  publishedAt: Date | null = new Date('2026-10-01T00:00:00Z'),
) {
  const bodyMd = `# ${kind}\n\nОпубликованный текст.\n`;
  return {
    kind,
    version,
    title: kind,
    bodyMd,
    sha256: sha256Hex(bodyMd),
    sourcePath: `test/${kind}/${version}.md`,
    publishedAt,
  };
}

describe('getCheckoutGate', () => {
  it('is closed without RKN_NOTICE_NUMBER, with the phone of the point', async () => {
    const gate = await getCheckoutGate({
      env: intEnv({ RKN_NOTICE_NUMBER: undefined, PICKUP_PHONE: '+7 900 000-00-01' }),
      db,
    });
    expect(gate).toEqual({
      open: false,
      reason: 'rkn',
      message:
        'Онлайн-оформление откроется после регистрации оператора персональных данных. ' +
        'Пока заказать можно по телефону +7 900 000-00-01.',
    });
    expect(
      rknClosedMessage({ PICKUP_PHONE: undefined, SELLER_REQUISITES_PHONE: undefined }),
    ).toContain('по телефону пункта выдачи');
  });

  it('is open with the seeded drafts outside production', async () => {
    const gate = await getCheckoutGate({ env: intEnv({ RKN_NOTICE_NUMBER: 'TEST-1' }), db });
    expect(gate.open).toBe(true);
    if (!gate.open) return;
    expect(gate.docs.offer).toMatchObject({ kind: 'offer', isDraft: true });
    expect(gate.docs.privacy.kind).toBe('privacy');
    expect(gate.docs.consentPd).toMatchObject({ kind: 'consent_pd', version: '2026-10-d1' });
    expect(gate.docs.consentPd.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(gate.docs.consentPd.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(gate.docs.consentMarketing?.kind).toBe('consent_marketing');
  });

  it('is closed in production while the documents are drafts, and says so in the log', async () => {
    const warn = vi.fn();
    const gate = await getCheckoutGate({
      env: intEnv({ RKN_NOTICE_NUMBER: 'TEST-1', NODE_ENV: 'production' }),
      db,
      logger: { warn },
    });
    expect(gate).toEqual({
      open: false,
      reason: 'documents',
      message: CHECKOUT_CLOSED_DOCUMENTS_MESSAGE,
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatchObject({
      missing: expect.arrayContaining(['offer', 'consent_pd']),
    });
  });

  it('is open in production with published offer, privacy and PD consent', async () => {
    const gate = await inRolledBackTx(async (tx) => {
      await tx
        .insert(documentVersions)
        .values([
          published('offer', 'gate-test-1'),
          published('privacy', 'gate-test-1'),
          published('consent_pd', 'gate-test-1'),
          published('consent_marketing', 'gate-test-draft', null),
        ]);
      return getCheckoutGate({
        env: intEnv({
          RKN_NOTICE_NUMBER: 'TEST-1',
          NODE_ENV: 'production',
          // Pinned draft: other test files may publish marketing versions concurrently.
          LEGAL_CONSENT_MARKETING_VERSION: 'gate-test-draft',
        }),
        db: tx,
      });
    });
    expect(gate.open).toBe(true);
    if (!gate.open) return;
    expect(gate.docs.offer).toMatchObject({ version: 'gate-test-1', isDraft: false });
    expect(gate.docs.consentPd).toMatchObject({ version: 'gate-test-1', isDraft: false });
    // The marketing consent is optional and a draft does not count in production.
    expect(gate.docs.consentMarketing).toBeNull();
  });
});
