# Источники картинок и шрифтов

| Что | Где лежит | Источник | Лицензия |
|---|---|---|---|
| Логотипы марок (36 шт.) | `apps/web/public/images/brands/*.webp`, список в `apps/web/src/lib/brands.ts` | [filippofilip95/car-logos-dataset](https://github.com/filippofilip95/car-logos-dataset), папка `logos/optimized` (Lada — `logos/original`, белый фон снят) | репозиторий MIT; знаки — собственность правообладателей, используются только как навигация «запчасти для марки» |
| Шрифт Manrope | npm `@fontsource-variable/manrope` | Google Fonts через Fontsource | SIL Open Font License 1.1 |
| Иконки категорий и интерфейса | `apps/web/src/components/icons` | нарисованы в проекте | — |
| Фото категорий | пока нет, плитки показывают иконки | ждём: Higgsfield (нужно ≈ 28 кредитов), Wikimedia (нужен доступ к upload.wikimedia.org) или фото Сервис56 | — |

Обработка логотипов: ImageMagick, обрезка полей (`-fuzz 8% -trim`), вписывание в 240×120, WebP q88 с альфой без потерь. Новая марка добавляется тем же способом и строкой в `CAR_BRANDS`; тест `apps/web/test/brands.test.ts` проверяет файл и вес ≤ 10 КБ.
