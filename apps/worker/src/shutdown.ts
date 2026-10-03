// Graceful shutdown on SIGTERM/SIGINT. Compose gives the container 30 s (stop_grace_period),
// so the process force-exits after 25 s; a second signal exits at once with code 1.
import type { Logger } from '@detaly/config';

export interface Closable {
  close(): Promise<unknown>;
}

export interface RedisLike {
  status: string;
  quit(): Promise<unknown>;
  disconnect(): void;
}

/** A long-polling bot (seller, client): `name` labels its shutdown step (`<name>.stop`). */
export interface StoppableBot {
  name?: string;
  stop(): Promise<unknown>;
}

export interface ShutdownResources {
  /** Bots stop first and in parallel, each within its own step cap (phase 1C: two bots). */
  bots?: readonly StoppableBot[];
  /** Outbox dispatcher: stopped before the queues close (it adds jobs to them). */
  dispatcher?: { stop(): Promise<unknown> } | null;
  workers: readonly Closable[];
  queues: readonly Closable[];
  redis: readonly RedisLike[];
  /** Postgres pool: Db.close() ends the postgres-js client (sql.end). */
  sql?: { close(): Promise<unknown> } | null;
}

export const SHUTDOWN_TIMEOUT_MS = 25_000;
/** One slow step (a bot's stop needs the Telegram API) must not eat the whole budget. */
export const SHUTDOWN_STEP_TIMEOUT_MS = 8_000;

type SignalSource = Pick<NodeJS.Process, 'on' | 'off'>;

export interface InstallShutdownOptions {
  resources: ShutdownResources;
  logger: Pick<Logger, 'info' | 'warn' | 'error'>;
  timeoutMs?: number;
  stepTimeoutMs?: number;
  /** process.exit by default (tests pass a spy). */
  exit?: (code: number) => void;
  /** process by default (tests pass an EventEmitter). */
  proc?: SignalSource;
  signals?: readonly NodeJS.Signals[];
}

export interface ShutdownHandle {
  /** Runs the shutdown as if `signal` had arrived. */
  shutdown(signal: string): Promise<void>;
  /** True once a signal (or shutdown()) has started the shutdown. */
  isShuttingDown(): boolean;
  uninstall(): void;
}

function settleWithin(promise: Promise<unknown>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
    timer.unref();
  });
  return Promise.race([promise, timeout])
    .then(() => undefined)
    .finally(() => clearTimeout(timer));
}

function quitRedis(client: RedisLike): Promise<unknown> {
  // quit() on a client that is not connected would wait in the offline queue.
  if (client.status === 'ready') return client.quit();
  client.disconnect();
  return Promise.resolve();
}

/**
 * Order: bots stop (in parallel) → dispatcher.stop → worker.close (waits for running jobs) → queue.close →
 * redis.quit → sql.end. A failing step is logged and the next one still runs.
 */
export function installShutdown({
  resources,
  logger,
  timeoutMs = SHUTDOWN_TIMEOUT_MS,
  stepTimeoutMs = SHUTDOWN_STEP_TIMEOUT_MS,
  exit = (code) => process.exit(code),
  proc = process,
  signals = ['SIGTERM', 'SIGINT'],
}: InstallShutdownOptions): ShutdownHandle {
  let running: Promise<void> | null = null;

  const step = async (name: string, action: () => Promise<unknown>, limitMs = stepTimeoutMs) => {
    try {
      await settleWithin(action(), limitMs);
    } catch (error) {
      logger.error({ step: name, err: error }, 'shutdown step failed');
    }
  };

  const run = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'shutdown started');
    const hardExit = setTimeout(() => {
      logger.error({ timeoutMs }, 'shutdown timed out, forcing exit');
      exit(1);
    }, timeoutMs);
    hardExit.unref();

    const { bots = [], dispatcher, workers, queues, redis, sql } = resources;
    await Promise.all(bots.map((bot) => step(`${bot.name ?? 'bot'}.stop`, () => bot.stop())));
    if (dispatcher) await step('dispatcher.stop', () => dispatcher.stop());
    // Running jobs may take a while: workers get the remaining budget, not the step cap.
    await step('worker.close', () => Promise.all(workers.map((w) => w.close())), timeoutMs);
    await step('queue.close', () => Promise.all(queues.map((q) => q.close())));
    await step('redis.quit', () => Promise.all(redis.map(quitRedis)));
    if (sql) await step('sql.end', () => sql.close());

    clearTimeout(hardExit);
    logger.info({ signal }, 'shutdown complete');
    exit(0);
  };

  const onSignal = (signal: NodeJS.Signals) => {
    if (running) {
      logger.warn({ signal }, 'second signal during shutdown, exiting now');
      exit(1);
      return;
    }
    running = run(signal);
  };

  for (const signal of signals) proc.on(signal, onSignal);

  return {
    shutdown(signal) {
      running ??= run(signal);
      return running;
    },
    isShuttingDown() {
      return running !== null;
    },
    uninstall() {
      for (const signal of signals) proc.off(signal, onSignal);
    },
  };
}
