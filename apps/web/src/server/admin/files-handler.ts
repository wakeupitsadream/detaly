/**
 * GET /api/admin/files/<key> (docs/phase-1c-implementation.md decision С26): a photo of a VIN
 * request, a claim or an order (packaging, handover, return) for the admin only. Basic auth is
 * checked by src/proxy.ts and again here; the key must match FILE_KEY_PATTERN (no path walk).
 * `Cache-Control: private, no-store`: the photos may show a car's documents. Nothing is logged
 * but failures (no key).
 */
import type { Env } from '@detaly/config';
import { isFileKey, type FileStore } from '@detaly/files';
import { ADMIN_RESPONSE_HEADERS } from '../admin-auth';
import { errorInfo } from '../errors';
import { adminAuthFailure } from './http';

export interface AdminFileDeps {
  env: Pick<Env, 'ADMIN_BASIC_AUTH'>;
  files: FileStore;
  logger?: { error(details: Record<string, unknown>, message: string): void };
}

const NOT_FOUND = () =>
  new Response('Not Found', {
    status: 404,
    headers: { ...ADMIN_RESPONSE_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' },
  });

export async function handleAdminFile(
  request: Request,
  segments: readonly string[],
  deps: AdminFileDeps,
): Promise<Response> {
  const denied = adminAuthFailure(request, deps.env);
  if (denied) return denied;
  const key = segments.join('/');
  if (!isFileKey(key)) return NOT_FOUND();
  try {
    const file = await deps.files.get(key);
    if (file === null) return NOT_FOUND();
    return new Response(Buffer.from(file.bytes), {
      status: 200,
      headers: {
        ...ADMIN_RESPONSE_HEADERS,
        'Content-Type': 'image/jpeg',
        'Content-Length': String(file.bytes.byteLength),
        'Cache-Control': 'private, no-store',
        'Content-Disposition': 'inline',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (error) {
    deps.logger?.error(errorInfo(error), 'admin file failed');
    return new Response('Хранилище фото недоступно', {
      status: 503,
      headers: { ...ADMIN_RESPONSE_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }
}
