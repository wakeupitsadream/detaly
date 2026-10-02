// Rate limits are applied in src/proxy.ts before this handler runs.
import { handleSearchRequest } from '@/server/api/search-handler';
import { getLogger } from '@/server/logger';
import { getSearchService } from '@/server/search';

export const dynamic = 'force-dynamic';

export function GET(request: Request): Promise<Response> {
  return handleSearchRequest(new URL(request.url), getSearchService(), (error) =>
    getLogger().error({ err: error }, 'search failed'),
  );
}
