'use client';

export default function SiteError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="max-w-xl space-y-4">
      <h1 className="text-2xl font-bold">Что-то пошло не так</h1>
      <p className="text-muted">
        Страница не загрузилась. Попробуйте ещё раз через минуту — мы уже знаем о проблеме.
      </p>
      <button
        type="button"
        onClick={reset}
        className="inline-flex h-11 items-center rounded-xl bg-accent px-5 font-semibold text-white hover:bg-accent-strong"
      >
        Повторить
      </button>
    </div>
  );
}
