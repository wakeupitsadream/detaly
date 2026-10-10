/**
 * Read model and form parsing of /admin/rossko (step 8, docs/rossko-automation.md): the settings
 * of Rossko without the manual cabinet with their optimistic versions — the GetOrders status map
 * (code → action) next to the codes the polling has seen (journal `rossko_status`: names and how
 * many times), the polling switch (with ROSSKO_MODE, which must be `live` for it to run), the
 * order deadline of «Не заказано у поставщика», the shadow auto-order limit and the Rossko cutoff
 * times — plus what the polling looks at (open supplier orders, the last answer).
 */
import type { Env } from '@detaly/config';
import {
  desc,
  eq,
  inArray,
  orderEvents,
  settings,
  sql,
  supplierOrders,
  type Executor,
} from '@detaly/db';
import {
  isRosskoStatusAction,
  isRosskoStatusCodeKey,
  resolveRosskoAutomationSettings,
  ROSSKO_STATUS_MAP_MAX,
  type RosskoAutomationSettings,
  type RosskoStatusAction,
  type RosskoStatusMap,
} from '@detaly/domain';
import { ROSSKO_SETTINGS_KEYS } from '@detaly/orders';
import { settingsVersion } from './settings-writer';

export const ADMIN_ROSSKO_PATH = '/admin/rossko';

/** A setting as the editor sees it: the value in force and the version of the stored row. */
export interface AdminSetting<T> {
  value: T;
  /** settingsVersion of the stored row ('none' without one). */
  version: string;
  updatedAt: Date | null;
  updatedBy: string | null;
}

/** A code the polling has seen (journal rossko_status, new codes only). */
export interface ObservedCode {
  code: string;
  /** Names Rossko gave the code, the latest first. */
  names: string[];
  /** How many times an order changed to it. */
  count: number;
  lastSeenAt: Date;
}

/** One row of the map editor: a mapped code, a seen one, or both. */
export interface StatusMapRow {
  code: string;
  action: RosskoStatusAction | null;
  names: string[];
  count: number;
  lastSeenAt: Date | null;
}

export interface AdminRosskoData {
  /** ROSSKO_MODE: the polling runs only with `live` (the keys are there). */
  mode: Env['ROSSKO_MODE'];
  statusMap: AdminSetting<RosskoStatusMap>;
  pollEnabled: AdminSetting<boolean>;
  orderWithinMinutes: AdminSetting<number>;
  autoOrderMaxTotalKop: AdminSetting<number>;
  cutoffTimes: AdminSetting<string[]>;
  /** Mapped codes and the codes the polling has seen, by number. */
  rows: StatusMapRow[];
  polling: {
    /** Created supplier orders with a part still on its way (what a run asks about). */
    open: number;
    /** The last GetOrders answer about any of them. */
    lastCheckedAt: Date | null;
  };
}

type Row = { key: string; value: unknown; updatedAt: Date; updatedBy: string | null };

function setting<T>(row: Row | undefined, value: T): AdminSetting<T> {
  return {
    value,
    version: settingsVersion(row),
    updatedAt: row?.updatedAt ?? null,
    updatedBy: row?.updatedBy ?? null,
  };
}

/** Codes of the journal `rossko_status` (changes only, not the late mappings). */
async function loadObservedCodes(db: Executor): Promise<ObservedCode[]> {
  const code = sql<string>`${orderEvents.payload}->>'code'`;
  const name = sql<string | null>`${orderEvents.payload}->>'name'`;
  const rows = await db
    .select({
      code,
      name,
      count: sql<number>`count(*)::int`,
      lastSeenAt: sql<Date | string>`max(${orderEvents.createdAt})`,
    })
    .from(orderEvents)
    .where(
      sql`${orderEvents.type} = 'rossko_status' and ${orderEvents.payload} ? 'code' and not (${orderEvents.payload} ? 'mappedLater')`,
    )
    .groupBy(code, name)
    .orderBy(desc(sql`max(${orderEvents.createdAt})`));
  const byCode = new Map<string, ObservedCode>();
  for (const row of rows) {
    if (!isRosskoStatusCodeKey(row.code)) continue;
    const lastSeenAt = new Date(row.lastSeenAt);
    const seen = byCode.get(row.code);
    if (seen === undefined) {
      byCode.set(row.code, {
        code: row.code,
        names: row.name ? [row.name] : [],
        count: Number(row.count),
        lastSeenAt,
      });
      continue;
    }
    seen.count += Number(row.count);
    if (row.name && !seen.names.includes(row.name)) seen.names.push(row.name);
    if (lastSeenAt > seen.lastSeenAt) seen.lastSeenAt = lastSeenAt;
  }
  return [...byCode.values()];
}

