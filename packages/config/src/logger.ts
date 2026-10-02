import pino, { type DestinationStream, type Logger, type LevelWithSilent } from 'pino';

export type { Logger };

/**
 * Paths removed from every log line: secrets and personal data (152-FZ minimisation).
 * Log order numbers and ids instead of phones, names and addresses.
 */
export const REDACT_PATHS = [
  'password',
  '*.password',
  'secret',
  '*.secret',
  'token',
  '*.token',
  'authorization',
  '*.authorization',
  'headers.authorization',
  'headers.cookie',
  '*.headers.authorization',
  '*.headers.cookie',
  'KEY1',
  'KEY2',
  '*.KEY1',
  '*.KEY2',
  'phone',
  '*.phone',
  'email',
  '*.email',
  'address',
  '*.address',
];

export interface CreateLoggerOptions {
  level?: LevelWithSilent;
  /** Extra fields on every line (e.g. { gitSha }). */
  base?: Record<string, unknown>;
  /** Custom destination (tests). Defaults to stdout. */
  destination?: DestinationStream;
}

/** JSON logger to stdout; `name` identifies the process or module (web, worker, rossko...). */
export function createLogger(name: string, options: CreateLoggerOptions = {}): Logger {
  const { level = 'info', base = {}, destination } = options;
  const config = {
    name,
    level,
    base: { ...base },
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    formatters: { level: (label: string) => ({ level: label }) },
    timestamp: pino.stdTimeFunctions.isoTime,
  };
  return destination ? pino(config, destination) : pino(config);
}
