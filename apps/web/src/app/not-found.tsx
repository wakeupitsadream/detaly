import type { Metadata } from 'next';
import { connection } from 'next/server';
import { Suspense } from 'react';
import { HeaderSearch } from '@/components/HeaderSearch';
import { IconHome, IconSearch, IconSts } from '@/components/icons';
import { EmptyPanel } from '@/components/page/EmptyPanel';
import { ButtonLink } from '@/components/ui/Button';
import { Container } from '@/components/ui/Container';

/**
 * The title of every 404 this boundary answers: an unmatched path, and the notFound() of a
 * (site) page whose segment has no not-found of its own (the shell Next sends then takes its
 * <title> from here).
 */
export const metadata: Metadata = { title: 'Страница не найдена' };

/**
 * Root 404: every path no route matches (/docs/<unknown>, a mistyped address, the demo's hidden
 * pages), a whole HTML page with status 404 that reads without JS. No env, no database, so no
 * brand name either — the brand plate on top carries the search pill (HeaderSearch needs no
 * env), so a mistyped link still leads straight to an article search. docs/design-v2.md,
 * «Инфостраницы»: an icon, «Страница не найдена», «На главную» and «Подбор по VIN».
 */
export default async function NotFound() {
  // Rendered per request, not prerendered at build time: the scripts of the page need the
  // nonce of the request's CSP (lib/csp.ts), a build-time page would have none.
  await connection();
  return (
    <main className="flex min-h-screen min-w-0 flex-col bg-bg text-ink">
      <div className="site-header rounded-b-header bg-brand text-on-brand lg:rounded-b-header-lg">
        <Container className="pt-3 pb-4 md:py-4">
          {/* useSearchParams inside: a prerendered page needs the boundary. */}
          <Suspense fallback={<div className="h-14 rounded-full bg-bg" />}>
            <HeaderSearch />
          </Suspense>
        </Container>
      </div>
      <div className="mx-auto flex w-full max-w-site flex-1 flex-col justify-center px-4 py-16 md:px-6 lg:px-8">
        <EmptyPanel
          icon={<IconSearch size={64} />}
          eyebrow="Ошибка 404"
          title="Страница не найдена"
          titleAs="h1"
          titleId="not-found-title"
          text="Ссылка устарела или в адресе опечатка."
          actions={
            <>
              <ButtonLink href="/" size="lg" icon={<IconHome size={20} />}>
                На главную
              </ButtonLink>
              <ButtonLink
                href="/vin"
                variant="secondary"
                size="lg"
                className="bg-bg"
                icon={<IconSts size={20} className="text-brand" />}
              >
                Подбор по VIN
              </ButtonLink>
            </>
          }
        />
      </div>
    </main>
  );
}
