// Replies the seller bot waits for (decision С25, docs/phase-1c-implementation.md section 9): a
// press that needs text or a photo sends a ForceReply prompt and remembers here what the answer
// is about. Only a reply of the same user to that prompt counts (an ordinary message in the
// sellers chat does nothing), within 10 minutes, once (GETDEL). One wait per chat and user: a
// newer prompt replaces the older one. The wait lives in Redis, so a worker restart in between
// does not lose it.
//
// The value holds ids (order, claim, VIN request, prompt message) and, between the two prompts of
// the owner's «Вернуть деньги» without «Принял возврат», the override reason he typed (it ends
// up in claims.override_reason anyway). Never the client's texts, phones or tokens.
import type { Redis } from '@detaly/config';

export const AWAIT_TTL_SEC = 10 * 60;

/** `<prefix>seller:await:<chat>:<user>` (phase 1B section 13.1, decision С25). */
export function awaitKey(keyPrefix: string, chatId: number, userId: number): string {
  return `${keyPrefix}seller:await:${chatId}:${userId}`;
}

/** Claim decisions that take the answer text (cref / crepl / crej). */
export type ClaimTextCode = 'cref' | 'crepl' | 'crej';

export type Awaiting =
  /** «Счёт оплачен» (owner): the number and date of the payment order. */
  | { kind: 'invoice'; orderId: string; promptMessageId: number }
  /** «Фото упаковки» (pphoto) or «Принял возврат» (cret): a photo. */
  | {
      kind: 'photo';
      purpose: 'packaging' | 'return';
      orderId: string;
      claimId: string | null;
      promptMessageId: number;
    }
  /** «Вернуть деньги» of the owner without «Принял возврат»: the override reason first. */
  | { kind: 'claim_reason'; orderId: string; claimId: string; promptMessageId: number }
  /** The answer to the client of a claim decision. */
  | {
      kind: 'claim_text';
      code: ClaimTextCode;
      orderId: string;
      claimId: string;
      /** The owner's override reason (cref without «Принял возврат»), asked before. */
      reason: string | null;
      promptMessageId: number;
    }
  /** «Ответить строками» / «Исправить»: the lines of the master's answer. */
  | { kind: 'vin_answer'; vinRequestId: string; promptMessageId: number }
  /** «Закрыть заявку»: the reason. */
  | { kind: 'vin_close'; vinRequestId: string; promptMessageId: number };

export type AwaitingKind = Awaiting['kind'];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function uuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

/** Parses a stored wait; anything malformed is no wait. */
export function parseAwaiting(raw: string | null): Awaiting | null {
  if (raw === null) return null;
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const promptMessageId = value.promptMessageId;
  if (typeof promptMessageId !== 'number' || !Number.isSafeInteger(promptMessageId)) return null;
  // Phase 1B values carry no kind: «Счёт оплачен».
  const kind: unknown = value.kind ?? 'invoice';
  switch (kind) {
    case 'invoice':
      return uuid(value.orderId)
        ? { kind: 'invoice', orderId: value.orderId, promptMessageId }
        : null;
    case 'photo':
      if (!uuid(value.orderId)) return null;
      if (value.purpose === 'packaging') {
        return {
          kind: 'photo',
          purpose: 'packaging',
          orderId: value.orderId,
          claimId: null,
          promptMessageId,
        };
      }
      if (value.purpose === 'return' && uuid(value.claimId)) {
        return {
          kind: 'photo',
          purpose: 'return',
          orderId: value.orderId,
          claimId: value.claimId,
          promptMessageId,
        };
      }
      return null;
    case 'claim_reason':
      return uuid(value.orderId) && uuid(value.claimId)
        ? { kind: 'claim_reason', orderId: value.orderId, claimId: value.claimId, promptMessageId }
        : null;
    case 'claim_text': {
      const code = value.code;
      if (code !== 'cref' && code !== 'crepl' && code !== 'crej') return null;
      if (!uuid(value.orderId) || !uuid(value.claimId)) return null;
      const reason = typeof value.reason === 'string' ? value.reason : null;
      return {
        kind: 'claim_text',
        code,
        orderId: value.orderId,
        claimId: value.claimId,
        reason,
        promptMessageId,
      };
    }
    case 'vin_answer':
    case 'vin_close':
      return uuid(value.vinRequestId)
        ? {
            kind: kind as 'vin_answer' | 'vin_close',
            vinRequestId: value.vinRequestId,
            promptMessageId,
          }
        : null;
    default:
      return null;
  }
}

export interface AwaitStore {
  redis: Pick<Redis, 'set' | 'get' | 'getdel'>;
  keyPrefix: string;
}

export async function setAwaiting(
  store: AwaitStore,
  chatId: number,
  userId: number,
  value: Awaiting,
): Promise<void> {
  await store.redis.set(
    awaitKey(store.keyPrefix, chatId, userId),
    JSON.stringify(value),
    'EX',
    AWAIT_TTL_SEC,
  );
}

/**
 * The wait of this user when `replyToMessageId` answers its prompt, taken once (GETDEL); null
 * for no wait, a message that is not a reply to the prompt (the wait goes on until its TTL), a
 * wait of another kind, or a second reply (taken already).
 */
export async function takeAwaiting<K extends AwaitingKind>(
  store: AwaitStore,
  chatId: number,
  userId: number,
  replyToMessageId: number | undefined,
  kinds: readonly K[],
): Promise<Extract<Awaiting, { kind: K }> | null> {
  const key = awaitKey(store.keyPrefix, chatId, userId);
  const awaiting = parseAwaiting(await store.redis.get(key));
  if (
    awaiting === null ||
    replyToMessageId === undefined ||
    awaiting.promptMessageId !== replyToMessageId ||
    !(kinds as readonly string[]).includes(awaiting.kind)
  ) {
    return null;
  }
  // Taken once: a second reply (or a racing update) finds nothing. A prompt sent in between
  // replaced the wait: that one is not this reply's.
  const taken = parseAwaiting(await store.redis.getdel(key));
  if (
    taken === null ||
    taken.promptMessageId !== replyToMessageId ||
    taken.kind !== awaiting.kind
  ) {
    return null;
  }
  return taken as Extract<Awaiting, { kind: K }>;
}
