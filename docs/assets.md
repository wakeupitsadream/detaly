# Источники картинок и шрифтов

| Что | Где лежит | Источник | Лицензия |
|---|---|---|---|
| Логотипы марок (36 шт.) | `apps/web/public/images/brands/*.webp`, список в `apps/web/src/lib/brands.ts` | [filippofilip95/car-logos-dataset](https://github.com/filippofilip95/car-logos-dataset), папка `logos/optimized` (Lada — `logos/original`, белый фон снят) | репозиторий MIT; знаки — собственность правообладателей, используются только как навигация «запчасти для марки» |
| Логотип Сервис56 (цветной, белый, эмблема) | `apps/web/public/images/partner/servis56-*.webp`, пути в env `PICKUP_LOGO_SRC`, `PICKUP_EMBLEM_WHITE_SRC` | логотип от фаундера (06.10), кремовый фон снят ImageMagick (`-fuzz 9% -transparent #F1E8DD`), белый вариант — заливка по альфа-маске | собственность ИП Сервис56, используется с согласия партнёра |
| Шрифт Manrope | npm `@fontsource-variable/manrope` | Google Fonts через Fontsource | SIL Open Font License 1.1 |
| Иконки категорий и интерфейса | `apps/web/src/components/icons` | нарисованы в проекте | — |
| Фото категорий | пока нет, плитки показывают иконки | ждём: Higgsfield (нужно ≈ 28 кредитов), Wikimedia (нужен доступ к upload.wikimedia.org) или фото Сервис56 | — |

Обработка логотипов: ImageMagick, обрезка полей (`-fuzz 8% -trim`), вписывание в 240×120, WebP q88 с альфой без потерь. У Mercedes-Benz, Mitsubishi, Mazda, Škoda, Peugeot, Lexus, Hyundai, Chevrolet, Chery, Geely, Daewoo, Honda и УАЗ под эмблемой была надпись — она отрезана (`-crop x<строка разрыва>+0+0`, затем `-trim`): имя марки и так подписано под плиткой, а мелкая надпись делала эти плитки визуально меньше соседних. Новая марка добавляется тем же способом и строкой в `CAR_BRANDS`; тест `apps/web/test/brands.test.ts` проверяет файл, вес ≤ 10 КБ и что `width/height` в `CAR_BRANDS` совпадают с файлом. Haval остаётся надписью (отдельной эмблемы у марки нет), но рисуется с `scale: 0.7`.
