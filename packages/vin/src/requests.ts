/**
 * A client's VIN request from the /vin form (docs/phase-1c-implementation.md decisions С12, С20).
 *
 * One transaction: the user (upsert by phone, no name), the consent to PD processing (kind pd,
 * channel web, vin_request_id, sha256 of the accepted text), the vin_requests row (status new)
 * and two outbox rows of notify/vin: the sellers card and `vin_received` to the client. A repeated
 * submit with the same request_key returns the first request and writes nothing.
 *
 * Photos: the caller ingests and stores them before the request exists, under keys
 * `vin/<id>/<uuid>.jpg` of an id it generated with newVinRequestId() and passes as `id`. On a
 * duplicate submit (`duplicate: true`) those uploads belong to nobody and the caller deletes them.
 *
 * Nothing is logged here; the caller logs only the request id (and maskVin) and calls its outbox
 * nudge after this resolves.
 */
import { isIP } from 'node:net';
import { NOTIFY_JOBS, QUEUE } from '@detaly/config';
import { consents, eq, users, vinRequests, type Database, type Executor } from '@detaly/db';
import {
  FILE_KEY_PATTERN,
  normalizeMobilePhone,
  VIN_CAR_TEXT_MAX,
  VIN_NEED_TEXT_MAX,
  VIN_PHOTOS_MAX,
  type VinNotifyTemplate,
} from '@detaly/domain';
import { enqueueOutbox } from '@detaly/orders';
import { v7 as uuidv7 } from 'uuid';
import { VinRequestInputError } from './errors';
import { normalizeVin } from './vin';

/** Shortest «что нужно», characters (decision С12). */
export const VIN_NEED_TEXT_MIN = 3;
/** User-Agent kept with the consent, characters. */
const USER_AGENT_MAX = 512;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const FILE_KEY_RE = new RegExp(FILE_KEY_PATTERN);

/** Answer channels a client can choose in 1C (MAX is shown as «скоро», decision С1). */
export const VIN_ANSWER_CHANNELS = ['telegram', 'sms'] as const;
export type VinAnswerChannel = (typeof VIN_ANSWER_CHANNELS)[number];

