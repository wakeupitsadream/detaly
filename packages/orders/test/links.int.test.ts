// Messenger links (decisions С3, С4; section 5.3): one-time deep-link tokens, the binding upsert
// with one primary binding per user, blocking and the order page status.
import { randomBytes } from 'node:crypto';
import { eq, linkTokens, messengerBindings, type Db } from '@detaly/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  bindMessenger,
  consumeLinkToken,
  createLinkToken,
  findBindingUser,
  isLinkToken,
  messengerStatus,
  setMessengerBlocked,
} from '../src';
import { assertNoPhone, DB_URL, eventsOf, openDb, seedOrder, T0 } from './helpers';

const HOUR = 3_600_000;

function tgId(): string {
  return String(1_000_000_000 + Math.floor(Math.random() * 1_000_000_000));
}

describe.skipIf(!DB_URL)('messenger links', () => {
  let db: Db;

  beforeAll(() => {
    db = openDb();
  });
  afterAll(async () => {
    await db?.close();
  });

  async function bindingsOf(userId: string) {
    return db.select().from(messengerBindings).where(eq(messengerBindings.userId, userId));
  }

  it('a token is 32 base64url characters, valid 24 hours and taken once', async () => {
    const seeded = await seedOrder(db, { status: 'confirmed' });
    const { token, expiresAt } = await createLinkToken(db, {
      userId: seeded.userId,
      orderId: seeded.orderId,
      channel: 'telegram',
      now: T0,
    });
    expect(token).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(isLinkToken(token)).toBe(true);
    expect(expiresAt.getTime()).toBe(T0.getTime() + 24 * HOUR);

    const first = await consumeLinkToken(db, {
      token,
      externalUserId: '111',
      now: new Date(T0.getTime() + HOUR),
    });
    expect(first).toEqual({ userId: seeded.userId, orderId: seeded.orderId, channel: 'telegram' });
    // A second account pressing the same link: already used.
    expect(
      await consumeLinkToken(db, {
        token,
        externalUserId: '222',
        now: new Date(T0.getTime() + HOUR),
      }),
    ).toBeNull();
    const [row] = await db.select().from(linkTokens).where(eq(linkTokens.token, token));
    expect(row).toMatchObject({ usedByExternalId: '111' });
  });

  it('an expired, unknown or malformed token gives null', async () => {
    const seeded = await seedOrder(db, { status: 'confirmed' });
    const { token } = await createLinkToken(db, {
      userId: seeded.userId,
      channel: 'telegram',
      now: T0,
    });
    expect(
      await consumeLinkToken(db, {
        token,
        externalUserId: '1',
        now: new Date(T0.getTime() + 24 * HOUR),
      }),
    ).toBeNull();
    // The 64-character limit of the mask (Telegram /start payload): 64 is looked up, 65 is not.
    const sixtyFour = randomBytes(48).toString('base64url');
    expect(sixtyFour).toHaveLength(64);
    expect(isLinkToken(sixtyFour)).toBe(true);
    expect(
      await consumeLinkToken(db, { token: sixtyFour, externalUserId: '1', now: T0 }),
    ).toBeNull();
    expect(isLinkToken(`${sixtyFour}A`)).toBe(false);
    expect(
      await consumeLinkToken(db, { token: `${sixtyFour}A`, externalUserId: '1', now: T0 }),
    ).toBeNull();
    expect(await consumeLinkToken(db, { token: 'bad token!', externalUserId: '1' })).toBeNull();
    expect(await consumeLinkToken(db, { token, externalUserId: '' })).toBeNull();
  });

  it('a token for someone else’s order is refused', async () => {
    const a = await seedOrder(db, { status: 'confirmed' });
    const b = await seedOrder(db, { status: 'confirmed' });
    await expect(
      createLinkToken(db, { userId: a.userId, orderId: b.orderId, channel: 'telegram' }),
    ).rejects.toThrow();
  });

  it('binding: one primary per user, journal in the order, a re-bind moves the account', async () => {
    const a = await seedOrder(db, { status: 'confirmed' });
    const b = await seedOrder(db, { status: 'confirmed' });
    const first = tgId();
    const second = tgId();

    await bindMessenger(db, {
      userId: a.userId,
      orderId: a.orderId,
      channel: 'telegram',
      externalUserId: first,
      chatId: first,
      now: T0,
    });
    await bindMessenger(db, {
      userId: a.userId,
      channel: 'telegram',
      externalUserId: second,
      chatId: second,
      now: T0,
    });
    let rows = await bindingsOf(a.userId);
    expect(rows.map((r) => [r.externalUserId, r.isPrimary]).sort()).toEqual(
      [
        [first, false],
        [second, true],
      ].sort(),
    );
    expect(rows.every((r) => r.phoneConfirmedAt !== null && r.blockedAt === null)).toBe(true);
    const events = (await eventsOf(db, a.orderId)).filter((e) => e.type === 'messenger_bound');
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({ channel: 'telegram' });
    expect(JSON.stringify(events[0]?.payload)).not.toContain(first);
    assertNoPhone(events, a.phone);

    // The same Telegram account confirmed by another user's phone moves over.
    await bindMessenger(db, {
      userId: b.userId,
      orderId: b.orderId,
      channel: 'telegram',
      externalUserId: second,
      chatId: second,
      now: T0,
    });
    rows = await bindingsOf(a.userId);
    expect(rows.map((r) => r.externalUserId)).toEqual([first]);
    const moved = await bindingsOf(b.userId);
    expect(moved).toEqual([
      expect.objectContaining({ externalUserId: second, isPrimary: true, blockedAt: null }),
    ]);
    expect(await findBindingUser(db, { channel: 'telegram', externalUserId: second })).toEqual({
      userId: b.userId,
      blocked: false,
    });
  });

  it('/stop blocks, /start unblocks, a new binding clears the block; status for /o', async () => {
    const seeded = await seedOrder(db, { status: 'confirmed' });
    const id = tgId();
    expect(await messengerStatus(db, seeded.userId)).toEqual({ telegram: 'none', max: 'none' });
    await bindMessenger(db, {
      userId: seeded.userId,
      channel: 'telegram',
      externalUserId: id,
      chatId: id,
      now: T0,
    });
    expect(await messengerStatus(db, seeded.userId)).toEqual({ telegram: 'active', max: 'none' });

    expect(
      await setMessengerBlocked(db, {
        channel: 'telegram',
        externalUserId: id,
        blocked: true,
        now: T0,
      }),
    ).toBe(true);
    expect(await messengerStatus(db, seeded.userId)).toEqual({ telegram: 'blocked', max: 'none' });
    expect(await findBindingUser(db, { channel: 'telegram', externalUserId: id })).toEqual({
      userId: seeded.userId,
      blocked: true,
    });
    // Blocking again keeps the first moment.
    await setMessengerBlocked(db, {
      channel: 'telegram',
      externalUserId: id,
      blocked: true,
      now: new Date(T0.getTime() + HOUR),
    });
    const [row] = await bindingsOf(seeded.userId);
    expect(row?.blockedAt?.getTime()).toBe(T0.getTime());

    await setMessengerBlocked(db, { channel: 'telegram', externalUserId: id, blocked: false });
    expect(await messengerStatus(db, seeded.userId)).toEqual({ telegram: 'active', max: 'none' });

    await setMessengerBlocked(db, { channel: 'telegram', externalUserId: id, blocked: true });
    await bindMessenger(db, {
      userId: seeded.userId,
      channel: 'telegram',
      externalUserId: id,
      chatId: id,
    });
    expect(await messengerStatus(db, seeded.userId)).toEqual({ telegram: 'active', max: 'none' });

    expect(
      await setMessengerBlocked(db, { channel: 'telegram', externalUserId: tgId(), blocked: true }),
    ).toBe(false);
    expect(await findBindingUser(db, { channel: 'telegram', externalUserId: tgId() })).toBeNull();
  });
});
