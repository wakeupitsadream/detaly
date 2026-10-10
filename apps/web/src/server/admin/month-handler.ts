/**
 * POST /api/admin/month (step 7, docs/month-close.md) and GET /api/admin/month/csv.
 *
 * - `action=reconcile&month=YYYY-MM` — «Сверить с ЮKassa»: the month's payments and refunds
 *   listed by the provider against the database (runMonthReconciliation), stored as a
 *   finance_reconciliations row; a provider failure is part of the stored result and of the
 *   message, never a 500. Without YooKassa (YOOKASSA_*) the form is refused with a page.
 * - `action=rates` — «Сохранить ставки» of /admin/month/rates: the hidden kopecks and bp of the
 *   previewed draft, the version it was opened with and the «подтверждаю» tick, stored by the
 *   audited settings writer (settings-writer.ts: 409 when another tab saved meanwhile).
 * - GET csv?m=YYYY-MM — «Скачать CSV»: the act's operations (date, order, service, rate).
 *
 * Order of checks as in the other admin handlers: Basic auth -> Origin (403) -> urlencoded body
 * (400/413) -> action and fields (400/422) -> the work. Logs carry the month and the outcome.
 */
import type { Env } from '@detaly/config';
import type { Database } from '@detaly/db';
import {
  actCsv,
  CONTRACT_RATES_KEY,
  formatRub,
  monthTitle,
  parseContractRates,
  sameContractRates,
} from '@detaly/domain';
import {
  loadMonthReport,
  reconciliationDifferenceCount,
  runMonthReconciliation,
} from '@detaly/orders';
import type { PaymentProvider } from '@detaly/payments';
import { ADMIN_RESPONSE_HEADERS } from '../admin-auth';
import { readBoundedText } from '../body';
import { errorInfo } from '../errors';
import { isSameOrigin } from '../request-guards';
import { CONFIRM_FIELD, CONFIRM_VALUE } from './destructive';
import { formField } from './form-fields';
import { adminAuthFailure, adminDone, adminPage } from './http';
import { monthPath, parseMonthParam, postedMonth, ratesFromSaveForm } from './month';
import { ADMIN_ACTOR, writeAuditedSetting } from './settings-writer';

export const MAX_ADMIN_MONTH_BODY_BYTES = 8 * 1024;

export interface AdminMonthDeps {
  db: Database;
  env: Env;
  /** YooKassa of web (getPayments), null when payments are not configured. */
  provider: PaymentProvider | null;
  logger?: {
    info(details: Record<string, unknown>, message: string): void;
    error(details: Record<string, unknown>, message: string): void;
  };
  now?: () => Date;
}

export async function handleAdminMonthAction(
  request: Request,
  deps: AdminMonthDeps,
): Promise<Response> {
  try {
    return await handle(request, deps);
  } catch (error) {
    // Names and SQLSTATE only: a driver message carries the query parameters.
    deps.logger?.error({ ...errorInfo(error) }, 'admin month action failed');
    return adminPage(500, 'Не удалось выполнить — попробуйте ещё раз', {
      href: '/admin/month',
      label: 'К закрытию месяца',
    });
  }
}

