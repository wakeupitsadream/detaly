/**
 * Defence in depth for the admin pages: src/proxy.ts answers 401/404 before a page runs; if a
 * request ever reaches a page without valid credentials (a matcher change, a bypass), the
 * page renders the 404 instead of client data.
 */
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { checkAdminAuth } from '../admin-auth';
import { serverEnv } from '../env';

export async function requireAdmin(): Promise<void> {
  const auth = checkAdminAuth(await headers(), serverEnv().ADMIN_BASIC_AUTH);
  if (auth !== 'ok') notFound();
}
