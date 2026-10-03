/**
 * Read models of the admin VIN requests (docs/phase-1c-implementation.md decision С26): the list
 * with a status filter and the request card. Under Basic auth the admin sees the full phone, the
 * VIN and the texts (loadVinRequestForStaff with revealPd); nothing here is logged.
 */
import {
  and,
  desc,
  eq,
  inArray,
  orders,
  sql,
  vinRequests,
  type Executor,
  type SQL,
} from '@detaly/db';
import {
  isOneOf,
  phoneLast4,
  VIN_OPEN_STATUSES,
  VIN_REQUEST_STATUSES,
  type OrderStatus,
  type VinRequestStatus,
} from '@detaly/domain';
import { loadVinRequestForStaff, vinRequestNumber, type VinRequestStaffView } from '@detaly/vin';

export const ADMIN_VIN_PAGE_SIZE = 50;

/** «Ждут ответа»: new and in work. */
export const VIN_OPEN_FILTER = 'open';

export type AdminVinFilter = VinRequestStatus | typeof VIN_OPEN_FILTER | null;

export const VIN_STATUS_LABELS: Record<VinRequestStatus, string> = {
  new: 'Новая',
  in_work: 'В работе',
  offered: 'Подборка отправлена',
  converted: 'Оформлена',
  closed: 'Закрыта',
};

export interface AdminVinQuery {
  status: AdminVinFilter;
  page: number;
}

function first(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value) ?? '';
}

export function parseAdminVinQuery(
  params: Record<string, string | string[] | undefined>,
): AdminVinQuery {
  const raw = first(params.status);
  const status: AdminVinFilter =
    raw === VIN_OPEN_FILTER ? VIN_OPEN_FILTER : isOneOf(VIN_REQUEST_STATUSES, raw) ? raw : null;
  const pageRaw = Number.parseInt(first(params.page), 10);
  const page = Number.isSafeInteger(pageRaw) && pageRaw >= 1 ? Math.min(pageRaw, 10_000) : 1;
  return { status, page };
}

export interface AdminVinRow {
  id: string;
  /** Short number for people ('A1B2C3'). */
  number: string;
  status: VinRequestStatus;
  vin: string | null;
  carText: string | null;
  /** The first 80 characters of «что нужно». */
  needShort: string;
  phoneLast4: string;
  photos: number;
  proposalCount: number;
  createdAt: Date;
}

export interface AdminVinList {
  rows: AdminVinRow[];
  hasNext: boolean;
}

const NEED_SHORT = 80;

export async function listAdminVinRequests(
  db: Executor,
  query: AdminVinQuery,
): Promise<AdminVinList> {
  const conditions: SQL[] = [];
  if (query.status === VIN_OPEN_FILTER) {
    conditions.push(inArray(vinRequests.status, [...VIN_OPEN_STATUSES]));
  } else if (query.status !== null) {
    conditions.push(eq(vinRequests.status, query.status));
  }
  const rows = await db
    .select({
      id: vinRequests.id,
      status: vinRequests.status,
      vin: vinRequests.vin,
      carText: vinRequests.carText,
      needText: vinRequests.needText,
      phone: vinRequests.phone,
      photos: sql<number>`jsonb_array_length(${vinRequests.photos})`,
      proposalCount: vinRequests.proposalCount,
      createdAt: vinRequests.createdAt,
    })
    .from(vinRequests)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(vinRequests.createdAt), desc(vinRequests.id))
    .limit(ADMIN_VIN_PAGE_SIZE + 1)
    .offset((query.page - 1) * ADMIN_VIN_PAGE_SIZE);
  return {
    rows: rows.slice(0, ADMIN_VIN_PAGE_SIZE).map((row) => ({
      id: row.id,
      number: vinRequestNumber(row.id),
      status: row.status,
      vin: row.vin,
      carText: row.carText,
      needShort:
        row.needText.length > NEED_SHORT ? `${row.needText.slice(0, NEED_SHORT)}…` : row.needText,
      phoneLast4: phoneLast4(row.phone),
      photos: Number(row.photos),
      proposalCount: row.proposalCount,
      createdAt: row.createdAt,
    })),
    hasNext: rows.length > ADMIN_VIN_PAGE_SIZE,
  };
}

export interface AdminVinCard {
  request: VinRequestStaffView;
  number: string;
  /** Orders placed from this request's proposals (orders.vin_request_id). */
  orders: { id: string; number: string; status: OrderStatus }[];
}

export async function loadAdminVinRequest(db: Executor, id: string): Promise<AdminVinCard | null> {
  const request = await loadVinRequestForStaff(db, id, { revealPd: true });
  if (request === null) return null;
  const placed = await db
    .select({ id: orders.id, number: orders.number, status: orders.status })
    .from(orders)
    .where(eq(orders.vinRequestId, request.id))
    .orderBy(desc(orders.createdAt));
  return { request, number: vinRequestNumber(request.id), orders: placed };
}