async function handle(request: Request, deps: AdminMonthDeps): Promise<Response> {
  const denied = adminAuthFailure(request, deps.env);
  if (denied) return denied;
  const back = { href: '/admin/month', label: 'К закрытию месяца' };
  if (!isSameOrigin(request.headers, deps.env.APP_BASE_URL)) {
    return adminPage(
      403,
      'Запрос отклонён: форма открыта не с этого сайта. Обновите страницу',
      back,
    );
  }
  const type = (request.headers.get('content-type') ?? '').toLowerCase();
  if (!type.includes('application/x-www-form-urlencoded')) {
    return adminPage(400, 'Не удалось прочитать форму', back);
  }
  const body = await readBoundedText(request, MAX_ADMIN_MONTH_BODY_BYTES);
  if (!body.ok) return adminPage(413, 'Форма слишком большая', back);
  const form = new URLSearchParams(body.text);
  const now = (deps.now ?? (() => new Date()))();
  const month = postedMonth(formField(form, 'month', 7), now);
  if (month === null) return adminPage(400, 'Месяц не распознан', back);
  const action = formField(form, 'action', 16);

  if (action === 'reconcile') {
    const monthBack = { href: monthPath('/admin/month', month), label: 'К закрытию месяца' };
    if (deps.provider === null) {
      return adminPage(
        409,
        'ЮKassa не подключена (YOOKASSA_SHOP_ID и другие переменные): сверять не с чем',
        monthBack,
      );
    }
    const snapshot = await runMonthReconciliation({
      db: deps.db,
      provider: deps.provider,
      month,
      createdBy: ADMIN_ACTOR,
    });
    const { result } = snapshot;
    const differences = reconciliationDifferenceCount(result);
    deps.logger?.info(
      { action, month, differences, errors: result.errors.length, lookups: result.lookups },
      'admin month action',
    );
    const message =
      result.errors.length > 0
        ? `Сверка за ${monthTitle(month)} сохранена с ошибками ЮKassa: ${result.errors.join('; ')}`
        : `Сверка за ${monthTitle(month)} сохранена: расхождений ${differences}`;
    return adminDone(monthPath('/admin/month', month), message);
  }

  if (action === 'rates') {
    const ratesBack = {
      href: monthPath('/admin/month/rates', month),
      label: 'К ставкам договора',
    };
    if (form.get(CONFIRM_FIELD) !== CONFIRM_VALUE) {
      return adminPage(400, 'Отметьте «подтверждаю», чтобы сохранить ставки', ratesBack);
    }
    const rates = ratesFromSaveForm(form);
    const normal = rates === null ? null : parseContractRates(rates);
    if (normal === null) {
      return adminPage(422, 'Ставка — сумма в рублях, процент — от 0 до 100', ratesBack);
    }
    const outcome = await writeAuditedSetting(deps.db, {
      key: CONTRACT_RATES_KEY,
      value: normal,
      version: formField(form, 'version', 64),
      same: (stored) => {
        const parsed = parseContractRates(stored);
        return parsed !== null && sameContractRates(parsed, normal);
      },
      at: now,
    });
    deps.logger?.info({ action, month, outcome }, 'admin month action');
    if (outcome === 'conflict') {
      return adminPage(
        409,
        'Ставки уже изменили (в другой вкладке?) — откройте страницу заново и проверьте',
        ratesBack,
      );
    }
    if (outcome === 'unchanged') {
      return adminDone(monthPath('/admin/month/rates', month), 'Без изменений');
    }
    const report = await loadMonthReport(deps.db, deps.env, month, now);
    return adminDone(
      monthPath('/admin/month/rates', month),
      `Ставки сохранены. Акт за ${monthTitle(month)}: ${formatRub(report.act.summary.totalKop)}`,
    );
  }

  return adminPage(400, 'Неизвестное действие', back);
}

/** GET /api/admin/month/csv?m=YYYY-MM: the act's operations as CSV (UTF-8 with BOM for Excel). */
export async function handleAdminMonthCsv(
  request: Request,
  deps: Pick<AdminMonthDeps, 'db' | 'env' | 'logger' | 'now'>,
): Promise<Response> {
  const denied = adminAuthFailure(request, deps.env);
  if (denied) return denied;
  try {
    const now = (deps.now ?? (() => new Date()))();
    const month = parseMonthParam(new URL(request.url).searchParams.get('m') ?? undefined, now);
    const report = await loadMonthReport(deps.db, deps.env, month, now);
    const csv = actCsv(report.act.facts, report.settings.rates);
    return new Response(`\uFEFF${csv}`, {
      status: 200,
      headers: {
        ...ADMIN_RESPONSE_HEADERS,
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="act-${month}.csv"`,
      },
    });
  } catch (error) {
    deps.logger?.error({ ...errorInfo(error) }, 'admin month csv failed');
    return adminPage(500, 'Не удалось собрать CSV — попробуйте ещё раз', {
      href: '/admin/month',
      label: 'К закрытию месяца',
    });
  }
}
