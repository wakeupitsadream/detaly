import type { Redis } from 'ioredis';

/** Worker liveness key; the value is the write time in epoch milliseconds. */
export const HEARTBEAT_KEY = 'detaly:heartbeat:worker';
/** Key TTL: a dead worker's heartbeat disappears after 10 minutes. */
export const HEARTBEAT_TTL_SEC = 600;

export interface HeartbeatOptions {
  now?: Date;
  key?: string;
}

export async function writeHeartbeat(
  redis: Redis,
  {
    now = new Date(),
    key = HEARTBEAT_KEY,
    ttlSec = HEARTBEAT_TTL_SEC,
  }: HeartbeatOptions & {
    ttlSec?: number;
  } = {},
): Promise<void> {
  await redis.set(key, String(now.getTime()), 'EX', ttlSec);
}

/** Seconds since the last heartbeat (floored, never negative), or null when absent/invalid. */
export async function readHeartbeatAgeSec(
  redis: Redis,
  { now = new Date(), key = HEARTBEAT_KEY }: HeartbeatOptions = {},
): Promise<number | null> {
  const raw = await redis.get(key);
  if (raw === null) return null;
  const at = Number(raw);
  if (!Number.isFinite(at)) return null;
  return Math.max(0, Math.floor((now.getTime() - at) / 1000));
}
