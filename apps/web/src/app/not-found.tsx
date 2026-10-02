import { ButtonLink } from '@/components/ui/Button';
import { Eyebrow } from '@/components/ui/Eyebrow';
import { HazardBand } from '@/components/ui/HazardBand';

// Root 404 (also prerendered at build time): no env, no database.
export default function NotFound() {
  return (
    <main className="grain-dark flex min-h-screen flex-col bg-graphite-900 bg-blueprint text-steel-200">
      <div className="mx-auto flex w-full max-w-site flex-1 flex-col justify-center gap-6 px-4 py-16 md:px-6 lg:px-8">
        <Eyebrow onDark>Ошибка 404</Eyebrow>
        <p
          aria-hidden
          className="font-mono text-[clamp(4.5rem,3rem+9vw,10rem)] leading-none font-semibold text-graphite-700"
        >
          404
        </p>
        <h1 className="text-h1 max-w-2xl text-paper">Такой страницы нет</h1>
        <p className="max-w-xl text-steel-400">
          Возможно, ссылка устарела или в адресе опечатка. Начните с поиска по артикулу: цена и дата
          получения будут сразу.
        </p>
        <div className="flex flex-wrap gap-3">
          <ButtonLink href="/" onDark>
            На главную
          </ButtonLink>
        </div>
      </div>
      <HazardBand />
    </main>
  );
}
