import { describe, expect, it } from 'vitest';
import { handleHealthRequest } from '@/server/api/health-handler';
import { computeHealth, type HealthDeps } from '@/server/health';

const never = () => new Promise<never>(() => {});

function deps(overrides: Partial<HealthDeps> = {}): HealthDeps {
  return {
    pingDb: () => Promise.resolve(1),
    pingRedis: () => Promise.resolve('PONG'),
    heartbeatAgeSec: () => Promise.resolve(12),
    staleSec: 300,
    version: 'abc123',
    timeoutMs: 50,
    now: () => new Date('2026-10-02T06:00:00Z'),
    ...overrides,
  };
}

describe('computeHealth', () => {
  it('is ok when db, redis and a fresh heartbeat are fine', async () => {
    const report = await computeHealth(deps());
    expect(report).toMatchObject({
      ok: true,
      version: 'abc123',
      checkedAt: '2026-10-02T06:00:00.000Z',
      db: { ok: true },
      redis: { ok: true },
      worker: { ok: true, ageSec: 12, staleSec: 300 },
    });
  });

  it('fails on a database timeout without waiting for it', async () => {
    const startedAt = Date.now();
    const report = await computeHealth(deps({ pingDb: never }));
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(report.ok).toBe(false);
    expect(report.db).toMatchObject({ ok: false, error: 'timeout' });
    expect(report.redis.ok).toBe(true);
  });

  it('fails on a redis error and reports the worker as unknown', async () => {
    const report = await computeHealth(
      deps({
        pingRedis: () => Promise.reject(new Error('ECONNREFUSED')),
        heartbeatAgeSec: () => Promise.reject(new Error('ECONNREFUSED')),
      }),
    );
    expect(report.ok).toBe(false);
    expect(report.redis).toMatchObject({ ok: false, error: 'error' });
    expect(report.worker).toMatchObject({ ok: false, error: 'error', ageSec: null });
  });

  it('fails when the heartbeat is missing or older than HEARTBEAT_STALE_SEC', async () => {
    const missing = await computeHealth(deps({ heartbeatAgeSec: () => Promise.resolve(null) }));
    expect(missing.worker).toMatchObject({ ok: false, error: 'missing' });
    expect(missing.ok).toBe(false);

    const atLimit = await computeHealth(deps({ heartbeatAgeSec: () => Promise.resolve(300) }));
    expect(atLimit.ok).toBe(true);

    const stale = await computeHealth(deps({ heartbeatAgeSec: () => Promise.resolve(301) }));
    expect(stale.worker).toMatchObject({ ok: false, error: 'stale', ageSec: 301 });
    expect(stale.ok).toBe(false);
  });

  it('does not leak error messages into the report', async () => {
    const report = await computeHealth(
      deps({ pingDb: () => Promise.reject(new Error('password authentication failed')) }),
    );
    expect(JSON.stringify(report)).not.toContain('password');
  });
});

describe('handleHealthRequest', () => {
  it('answers 200 with no-store when healthy and 503 otherwise', async () => {
    const ok = await handleHealthRequest(() => deps());
    expect(ok.status).toBe(200);
    expect(ok.headers.get('cache-control')).toContain('no-store');

    const bad = await handleHealthRequest(() =>
      deps({ heartbeatAgeSec: () => Promise.resolve(null) }),
    );
    expect(bad.status).toBe(503);
    expect(bad.headers.get('cache-control')).toContain('no-store');
  });

  it('answers 503 when the dependencies cannot be created (invalid env)', async () => {
    const response = await handleHealthRequest(() => {
      throw new Error('Invalid environment');
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ ok: false, error: 'config' });
  });
});
