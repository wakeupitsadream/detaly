import { createLogger, type Logger } from '@detaly/config';
import { serverEnv } from './env';
import { singleton } from './globals';

export function getLogger(): Logger {
  return singleton('logger', () => {
    const env = serverEnv();
    return createLogger('web', { level: env.LOG_LEVEL, base: { gitSha: env.GIT_SHA } });
  });
}
