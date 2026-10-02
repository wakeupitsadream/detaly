import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installShutdown, type ShutdownResources } from '../src/shutdown';

function setup(
  overrides: Partial<ShutdownResources> = {},
  options: { stepTimeoutMs?: number } = {},
) {
  const order: string[] = [];
  const track = (name: string) => async () => {
    order.push(name);
  };
  const resources: ShutdownResources = {
    bot: { stop: track('bot.stop') },
    dispatcher: { stop: track('dispatcher.stop') },
    workers: [{ close: track('worker.close') }, { close: track('worker.close') }],
    queues: [{ close: track('queue.close') }],
    redis: [
      {
        status: 'ready',
        quit: track('redis.quit'),
        disconnect: () => order.push('redis.disconnect'),
      },
      {
        status: 'reconnecting',
        quit: track('redis.quit'),
        disconnect: () => order.push('redis.disconnect'),
      },
    ],
    sql: { close: track('sql.end') },
    ...overrides,
  };
  const proc = new EventEmitter();
  const exit = vi.fn<(code: number) => void>();
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const handle = installShutdown({
    resources,
    logger,
    exit,
    proc: proc as unknown as NodeJS.Process,
    ...options,
  });
  return { order, proc, exit, logger, handle };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

afterEach(() => {
  vi.useRealTimers();
});

describe('installShutdown', () => {
  it('closes everything in order on SIGTERM and exits with 0', async () => {
    const { order, proc, exit, logger } = setup();
    proc.emit('SIGTERM', 'SIGTERM');
    await vi.waitFor(() => expect(exit).toHaveBeenCalled());
    expect(order).toEqual([
      'bot.stop',
      'dispatcher.stop',
      'worker.close',
      'worker.close',
      'queue.close',
      'redis.quit',
      'redis.disconnect',
      'sql.end',
    ]);
    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
    expect(logger.info).toHaveBeenLastCalledWith({ signal: 'SIGTERM' }, 'shutdown complete');
  });

  it('handles SIGINT the same way and works without a bot', async () => {
    const { order, proc, exit } = setup({ bot: null });
    proc.emit('SIGINT', 'SIGINT');
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    expect(order[0]).toBe('dispatcher.stop');
  });

  it('stops the outbox dispatcher before the queues close', async () => {
    const { order, proc, exit } = setup({ bot: null, dispatcher: null });
    proc.emit('SIGTERM', 'SIGTERM');
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    expect(order[0]).toBe('worker.close');

    const second = setup();
    second.proc.emit('SIGTERM', 'SIGTERM');
    await vi.waitFor(() => expect(second.exit).toHaveBeenCalledWith(0));
    expect(second.order.indexOf('dispatcher.stop')).toBeLessThan(
      second.order.indexOf('queue.close'),
    );
  });

  it('exits with 1 on a second signal', async () => {
    let release!: () => void;
    const { proc, exit } = setup({
      workers: [{ close: () => new Promise<void>((r) => (release = r)) }],
    });
    proc.emit('SIGTERM', 'SIGTERM');
    await flush();
    proc.emit('SIGINT', 'SIGINT');
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    release();
  });

  it('keeps going when a step fails', async () => {
    const { order, proc, exit, logger } = setup({
      bot: {
        stop: async () => {
          throw new Error('telegram unreachable');
        },
      },
    });
    proc.emit('SIGTERM', 'SIGTERM');
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    expect(order).toContain('sql.end');
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ step: 'bot.stop' }),
      'shutdown step failed',
    );
  });

  it('caps a hanging step and moves on', async () => {
    const { order, proc, exit } = setup(
      { bot: { stop: () => new Promise(() => {}) } },
      { stepTimeoutMs: 20 },
    );
    proc.emit('SIGTERM', 'SIGTERM');
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    expect(order).toContain('worker.close');
  });

  it('forces exit 1 after 25 s', async () => {
    vi.useFakeTimers();
    const { proc, exit, logger } = setup({
      workers: [{ close: () => new Promise(() => {}) }],
    });
    proc.emit('SIGTERM', 'SIGTERM');
    await vi.advanceTimersByTimeAsync(24_999);
    expect(exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(exit).toHaveBeenCalledWith(1);
    expect(logger.error).toHaveBeenCalledWith(
      { timeoutMs: 25_000 },
      'shutdown timed out, forcing exit',
    );
  });

  it('uninstall() removes the signal listeners', () => {
    const { proc, handle } = setup();
    expect(proc.listenerCount('SIGTERM')).toBe(1);
    handle.uninstall();
    expect(proc.listenerCount('SIGTERM')).toBe(0);
    expect(proc.listenerCount('SIGINT')).toBe(0);
  });
});
