// Clients, legal documents and consents (152-FZ), messenger bindings, staff, settings,
// excluded (marked) goods.
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  char,
  index,
  inet,
  integer,
  jsonb,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { createdAt, id, namedCheck, tstz, updatedAt } from './columns';
import {
  consentChannel,
  consentKind,
  documentKind,
  excludedKind,
  messengerChannel,
  staffRole,
} from './enums';

/** Identity = phone (E.164). Anonymization sets phone to `anon:<id>` and clears name/email. */
export const users = pgTable(
  'users',
  {
    id: id(),
    phone: text().notNull(),
    name: text(),
    email: text(),
    noShowCount: integer().notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    anonymizedAt: tstz(),
  },
  (t) => [
    unique('users_phone_unique').on(t.phone),
    namedCheck('users', 'no_show_count', sql`${t.noShowCount} >= 0`),
    namedCheck('users', 'phone', sql`${t.phone} ~ '^(\\+[1-9][0-9]{6,14}|anon:.+)$'`),
  ],
);

/**
 * Legal texts synced from content/legal/<kind>/<version>.md by the seed, with requisites
 * already substituted. `sha256` is the hex digest of `body_md`. A published row is immutable.
 */
export const documentVersions = pgTable(
  'document_versions',
  {
    id: id(),
    kind: documentKind().notNull(),
    version: text().notNull(),
    title: text().notNull(),
    bodyMd: text().notNull(),
    sha256: char({ length: 64 }).notNull(),
    sourcePath: text().notNull(),
    publishedAt: tstz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('document_versions_kind_version_unique').on(t.kind, t.version),
    index('document_versions_kind_published_at_idx').on(t.kind, t.publishedAt),
    namedCheck('document_versions', 'sha256', sql`${t.sha256} ~ '^[0-9a-f]{64}$'`),
  ],
);

/** Proof of consent: which exact text (hash) was accepted, where and when. */
export const consents = pgTable(
  'consents',
  {
    id: id(),
    userId: uuid()
      .notNull()
      .references(() => users.id),
    documentVersionId: uuid()
      .notNull()
      .references(() => documentVersions.id),
    kind: consentKind().notNull(),
    givenAt: tstz().notNull().defaultNow(),
    channel: consentChannel().notNull(),
    ip: inet(),
    userAgent: text(),
    textSha256: char({ length: 64 }).notNull(),
    revokedAt: tstz(),
  },
  (t) => [
    index('consents_user_id_kind_idx').on(t.userId, t.kind),
    namedCheck('consents', 'text_sha256', sql`${t.textSha256} ~ '^[0-9a-f]{64}$'`),
  ],
);

/** Where to deliver client notifications. External ids are stored as text (TG ids exceed int4). */
export const messengerBindings = pgTable(
  'messenger_bindings',
  {
    id: id(),
    userId: uuid()
      .notNull()
      .references(() => users.id),
    channel: messengerChannel().notNull(),
    externalUserId: text().notNull(),
    chatId: text().notNull(),
    phoneConfirmedAt: tstz(),
    isPrimary: boolean().notNull().default(false),
    blockedAt: tstz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('messenger_bindings_channel_external_user_id_unique').on(t.channel, t.externalUserId),
    uniqueIndex('messenger_bindings_user_id_primary_unique')
      .on(t.userId)
      .where(sql`${t.isPrimary}`),
  ],
);

/** Sellers and the owner. Telegram/MAX ids fit in a JS number (< 2^53). */
export const staff = pgTable(
  'staff',
  {
    id: id(),
    name: text().notNull(),
    role: staffRole().notNull(),
    tgUserId: bigint({ mode: 'number' }),
    maxUserId: bigint({ mode: 'number' }),
    isActive: boolean().notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('staff_tg_user_id_unique').on(t.tgUserId),
    unique('staff_max_user_id_unique').on(t.maxUserId),
    namedCheck(
      'staff',
      'messenger_id',
      sql`${t.tgUserId} is not null or ${t.maxUserId} is not null`,
    ),
  ],
);

/** key -> jsonb value; typed by SettingsValues in @detaly/domain/types. */
export const settings = pgTable('settings', {
  key: text().primaryKey(),
  value: jsonb().notNull(),
  /** 'seed', 'admin' or a staff id. */
  updatedBy: text(),
  updatedAt: updatedAt(),
});

/** Marked goods filter (keyword grammar in ExcludedRule docs). */
export const excludedGroups = pgTable(
  'excluded_groups',
  {
    id: id(),
    kind: excludedKind().notNull(),
    pattern: text().notNull(),
    reason: text(),
    active: boolean().notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [
    unique('excluded_groups_kind_pattern_unique').on(t.kind, t.pattern),
    namedCheck('excluded_groups', 'pattern', sql`length(btrim(${t.pattern})) > 0`),
  ],
);
