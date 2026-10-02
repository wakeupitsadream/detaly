/**
 * Checks logged once when the web server starts (src/instrumentation.ts). They warn and never
 * stop the process: a misconfiguration here degrades protection but the site still works.
 */
import type { Env } from '@detaly/config';

export interface StartupLogger {
  warn: (obj: object, msg: string) => void;
}

export type StartupWarning = 'untrusted_client_ip';

export function startupWarnings(
  env: Pick<Env, 'NODE_ENV' | 'TRUSTED_IP_HEADER'>,
): StartupWarning[] {
  const warnings: StartupWarning[] = [];
  // Without the trusted proxy header every client shares the 'local' rate-limit bucket and
  // consents.ip is stored empty (runbook section 9).
  if (env.NODE_ENV === 'production' && env.TRUSTED_IP_HEADER === 'none') {
    warnings.push('untrusted_client_ip');
  }
  return warnings;
}

const MESSAGES: Record<StartupWarning, string> = {
  untrusted_client_ip:
    'TRUSTED_IP_HEADER=none in production: all clients share one rate-limit bucket and consent IPs are not recorded; set TRUSTED_IP_HEADER=x-real-ip behind the reverse proxy',
};

export function logStartupWarnings(
  env: Pick<Env, 'NODE_ENV' | 'TRUSTED_IP_HEADER'>,
  logger: StartupLogger,
): StartupWarning[] {
  const warnings = startupWarnings(env);
  for (const warning of warnings) logger.warn({ check: warning }, MESSAGES[warning]);
  return warnings;
}
