// Liveness checks shared by the compose healthcheck and the seller bot's /ping.
import { HEARTBEAT_KEY, readHeartbeatAgeSec, type Redis } from '@detaly/config';
import type { PingData } from '@detaly/notify';

/** The compose healthcheck fails when the heartbeat is this old (the scheduler writes every 30 s). */
export const HEALTHCHECK_MAX_AGE_SEC = 120;

export interface HeartbeatCheck {
  ok: boolean;
  ageSec: number | null;
}

export async function checkHeartbeat(
  redis: Redis,
  {
    now = new Date(),
    key = HEARTBEAT_KEY,
    maxAgeSec = HEALTHCHECK_MAX_AGE_SEC,
  }: { now?: Date; key?: string; maxAgeSec?: number } = {},
): Promise<HeartbeatCheck> {
  const ageSec = await readHeartbeatAgeSec(redis, { now, key });
  return { ok: ageSec !== null && ageSec < maxAgeSec, ageSec };
}

/** Rejects after `ms` (the probe must answer even when Redis or Postgres hangs). */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export interface HealthProbeDeps {
  redis: Redis;
  /** Runs a trivial query (`select 1`); rejects when the database is unavailable. */
  pingDb: () => Promise<unknown>;
  gitSha: string | null;
  heartbeatKey?: string;
  timeoutMs?: number;
}

/** Data for the /ping answer; never throws. */
export function createHealthProbe({
  redis,
  pingDb,
  gitSha,
  heartbeatKey = HEARTBEAT_KEY,
  timeoutMs = 3000,
}: HealthProbeDeps): () => Promise<PingData> {
  return async () => {
    const [heartbeat, db] = await Promise.allSettled([
      withTimeout(readHeartbeatAgeSec(redis, { key: heartbeatKey }), timeoutMs),
      withTimeout(pingDb(), timeoutMs),
    ]);
    return {
      heartbeatAgeSec: heartbeat.status === 'fulfilled' ? heartbeat.value : null,
      dbOk: db.status === 'fulfilled',
      gitSha,
    };
  };
}
