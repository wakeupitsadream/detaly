/**
 * Checks logged once when the web server starts (src/instrumentation.ts). They warn and never
 * stop the process: a misconfiguration here degrades protection but the site still works.
 */
import type { Env } from '@detaly/config';
import { paymentsEnabled, parseWebhookIpAllowlist, type PaymentsEnv } from '@detaly/payments';

export interface StartupLogger {
  warn: (obj: object, msg: string) => void;
}

export type StartupWarning =
  'untrusted_client_ip' | 'yookassa_webhooks_refused' | 'yookassa_allowlist_invalid';

/** What the checks read; the payment keys are optional so callers may pass a partial env. */
export type StartupEnv = Pick<Env, 'NODE_ENV' | 'TRUSTED_IP_HEADER'> &
  Partial<
    Pick<
      PaymentsEnv,
      'YOOKASSA_SHOP_ID' | 'YOOKASSA_SECRET_KEY' | 'YOOKASSA_VAT_CODE' | 'YOOKASSA_TAX_SYSTEM_CODE'
    > &
      Pick<Env, 'YOOKASSA_WEBHOOK_IP_ALLOWLIST'>
  >;

function allowlistValid(list: readonly string[]): boolean {
  try {
    return parseWebhookIpAllowlist(list).size > 0;
  } catch {
    return false;
  }
}

export function startupWarnings(env: StartupEnv): StartupWarning[] {
  const warnings: StartupWarning[] = [];
  if (env.NODE_ENV !== 'production') return warnings;
  // Without the trusted proxy header every client shares the 'local' rate-limit bucket and
  // consents.ip is stored empty (runbook section 9).
  if (env.TRUSTED_IP_HEADER === 'none') warnings.push('untrusted_client_ip');

  const payments = paymentsEnabled({
    YOOKASSA_SHOP_ID: env.YOOKASSA_SHOP_ID,
    YOOKASSA_SECRET_KEY: env.YOOKASSA_SECRET_KEY,
    YOOKASSA_VAT_CODE: env.YOOKASSA_VAT_CODE,
    YOOKASSA_TAX_SYSTEM_CODE: env.YOOKASSA_TAX_SYSTEM_CODE,
    YOOKASSA_API_URL: '',
  });
  if (payments) {
    const list = env.YOOKASSA_WEBHOOK_IP_ALLOWLIST ?? [];
    // Decision Б4: the webhook trusts X-Real-IP only behind Caddy and only allowlisted
    // addresses; otherwise every YooKassa notification is refused (reconciliation still
    // catches payments, ten minutes late).
    if (env.TRUSTED_IP_HEADER === 'none' || list.length === 0) {
      warnings.push('yookassa_webhooks_refused');
    } else if (!allowlistValid(list)) {
      warnings.push('yookassa_allowlist_invalid');
    }
  }
  return warnings;
}

const MESSAGES: Record<StartupWarning, string> = {
  untrusted_client_ip:
    'TRUSTED_IP_HEADER=none in production: all clients share one rate-limit bucket and consent IPs are not recorded; set TRUSTED_IP_HEADER=x-real-ip behind the reverse proxy',
  yookassa_webhooks_refused:
    'Online payments are enabled but TRUSTED_IP_HEADER=none or YOOKASSA_WEBHOOK_IP_ALLOWLIST is empty: every YooKassa webhook will be refused with 403 (payments are confirmed only by reconciliation); set TRUSTED_IP_HEADER=x-real-ip and the YooKassa networks',
  yookassa_allowlist_invalid:
    'YOOKASSA_WEBHOOK_IP_ALLOWLIST has an invalid entry: every YooKassa webhook will be refused with 403; fix the list',
};

export function logStartupWarnings(env: StartupEnv, logger: StartupLogger): StartupWarning[] {
  const warnings = startupWarnings(env);
  for (const warning of warnings) logger.warn({ check: warning }, MESSAGES[warning]);
  return warnings;
}