/** Ids, VINs and keys from forms, bots and job data are checked before they reach SQL. */
export function isUuidString(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

/** A new request id (uuid v7) for photo keys written before createVinRequest. */
export function newVinRequestId(): string {
  return uuidv7();
}

/** Short number of a request for people ('A1B2C3'): the last 6 hex digits of the id. */
export function vinRequestNumber(id: string): string {
  return id.replace(/-/g, '').slice(-6).toUpperCase();
}

/** Outbox key of the sellers card of a request; `n` grows with every repost (reminder, refresh). */
export function vinCardKey(vinRequestId: string, n: number | string = 0): string {
  return `vin:${vinRequestId}:card:${n}`;
}

/** Outbox key of a client message; `n` is the proposal number (0 for vin_received). */
export function vinClientKey(vinRequestId: string, template: VinNotifyTemplate, n: number): string {
  return `vin:${vinRequestId}:${template}:${n}`;
}

/** notify/vin job data (apps/worker/src/jobs/notify/vin.ts NotifyVinJobData). */
export type VinNotifyJob =
  | { vinRequestId: string; audience: 'sellers'; key: string; note?: string | null }
  | {
      vinRequestId: string;
      audience: 'client';
      template: VinNotifyTemplate;
      key: string;
      n: number;
    };

/** Writes a notify/vin outbox row; false when the key was queued already. */
export async function enqueueVinNotify(
  tx: Executor,
  job: VinNotifyJob,
  availableAt?: Date,
): Promise<boolean> {
  return enqueueOutbox(tx, {
    queue: QUEUE.notify,
    name: NOTIFY_JOBS.vin,
    key: job.key,
    data: { ...job },
    ...(availableAt ? { availableAt } : {}),
  });
}

export interface VinConsentInput {
  /** document_versions.id of the consent_pd text the form showed. */
  documentVersionId: string;
  /** sha256 (hex) of that text. */
  textSha256: string;
  ip: string | null;
  userAgent: string | null;
}

export interface CreateVinRequestInput {
  /** Pre-generated id (newVinRequestId) when photos were stored first; else a new uuid v7. */
  id?: string;
  /** As typed: normalized with normalizeVin (spaces, Cyrillic look-alikes). */
  vin: string;
  carText: string | null;
  needText: string;
  /** As typed: normalized with normalizeMobilePhone. */
  phone: string;
  channel: VinAnswerChannel;
  /** FileStore keys `vin/<id>/<uuid>.jpg`, at most VIN_PHOTOS_MAX. */
  photoKeys: readonly string[];
  consent: VinConsentInput;
  /** Idempotency key of the form (uuid). */
  requestKey: string;
  now: Date;
}

export interface CreateVinRequestResult {
  vinRequestId: string;
  userId: string;
  /** The request_key was submitted before: nothing was written, the first request is returned. */
  duplicate: boolean;
}

interface ValidInput {
  id: string;
  vin: string;
  carText: string | null;
  needText: string;
  phone: string;
  channel: VinAnswerChannel;
  photoKeys: string[];
  consent: VinConsentInput;
  requestKey: string;
  now: Date;
}

function validate(input: CreateVinRequestInput): ValidInput {
  const id = input.id ?? uuidv7();
  if (!isUuidString(id)) throw new VinRequestInputError('id');
  if (!isUuidString(input.requestKey?.toLowerCase())) {
    throw new VinRequestInputError('request_key');
  }
  const vin = typeof input.vin === 'string' ? normalizeVin(input.vin) : null;
  if (vin === null) throw new VinRequestInputError('vin');
  const carText = typeof input.carText === 'string' ? input.carText.trim() : '';
  if (carText.length > VIN_CAR_TEXT_MAX) throw new VinRequestInputError('car_text');
  const needText = typeof input.needText === 'string' ? input.needText.trim() : '';
  if (needText.length < VIN_NEED_TEXT_MIN || needText.length > VIN_NEED_TEXT_MAX) {
    throw new VinRequestInputError('need_text');
  }
  const phone = typeof input.phone === 'string' ? normalizeMobilePhone(input.phone) : null;
  if (phone === null) throw new VinRequestInputError('phone');
  if (!(VIN_ANSWER_CHANNELS as readonly string[]).includes(input.channel)) {
    throw new VinRequestInputError('channel');
  }
  const photoKeys = [...(input.photoKeys ?? [])];
  if (
    photoKeys.length > VIN_PHOTOS_MAX ||
    new Set(photoKeys).size !== photoKeys.length ||
    !photoKeys.every((key) => FILE_KEY_RE.test(key) && key.startsWith(`vin/${id}/`))
  ) {
    throw new VinRequestInputError('photos');
  }
  const consent = input.consent;
  if (
    !consent ||
    !isUuidString(consent.documentVersionId) ||
    typeof consent.textSha256 !== 'string' ||
    !SHA256_RE.test(consent.textSha256)
  ) {
    throw new VinRequestInputError('consent');
  }
  return {
    id,
    vin,
    carText: carText === '' ? null : carText,
    needText,
    phone,
    channel: input.channel,
    photoKeys,
    consent: {
      documentVersionId: consent.documentVersionId,
      textSha256: consent.textSha256,
      // inet rejects anything that is not an address; a bad one is not worth failing the form.
      ip: consent.ip && isIP(consent.ip) !== 0 ? consent.ip : null,
      userAgent: consent.userAgent ? consent.userAgent.slice(0, USER_AGENT_MAX) : null,
    },
    requestKey: input.requestKey.toLowerCase(),
    now: input.now,
  };
}

function pgCodeOf(error: unknown): { code?: string; constraint_name?: string } | null {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    if (typeof current === 'object' && current !== null && 'code' in current) {
      return current as { code?: string; constraint_name?: string };
    }
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

/**
 * The request of an earlier submit with the same key. A key reused with another phone is
 * rejected: the result leads to a messenger link for that request's user.
 */
async function findByRequestKey(
  db: Executor,
  requestKey: string,
  phone: string,
): Promise<CreateVinRequestResult | null> {
  const [row] = await db
    .select({ id: vinRequests.id, userId: vinRequests.userId, phone: vinRequests.phone })
    .from(vinRequests)
    .where(eq(vinRequests.requestKey, requestKey));
  if (!row) return null;
  if (row.phone !== phone || row.userId === null) throw new VinRequestInputError('request_key');
  return { vinRequestId: row.id, userId: row.userId, duplicate: true };
}

/** Creates the request (see the module comment). Throws VinRequestInputError for bad input. */
export async function createVinRequest(
  db: Database,
  input: CreateVinRequestInput,
): Promise<CreateVinRequestResult> {
  const valid = validate(input);
  const earlier = await findByRequestKey(db, valid.requestKey, valid.phone);
  if (earlier) return earlier;
  const at = valid.now;
  try {
    return await db.transaction(async (tx) => {
      const [user] = await tx
        .insert(users)
        .values({ phone: valid.phone })
        .onConflictDoUpdate({ target: users.phone, set: { updatedAt: at } })
        .returning({ id: users.id });
      if (!user) throw new Error('user upsert returned nothing');

      await tx.insert(vinRequests).values({
        id: valid.id,
        userId: user.id,
        phone: valid.phone,
        vin: valid.vin,
        carText: valid.carText,
        needText: valid.needText,
        photos: valid.photoKeys,
        status: 'new',
        resolver: 'manual',
        channel: valid.channel,
        requestKey: valid.requestKey,
        createdAt: at,
        updatedAt: at,
      });

      await tx.insert(consents).values({
        userId: user.id,
        documentVersionId: valid.consent.documentVersionId,
        kind: 'pd',
        givenAt: at,
        channel: 'web',
        ip: valid.consent.ip,
        userAgent: valid.consent.userAgent,
        textSha256: valid.consent.textSha256,
        vinRequestId: valid.id,
      });

      await enqueueVinNotify(tx, {
        vinRequestId: valid.id,
        audience: 'sellers',
        key: vinCardKey(valid.id, 0),
      });
      await enqueueVinNotify(tx, {
        vinRequestId: valid.id,
        audience: 'client',
        template: 'vin_received',
        key: vinClientKey(valid.id, 'vin_received', 0),
        n: 0,
      });
      return { vinRequestId: valid.id, userId: user.id, duplicate: false };
    });
  } catch (error) {
    const pg = pgCodeOf(error);
    if (pg?.code === '23505' && pg.constraint_name === 'vin_requests_request_key_unique') {
      // A concurrent submit of the same form won the race.
      const winner = await findByRequestKey(db, valid.requestKey, valid.phone);
      if (winner) return winner;
    }
    if (pg?.code === '23505' && pg.constraint_name === 'vin_requests_pkey') {
      throw new VinRequestInputError('id');
    }
    if (pg?.code === '23503' && pg.constraint_name?.startsWith('consents_document_version_id')) {
      throw new VinRequestInputError('consent');
    }
    throw error;
  }
}