/** The editor rows: every mapped code and every seen code, by number. */
export function statusMapRows(
  map: RosskoStatusMap,
  observed: readonly ObservedCode[],
): StatusMapRow[] {
  const rows = new Map<string, StatusMapRow>();
  for (const [code, action] of Object.entries(map)) {
    rows.set(code, { code, action, names: [], count: 0, lastSeenAt: null });
  }
  for (const seen of observed) {
    const row = rows.get(seen.code);
    rows.set(seen.code, {
      code: seen.code,
      action: row?.action ?? null,
      names: seen.names,
      count: seen.count,
      lastSeenAt: seen.lastSeenAt,
    });
  }
  return [...rows.values()].sort((a, b) => Number(a.code) - Number(b.code));
}

export async function loadAdminRossko(
  db: Executor,
  env: Pick<Env, 'ROSSKO_MODE'>,
): Promise<AdminRosskoData> {
  const stored = (await db
    .select({
      key: settings.key,
      value: settings.value,
      updatedAt: settings.updatedAt,
      updatedBy: settings.updatedBy,
    })
    .from(settings)
    .where(inArray(settings.key, [...ROSSKO_SETTINGS_KEYS]))) as Row[];
  const byKey = new Map(stored.map((row) => [row.key, row]));
  const values: RosskoAutomationSettings = resolveRosskoAutomationSettings(
    new Map(stored.map((row) => [row.key, row.value])),
  );
  const observed = await loadObservedCodes(db);
  const [polling] = await db
    .select({
      // Qualified by hand: drizzle leaves the columns of a single-table select list unqualified,
      // and a bare "id" would be order_items.id inside the subquery.
      open: sql<number>`count(*) filter (where exists (select 1 from supplier_order_items soi join order_items oi on oi.id = soi.order_item_id where soi.supplier_order_id = "supplier_orders"."id" and oi.state = 'ordered'))::int`,
      lastCheckedAt: sql<Date | string | null>`max(${supplierOrders.statusCheckedAt})`,
    })
    .from(supplierOrders)
    .where(eq(supplierOrders.status, 'created'));
  return {
    mode: env.ROSSKO_MODE,
    statusMap: setting(byKey.get('rossko.order_status_map'), values.statusMap),
    pollEnabled: setting(byKey.get('rossko.poll_enabled'), values.pollEnabled),
    orderWithinMinutes: setting(
      byKey.get('rossko.order_within_minutes'),
      values.orderWithinMinutes,
    ),
    autoOrderMaxTotalKop: setting(
      byKey.get('rossko.auto_order_max_total_kop'),
      values.autoOrderMaxTotalKop,
    ),
    cutoffTimes: setting(byKey.get('rossko.cutoff_times'), values.cutoffTimes),
    rows: statusMapRows(values.statusMap, observed),
    polling: {
      open: Number(polling?.open ?? 0),
      lastCheckedAt: polling?.lastCheckedAt ? new Date(polling.lastCheckedAt) : null,
    },
  };
}

/**
 * The map editor form: pairs of `code` and `act` fields in order (an empty `act` — the code is
 * not mapped; an empty `code` — the empty «new code» row). A code twice, a bad code or action,
 * or more than ROSSKO_STATUS_MAP_MAX codes is refused with a message.
 */
export function statusMapFromForm(
  form: URLSearchParams,
): { ok: true; map: RosskoStatusMap } | { ok: false; message: string } {
  const codes = form.getAll('code').map((code) => code.trim());
  const actions = form.getAll('act').map((action) => action.trim());
  if (codes.length !== actions.length || codes.length > ROSSKO_STATUS_MAP_MAX + 1) {
    return { ok: false, message: 'Не удалось прочитать таблицу кодов — обновите страницу' };
  }
  const entries: [string, RosskoStatusAction][] = [];
  const seen = new Set<string>();
  for (const [i, raw] of codes.entries()) {
    const action = actions[i] ?? '';
    if (raw === '') {
      if (action !== '') return { ok: false, message: 'Укажите код для выбранного действия' };
      continue;
    }
    const code = /^\d+$/.test(raw) ? String(Number(raw)) : raw;
    if (!isRosskoStatusCodeKey(code)) {
      return { ok: false, message: `Код «${raw.slice(0, 12)}» — целое число от 0 до 999999` };
    }
    if (seen.has(code)) return { ok: false, message: `Код ${code} указан дважды` };
    seen.add(code);
    if (action === '') continue;
    if (!isRosskoStatusAction(action)) return { ok: false, message: 'Неизвестное действие' };
    entries.push([code, action]);
  }
  if (entries.length > ROSSKO_STATUS_MAP_MAX) {
    return { ok: false, message: `Не больше ${ROSSKO_STATUS_MAP_MAX} кодов` };
  }
  entries.sort(([a], [b]) => Number(a) - Number(b));
  return { ok: true, map: Object.fromEntries(entries) as RosskoStatusMap };
}

/** Minutes of the deadline as the input shows them back. */
export function minutesInputValue(minutes: number): string {
  return String(minutes);
}

/** «15 000» rubles of the limit for the input (kopecks dropped when whole). */
export function rubInputValue(kop: number): string {
  const rub = Math.floor(kop / 100);
  const rest = kop % 100;
  return rest === 0 ? String(rub) : `${rub},${String(rest).padStart(2, '0')}`;
}
