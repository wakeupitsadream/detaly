import Link from 'next/link';

// Root 404 (also prerendered at build time): no env, no database.
export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col justify-center gap-4 px-4">
      <h1 className="text-2xl font-bold">Страница не найдена</h1>
      <p className="text-muted">Проверьте адрес или начните с поиска по артикулу.</p>
      <Link href="/" className="font-semibold text-accent-strong underline">
        На главную
      </Link>
    </main>
  );
}
