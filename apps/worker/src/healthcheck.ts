// Compose healthcheck: node --import tsx src/healthcheck.ts
// Exit 0 when the worker heartbeat is younger than 120 s, 1 otherwise (missing key,
// stale key, Redis unreachable). Reads only REDIS_URL, so it works with a partial env.
// An optional first argument overrides the key (tests use a `test:<uuid>:` key).
import { createRedis, HEARTBEAT_KEY } from '@detaly/config';
import { checkHeartbeat, HEALTHCHECK_MAX_AGE_SEC } from './health';

const HARD_TIMEOUT_MS = 8_000;

async function main(): Promise<number> {
  const url = process.env.REDIS_URL;
  if (!url) {
    console.error('healthcheck: REDIS_URL is not set');
    return 1;
  }
  const redis = createRedis(url, {
    connectTimeout: 5_000,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
    lazyConnect: true,
  });
  redis.on('error', () => {});
  try {
    await redis.connect();
    const { ok, ageSec } = await checkHeartbeat(redis, { key: process.argv[2] ?? HEARTBEAT_KEY });
    console.log(
      ok
        ? `healthcheck: ok, heartbeat ${ageSec}s`
        : `healthcheck: fail, heartbeat ${ageSec === null ? 'missing' : `${ageSec}s`} (limit ${HEALTHCHECK_MAX_AGE_SEC}s)`,
    );
    return ok ? 0 : 1;
  } catch (error) {
    console.error(`healthcheck: redis error: ${(error as Error).message}`);
    return 1;
  } finally {
    redis.disconnect();
  }
}

setTimeout(() => {
  console.error('healthcheck: timed out');
  process.exit(1);
}, HARD_TIMEOUT_MS).unref();

process.exit(await main());
