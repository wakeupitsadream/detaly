# Витрина: дизайн-спецификация «Техкарта»

Задача: витрина должна выглядеть солидно и дороже, чем стоила, вызывать доверие и не быть
похожей на ИИ-шаблон. Плюс демо на Vercel без БД и Redis, чтобы показать партнёру. Основа —
принципы `website-moneyglitcher/references/design.md` и раздел 5 `docs/PLAN.md`. Бизнес-логику,
контракты и тесты не трогаем: меняем вид, разметку и тексты, добавляем вау-фичу и демо-режим.

Что не так сейчас (скриншоты `apps/web/test-results/screens`): системный шрифт, белые карточки
на бежевом фоне, скруглённые «пилюли», серый квадрат вместо фото точки, четыре одинаковые
карточки «Как это работает». Это типовая заготовка, у которой нет никакого характера.

## 1. Направление: «Техкарта»

Одно направление: **инженерный документ хорошего автосервиса**. Так выглядит технологическая
карта ремонта или шильдик на агрегате: графитовый металл, чертёжная сетка, номера крупным
моноширинным шрифтом, сигнальный оранжевый, как на подъёмнике и огнетушителе. Почему это
работает для запчастей в Оренбурге:

- **Доверие через точность.** Артикул набран как гравировка, дата получения стоит как в
  заказ-наряде, реквизиты оформлены шильдиком. Сайт выглядит так, будто его делал мастер,
  который отвечает за деталь. Это и есть позиционирование «запчасти от людей, которые их же и
  поставят».
- **Не маркетплейс.** У Emex и Autodoc белый фон, красный цвет и баннеры. У нас тёмный цех и
  светлая бумага техкарты, и путать не с кем.
- **Нет фотографий** (в API Rossko их нет), поэтому графика держится на паттернах и глифах
  категорий, а не на сток-фото.

Ритм страницы задают чередование тёмных и светлых секций, диагональный срез низа hero (−4°) и
узкая полоса «сигнальной ленты» между hero и вау-фичей. Это одно намеренное нарушение
симметрии. Тёмную тему по `prefers-color-scheme` не делаем: тёмные секции уже есть, страница и
так контрастная.

## 2. Токены

Всё задаётся CSS-переменными в `@theme` (`apps/web/src/app/globals.css`). Старые имена
(`paper`, `ink`, `muted`, `faint`, `line`, `card`, `accent`, `accent-strong`, `accent-soft`,
`local`, `order`, `warn` и их `-soft`) остаются **псевдонимами** новых, чтобы админка и
непереписанные места не сломались.

### Палитра

| Токен | Значение | Назначение |
|---|---|---|
| `--color-graphite-950` | `#111315` | шапка, футер, самые тёмные секции |
| `--color-graphite-900` | `#181B1E` | hero, секция точки выдачи |
| `--color-graphite-800` | `#22262A` | поверхности на тёмном, плитки-заглушки |
| `--color-graphite-700` | `#343A40` | линии на тёмном |
| `--color-steel-400` | `#8D949B` | вторичный текст на тёмном |
| `--color-steel-200` | `#C9CDD1` | основной текст на тёмном (кроме заголовков) |
| `--color-paper` | `#F0EDE6` | фон страницы: тёплая бумага техкарты |
| `--color-paper-2` | `#E6E1D6` | утопленные зоны, disabled |
| `--color-card` | `#FAF8F4` | карточки на бумаге |
| `--color-ink` | `#14161A` | основной текст, активные чипы |
| `--color-muted` | `#585E66` | вторичный текст на светлом (AA 6.1:1 на paper) |
| `--color-faint` | `#8B9097` | подписи, плейсхолдеры (только ≥ 14px) |
| `--color-line` | `#D5CFC2` | рамки на светлом |
| `--color-line-strong` | `#A9A294` | рамки полей, разделители таблиц |
| `--color-accent` | `#FF5B1F` | бренд-акцент, **только заливка под текстом ink** (6.6:1) |
| `--color-accent-hover` | `#E84A12` | hover заливки |
| `--color-accent-ink` | `#B23A0A` | ссылки и акцент-текст на светлом (5.4:1) |
| `--color-accent-soft` | `#FFE6DA` | подложка выделенного на светлом |
| `--color-signal` | `#FFC21A` | сигнальный жёлтый: только «лента» и метка «демо», всегда с ink |

Белым текстом на оранжевом не пишем: контраст ниже AA. Кнопка — оранжевая заливка с чёрным
текстом, как маркировка оборудования.

**Светофор состояний отдельно от бренда.** Оранжевый и жёлтый никогда не означают состояние.

| Токен | Текст / подложка | Где |
|---|---|---|
| `--color-ok` / `--color-ok-soft` | `#1E7046` / `#E1F0E6` | «В Оренбурге», «Оплачен», «Приехал» |
| `--color-info` / `--color-info-soft` | `#2A5A86` / `#E0EAF4` | «Под заказ», информационные плашки |
| `--color-wait` / `--color-wait-soft` | `#8F5200` / `#F8ECD6` | «Ждёт оплаты», «Цена изменилась» |
| `--color-danger` / `--color-danger-soft` | `#B42318` / `#FBE3E0` | ошибки, отмена, «Не продаём онлайн» |

Псевдонимы: `local → ok`, `order → info`, `warn → wait`.

### Шрифты

Self-host через npm, без `next/font/google` и CDN (CSP и так разрешает только `font-src 'self'`):

```
pnpm --filter @detaly/web add @fontsource-variable/unbounded @fontsource-variable/onest @fontsource-variable/jetbrains-mono
```

Импорт `index.css` каждого пакета делается в `app/layout.tsx`. Файлы бьются по `unicode-range`,
и браузер грузит только кириллицу и латиницу.

- **Unbounded** (display, 500–800) — широкий, «шильдиковый». Используется для H1/H2, цен,
  крупных цифр фактов и логотипа. Не для абзацев.
- **Onest** (текст, 400/500/650) — спокойный, с хорошей кириллицей. Весь текст, кнопки, поля.
- **JetBrains Mono** (400/600) — артикулы, номер заказа, даты в таймлайне, реквизиты, метки.

`--font-display`, `--font-sans`, `--font-mono` в `@theme`; `font-variant-numeric: tabular-nums`
для цен и сумм.

| Роль | Размер | Шрифт / вес | Интерлиньяж |
|---|---|---|---|
| display (H1 главной) | `clamp(2.125rem, 1.1rem + 4.2vw, 4.25rem)` | Unbounded 700, `-0.02em` | 1.04 |
| h1 внутренних | `clamp(1.75rem, 1.3rem + 1.8vw, 2.625rem)` | Unbounded 700 | 1.1 |
| h2 | `clamp(1.375rem, 1.1rem + 1.1vw, 1.875rem)` | Unbounded 600 | 1.15 |
| h3 | 1.125rem | Onest 650 | 1.3 |
| body | 1rem (1.0625rem от `md`) | Onest 400 | 1.6 |
| small | 0.875rem | Onest 400/500 | 1.5 |
| label | 0.75rem, uppercase, `0.08em` | JetBrains Mono 600 | 1.3 |
| артикул | 1.125rem (1.25rem в выдаче) | JetBrains Mono 600 | 1.2 |
| цена | 1.75rem (2rem в итоге корзины) | Unbounded 600 | 1 |

На 375 px самое длинное слово H1 должно влезать в 343 px. Это проверяется скриншотом;
`hyphens: manual`, без автопереносов в заголовках.

### Сетка, отступы, формы

- Контейнер: `max-width: 72rem` (1152 px). Поля 16 px до `sm`, 24 px на `md`, 32 px на `lg`.
  Внутри 12 колонок на `lg`, 4 на телефоне, gap 24/16.
- Шаг 4 px, ритм 8 px. Вертикальные отступы секций 56 / 88 / 120 px (mobile / md / lg).
- Радиусы почти прямые: `--radius-sm 2px` (бейджи, чипы), `--radius 4px` (кнопки, поля,
  карточки), `--radius-lg 10px` (верх шторки). Пилюль нет.
- Тени не используем. Карточки держатся на рамке 1 px `line`. У основной кнопки «жёсткая тень»
  на hover: `3px 3px 0 var(--color-ink)`. На ключевых карточках (виджет вау-фичи, итог корзины,
  шапка заказа) стоят угловые метки, как на чертеже: четыре L-уголка 10×10 px через
  `::before/::after` и `background` с двумя линейными градиентами.

### Фактура

Все паттерны лежат в `globals.css` как `data:`-URI (CSP `img-src data:` уже разрешён).

- **Зерно**: `body::after`, fixed, `pointer-events:none`, SVG `feTurbulence`
  (`baseFrequency .9`, `numOctaves 2`). На светлом `opacity .16` + `mix-blend-mode: multiply`,
  на тёмных секциях `.06` + `soft-light`. Утилита `.grain-dark` на секции.
- **Чертёжная сетка** `.bg-blueprint` для hero, точки выдачи и футера:
  ```
  url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='48' height='48'%3E%3Cpath d='M48 0H0v48' fill='none' stroke='%23fff' stroke-opacity='.07'/%3E%3Cpath d='M12 0v48M24 0v48M36 0v48M0 12h48M0 24h48M0 36h48' stroke='%23fff' stroke-opacity='.025'/%3E%3C/svg%3E")
  ```
- **Протектор** `.bg-tread` для плиток-заглушек: шеврон
  `M0 12 L6 4 L12 12 L18 4 L24 12` (24×16), `stroke #fff`, `opacity .06`, `stroke-width 3`.
- **Сигнальная лента** `.hazard`: `repeating-linear-gradient(-45deg, var(--color-signal) 0 10px, var(--color-graphite-950) 10px 20px)`,
  высота 10 px. Встречается дважды на сайте: под hero и рамкой у метки «демо».

### Иконки и заглушки

Inline SVG, `viewBox 0 0 24 24`, `stroke-width 1.75`, `stroke-linecap square`, `currentColor`,
без библиотек. Набор в `components/icons/`: категории — фильтр (цилиндр с рёбрами), колодки,
тормозной диск, свеча, амортизатор, ремень (два шкива), подшипник, щётка стеклоочистителя,
лампа, масло (канистра), деталь по умолчанию (шестигранная гайка); интерфейс — поиск, корзина,
стрелка, шеврон, галочка, часы, подъёмник, булавка-метка, телефон, документ, щит
(возврат), закрыть, внешняя ссылка.

`categoryOf(name)` выбирает глиф по названию предложения (`/фильтр/` → фильтр, `/колодк/`,
`/диск/`, `/свеч/`, `/амортиз|стойк/`, `/рем(е|н)/`, `/подшип|ступиц/`, `/щ[её]тк|дворн/`,
`/ламп/`, `/масл/`, иначе гайка). Регистр не важен.

**PartTile** заменяет фото: квадрат 64 px (72 px от `md`), фон `graphite-800` + `.bg-tread`,
по центру глиф категории 28 px цвета `steel-200`, в правом нижнем углу метка категории
моноширинным 9 px. Серых квадратов и надписи «нет фото» нет.

### Состояния

- **Кнопки** (`ui/Button`, варианты `primary | secondary | ghost | danger`, размеры `md 44px` /
  `lg 52px`). Primary: accent + ink, на hover `accent-hover` и жёсткая тень с
  `translate(-1px,-1px)`, на active без тени со сдвигом `1px`, disabled — `paper-2` и `faint`,
  без тени. Secondary: рамка 1.5 px ink, на hover заливка ink и текст paper (на тёмном
  инверсно). Ghost: текст с подчёркиванием `underline-offset 4px`. Danger: рамка и текст
  `danger`. Фокус: `outline 2px solid var(--color-accent)` с отступом 2 px, на оранжевых —
  `outline-color: ink`.
- **Поля** (`ui/Input`, `ui/Field`): высота 48 px (поиск 56 px), фон `card`, рамка 1.5 px
  `line-strong`. На hover рамка `muted`. На focus рамка ink + `box-shadow 0 0 0 3px` accent 35 %.
  Ошибка: рамка `danger`, под полем текст ошибки с иконкой. Подпись над полем Onest 500 0.875rem,
  подсказка под полем `muted`. Плейсхолдер артикула моноширинный.
- **Чипы** (`ui/Chip`): 36 px, радиус 2 px, рамка `line`. Активный — ink и текст paper
  (`aria-current` как сейчас). На телефоне строка скроллится горизонтально, с маской-затуханием
  справа.
- **Бейджи** (`ui/Badge`, тона `ok | info | wait | danger | neutral | demo`): 24 px, радиус 2 px,
  слева точка 6 px. `demo` — signal + ink. Тексты `StockBadge` **не меняются**.

### Анимации

Одна оркестрованная загрузка hero. Строки H1 поднимаются по очереди (`translateY 14px → 0`,
`opacity`, 520 ms, `cubic-bezier(.2,.7,.2,1)`, шаг 70 ms), за ними поиск, факты и виджет вау-фичи.
В виджете линия цепочки «деталь → подъёмник → готово» прорисовывается через
`stroke-dashoffset` за 700 ms. Микро-hover: кнопки, карточки предложений (рамка ink,
`translateY(-1px)`), чипы. Больше ничего не анимируем. Под
`@media (prefers-reduced-motion: reduce)` анимации выключены, всё стоит в финальном положении.
Всё сделано на CSS (`.rise`, `--i` для задержки), JS не нужен.

## 3. Компоненты

**Шапка** (`SiteHeader`, graphite-950, 64 px, sticky). Слева знак — квадрат accent 28 px с
глифом гайки (без букв бренда) и `brand.name` шрифтом Unbounded 700. Справа навигация
«Подбор по VIN», «Возврат», «О нас» и корзина: иконка, слово «Корзина» и счётчик (квадрат
accent с ink-цифрой, моноширинный). На внутренних страницах от `md` в центре компактный
поиск (`HeaderSearch`, client, по `usePathname` скрыт на `/`). На телефоне две строки: логотип
и корзина, ниже навигация горизонтальной прокручиваемой строкой. **В бургер навигацию не
прячем**: e2e ищет `navigation "Основное меню"` и ссылку «О нас» на мобильной ширине. Экспорт
`cartCountLabel`, `aria-label` корзины и `data-testid` (`header-cart`, `header-cart-count`)
сохраняются.

**Мобильная полоса корзины** (`MobileCartBar`, client): ниже `md`, при `cartCount > 0`, не на
`/cart`, `/checkout`, `/o/*`. Fixed bottom, graphite-950, высота 64 px + `safe-area-inset-bottom`.
Слева «В корзине 2 позиции», справа primary-кнопка «Корзина →». `data-testid="mobile-cart-bar"`.
Пока полоса видна, `main` получает нижний отступ 80 px.

**Шторка** (`ui/Sheet`, client, нативный `<dialog>`): на телефоне выезжает снизу (радиус
верха 10 px, ручка), на десктопе стоит модалкой по центру. Esc и клик по фону закрывают.
Пример использования: «Как мы считаем окно установки».

**Карточка предложения** (`OfferRow`, корень `<li data-testid="offer-row">`). На десктопе сетка
`72px | 1.3fr | 1.4fr | auto`:
1. `PartTile` с глифом категории.
2. Бренд (label, mono uppercase, muted), артикул (mono 600 1.25rem, `wrap-anywhere`),
   название (Onest 1rem), «Продаётся по N шт.».
3. `StockBadge`, затем «Получение **к чт 8 октября**» (`promiseText`), под ними
   `InstallLine`: иконка подъёмника и «Установка: чт 8 окт с 14:00».
4. Цена (Unbounded 600 1.75rem, `data-testid="offer-price"`), «в наличии: 24 шт.» (mono small),
   кнопка «В корзину» (primary md, `aria-label` как сейчас).

На телефоне: плитка 56 px и бренд/артикул в одной строке, ниже название и бейдж, затем дата,
окно установки, внизу цена слева и кнопка справа на всю оставшуюся ширину. Исключённые
позиции получают бейдж danger «Не продаём онлайн», без кнопки.

**Выдача** (`/search`): H1 «Поиск по артикулу» с поиском, строка-итог (mono label
«OC90 · 5 предложений», `data-testid="results-summary"` с прежним текстом), чипы-фильтры, затем
группы «Запрошенный артикул» и «Аналоги». Заголовок группы — h2 со счётчиком, под ним тонкая
линия.

**Корзина**. Слева строки (`CartLineRow`): плитка, артикул, бейдж, дата, количество (поле
56 px + «Изменить»), «Удалить» ghost. Справа sticky-карточка итога с угловыми метками: «Итого,
N шт.», сумма Unbounded 2rem, дата получения, primary lg «Оформить заказ». `DiffBanner` и
`PaymentModeNotice` — плашки `wait`/`info` с иконкой. Пустая корзина: крупная иконка, фраза и
кнопка «Искать по артикулу».

**Оформление**. Один экран, две колонки: форма (телефон, имя, канал статусов — радио-плитки
MAX/Telegram, два отдельных чекбокса) и сводка с точкой выдачи. Чекбоксы 22 px с квадратной
галочкой accent, подписи и ссылки на документы без изменений. В демо-режиме вместо формы
показывается экран «В демо оформление отключено — посмотрите пример заказа» с кнопкой на
`/o/demo` (раздел 5).

**Страница заказа**. Шапка-техкарта: «Заказ» и номер mono, бейдж статуса, «Получение к …». Под
ней **таймлайн-степпер** `OrderStepper`: Оформлен → Оплачен/Подтверждён → Заказан у
поставщика → Приехал → Выдан. На десктопе горизонтально, на телефоне вертикально. Пройденные
шаги — ink-кружок с галочкой, текущий — accent-кольцо, будущие — пунктир. Отменённый заказ:
степпер серый, плашка danger. Степпер **только отображает** текущий `view` через существующие
`status-labels`, логику не трогаем. Ниже идут карточки «Оплата», «Состав», «Самовывоз» (с
`InstallLine` по дате получения заказа), «История» (время mono, фразы прежние), уведомления,
отмена (danger).

**Документы** (`.legal`): ширина 68ch, Onest 1.0625rem/1.7, h1 Unbounded, h2 с подчёркиванием
линией `line`. Блок «черновик» — подложка `wait-soft` с полосой `.hazard` слева. Таблицы и их
мобильная развёртка в карточки остаются. `@media print`: без шапки, футера и фактуры.

**Футер** (graphite-950 + blueprint, `data-testid="site-footer"`). Три колонки: бренд и строка
«Запчасти от людей, которые их же и поставят»; **шильдик реквизитов** (рамка `graphite-700`,
четыре «заклёпки» по углам, реквизиты mono, `data-testid="footer-inn"` на строке ИНН); ссылки на
документы. Нижняя строка: `© год бренд` и справа
`Дизайн и разработка — <a href="https://maxim-batutin.ru" target="_blank" rel="noopener">maxim-batutin.ru</a>`.

**Главная**, сверху вниз:
1. **Hero** (graphite-900, blueprint, диагональный срез). Eyebrow mono «Оренбург · автозапчасти
   с установкой». H1: «Узнайте, когда машина будет готова, ещё до заказа детали». Подзаголовок:
   «Цена, дата в Оренбурге и ближайшее окно на подъёмнике — сразу по артикулу». Большой поиск.
   Факты цифрами из env и настроек: «до 15 000 ₽ — оплата при получении»
   (`ON_PICKUP_MAX_TOTAL`), «7 дней на возврат без удержаний», часы точки из `PICKUP_HOURS`,
   «1 точка выдачи — прямо в автосервисе». Справа (на телефоне ниже) — виджет вау-фичи.
2. Сигнальная лента.
3. **«Когда машина будет готова»**: интерактивный виджет и пояснение формулы (раздел 4).
4. **«Знаю артикул / не знаю»**: две панели. В первой поиск и три подсказки, где найти артикул
   (на старой детали, в заказ-наряде, в каталоге производителя). Во второй — подбор по VIN с
   правилом «подобрали мы и не подошло — вернём деньги». Под ними маршрут заказа в одну строку
   из четырёх шагов `01–04` mono, соединённых линией. Без «Почему выбирают нас» и трёх иконок.
5. **Точка выдачи** (graphite): название (`PICKUP_POINT_NAME`), адрес, часы, телефон. Вместо
   карты — стилизованная схема в blueprint с меткой (внешние карты запрещены CSP). Ниже
   короткая строка о продавце и ссылка «Реквизиты».
6. Футер.

Анти-чеклист (проверяет ревьюер): нет эмодзи, нет фиолетового и стекла, нет Inter/Roboto, нет
сток-фото, нет «Наша миссия», «Почему мы», lorem. Капитализированное название бренда отдельным
словом в исходниках не встречается (`test/no-hardcoded-brand.test.ts`), чисел, похожих на
ИНН/ОГРНИП, тоже нет.

## 4. Вау-фича «Когда машина будет готова»

По выбранному предложению считаем цепочку: **деталь в Оренбурге к дате → ближайшее свободное
окно установки → машина готова к времени**. Формула честная и детерминированная: данные
известные, а где загрузка симулирована, это так и подписано.

### Формула (`packages/domain/src/install-window.ts`, чистая, время передаётся снаружи)

Входные данные: `etaDate` (`OfferView.etaDate` — дата, когда деталь будет в точке выдачи, буфер
уже учтён), `now`, `timeZone` (`Asia/Yekaterinburg`), `schedule` (`WeekSchedule` из
`PICKUP_HOURS`), `load` (`LoadSnapshot`), опции с умолчаниями: `arrivalTime 12:00` (поставка
приходит к обеду), `leadMin 60` (минимум от «сейчас»), `jobMin 120` (типовая замена),
`stepMin 60`, `horizonDays 14`.

1. `readyAt = max(now + leadMin, etaDate@arrivalTime)`.
2. Перебираем рабочие дни с `date(readyAt)` на `horizonDays` вперёд. В каждом дне кандидаты
   `s` с шагом `stepMin` от `max(open, ceilStep(readyAt))`, пока `s + jobMin ≤ close`.
   Берём первый `s`, для которого во всех часах `[s, s + jobMin)` выполнено
   `booked < capacity`.
3. Ответ `InstallPlan { readyAt, slotStart, carReadyAt, loadKind }` или `null`, если окна нет
   (тогда UI пишет «окно подберём при записи»). Неразобранный `PICKUP_HOURS` тоже даёт `null`:
   лучше не показать, чем соврать.

`parseWorkHours(text)` (`packages/domain/src/work-hours.ts`) понимает «Пн–Пт 10:00–19:00»,
«Пн-Пт 9:00-19:00, Сб 10:00-16:00», «Ежедневно 9–21», «без выходных», разделители `,`, `;`
и перевод строки, тире `–—-`. Всё, что не распознано, даёт `null`.

`LoadSnapshot`: `(hourStartMs) => { booked, capacity }`. **Демо-загрузка**
(`packages/domain/src/install-load-demo.ts`, `demoLoad(dayIso, hour, capacity = 2)`) — без
`Math.random`. Базовая занятость по часу: открытие и после 17:00 — 2, 11–13 — 1, остальное 0.
Суббота +1. Детерминированная «соль» `(dayOfYear * 7 + hour * 3) % 5 === 0` добавляет +1. Всё
ограничено `capacity`. Одинаковые входные данные всегда дают одинаковый ответ: это проверяют
снапшот-тесты.

Тесты (`packages/domain/test/install-window.test.ts`, `work-hours.test.ts`,
`install-load-demo.test.ts`): деталь сегодня до и после закрытия, пятница вечером → понедельник,
суббота с коротким днём, полный день → следующий, `jobMin` не влезает до закрытия, неразобранные
часы → `null`, граница часового пояса (поздний вечер UTC).

### Источник загрузки (`apps/web/src/server/install/`)

```ts
export interface LoadSource {
  readonly kind: 'demo' | 'live';
  snapshot(from: Date, to: Date): Promise<LoadSnapshot>;
}
```

`demo-load-source.ts` оборачивает `demoLoad`. `bookings-load-source.ts` (бой) читает
`install_bookings` за интервал одним запросом. `load-source.ts` выбирает источник: `demo`, если
`isDemoMode()` или `brand.demoData`, иначе `live`. Чтобы сменить боевой источник, достаточно
поменять один файл. `config.ts`: `INSTALL_LIFTS = 2`, `INSTALL_JOB_MIN = 120` с пометкой
VERIFY (число подъёмников уточнить у Лёши). `index.ts` экспортирует контракт для страниц:

```ts
planInstallForOffers(offers: OfferView[], now: Date): Promise<Map<string, InstallPlanView | null>>
planInstallForDate(etaDate: IsoDate, now: Date): Promise<InstallPlanView | null>
// InstallPlanView (types.ts): { partText: 'к чт 8 октября'; slotText: 'чт 8 окт с 14:00' | 'сегодня с 16:00' | 'завтра с 10:00';
//   carReadyText: 'к 16:00'; demo: boolean; slotStartIso: string }
```

Один `snapshot` на страницу, ошибка источника → пустая карта и предупреждение в лог. Страница
от этого не падает.

### Где показывается

- **Hero и секция 3.** `InstallWindowDemo` (client) получает предрассчитанные данные. При
  `brand.demoData` сервер ищет примеры `DEMO_ARTICLES` (OC90, W9142, GDB1330) через
  search-service и берёт по каждому самое быстрое предложение. Чипы артикулов переключают
  цепочку из трёх узлов («Деталь в Оренбурге к чт 8 окт» → «Подъёмник свободен чт с 14:00» →
  «Машина готова к 16:00») и полосу загрузки дня — ячейки по часам: занятые graphite,
  выбранное окно accent. В живом режиме примеров нет: виджет показывает цепочку для «есть в
  Оренбурге» (сегодняшний `etaDate` по правилам `etaDate()`) и зовёт искать свой артикул.
  Ссылка «Как считаем» открывает шторку с формулой обычным языком. При `demo: true` рядом
  стоит бейдж `demo` «загрузка демонстрационная».
- **Карточка предложения**: строка `InstallLine` «Установка: чт 8 окт с 14:00».
- **Страница заказа**: в «Самовывоз» — «Ближайшее окно установки: … Запись подтверждает
  мастер; установка — услуга сервиса, оплачивается там». Обещания нет, только расчёт.

## 5. Демо-режим `DEMO_MODE=true`

Цель: Vercel без Postgres и Redis, витрина живая, ничего не пишется и ничего не обещается.

| Часть | В демо |
|---|---|
| Поиск | фикстуры Rossko (`ROSSKO_MODE=fixtures` принудительно), in-memory кэш поиска и in-memory лимитер (`packages/rossko/src/memory.ts`), `search_log` не пишется |
| Настройки | `settingsDefaultsFromEnv(env)` без БД (env-реализация `SettingsReader`) |
| Документы | `content/legal`, вшитые в сборку: сгенерированный модуль `server/demo/legal-bundle.ts` (скрипт `apps/web/scripts/gen-legal-bundle.ts` + тест на синхронность), рендер через `renderLegal` с плейсхолдерами из env |
| Корзина | `DemoCartService` реализует тот же `CartService`. Строки хранятся в httpOnly-cookie `demo_cart` (HMAC-SHA256 от `SESSION_SECRET`, `SameSite=Lax`, ≤ 20 строк), запись идёт через `cookies()` в route handler. Перепрайсинг — через тот же поиск по фикстурам. `requestCartCount` читает ту же cookie |
| Гейт | открыт: «В корзину» видна |
| Checkout | страница показывает `DemoCheckoutNotice`; `POST /api/checkout` → 403 JSON `{error:'demo'}` |
| Заказ | `/o/demo` — статичный маршрут `app/(site)/o/demo/page.tsx` с примерным `OrderView` (`server/demo/order-fixture.ts`: две позиции из фикстур, статус «Заказан у поставщика», история из 3 событий). Без чисел, похожих на ИНН. Остальные `/o/*` → 404 |
| Админка, вебхуки, `/api/orders/*` | 404 (в `proxy.ts` и в самих handlers) |
| Rate limit в proxy | in-memory счётчики на инстанс, Redis не трогается |
| `/api/health` | `{"status":"ok","mode":"demo","db":"skipped","redis":"skipped"}` |

**Один переключатель в серверном слое.** `server/mode.ts → isDemoMode()`. Фабрики `getSupplier`,
`getSearchService`, `getCartService`, `requestCartCount`, `loadPublishedDocument`,
`currentCheckoutGate`, health выбирают реализацию **внутри себя**: интерфейс один, реализаций
две. Боевые реализации не меняются. `getDb()` и `getRedis()` в демо бросают `DemoModeError`,
поэтому случайное обращение сразу видно в логе.

**Env-схема** (`packages/config/src/env.ts`): `DEMO_MODE: bool(false)`. `DATABASE_URL` и
`REDIS_URL` становятся `.optional()`, а `superRefine` требует их при `DEMO_MODE=false`.
Хелперы `databaseUrl(env)` и `redisUrl(env)` бросают ошибку, если значения нет. Ими
пользуются web `db.ts`/`redis.ts` и worker `create-deps.ts`. При `DEMO_MODE=true` проверка
также требует `ROSSKO_MODE=fixtures` и запрещает `YOOKASSA_*`. `.env.example` обновляется
(тест реестра env). `SESSION_SECRET` в демо обязателен, как и раньше.

**Vercel**: Root Directory `apps/web`, install `pnpm install --frozen-lockfile` (монорепо),
build `pnpm run build` из `apps/web` (`apps/web/vercel.json`; проект — `docs/runbook.md`, раздел 13). Env: `DEMO_MODE=true`, `SESSION_SECRET`,
`APP_BASE_URL`, `NOINDEX_ALL=true`, `BRAND_NAME`, `PICKUP_*`, `SELLER_REQUISITES_*`.
`output: 'standalone'` Vercel не мешает. Критерий готовности:
`DEMO_MODE=true pnpm --filter @detaly/web build && next start` без `DATABASE_URL`/`REDIS_URL`
отдаёт главную, поиск OC90, корзину, `/docs/offer`, `/o/demo`, `/api/health`. Инструкция в
`docs/demo-vercel.md`.

## 6. Пакеты работ

Правило: P1, P2 и P3 файлы друг друга не трогают. Всё общее делает F до них. Все `data-testid`,
`aria-label`, тексты бейджей и подписи, на которые смотрят e2e (`Артикул детали`, `Найти`,
`В корзину`, `Оформить заказ`, `Отменить заказ`, `Искать по артикулу`, `О нас`, чекбоксы
согласий, радио `MAX`, тексты `StockBadge`), сохраняются. Каждый пакет прогоняет
`pnpm typecheck`, `pnpm test` (с `scripts/dev-db.sh`) и `pnpm --filter @detaly/web build`.

### F — фундамент (первым)

- `apps/web/package.json`, `pnpm-lock.yaml` — шрифты.
- `apps/web/src/app/globals.css` — токены, псевдонимы, фактура, `.rise`, `.hazard`,
  `.bg-blueprint`, `.bg-tread`, угловые метки, `.legal`, print.
- `apps/web/src/app/layout.tsx` (шрифты, `themeColor #111315`), `apps/web/src/app/not-found.tsx`,
  `apps/web/src/app/(site)/layout.tsx`, `apps/web/src/app/(site)/error.tsx`.
- `apps/web/src/components/SiteHeader.tsx`, `HeaderSearch.tsx`, `Footer.tsx`, `MobileCartBar.tsx`,
  `Requisites.tsx`, `SearchBar.tsx`, `StockBadge.tsx`, `DemoDataBanner.tsx`.
- `apps/web/src/components/ui/{Button,Badge,Card,Input,Field,Chip,Sheet,Section,Container,Price,Eyebrow,PartTile,HazardBand,CornerMarks}.tsx`.
- `apps/web/src/components/icons/{index.tsx,category.ts}`.
- `apps/web/src/components/install/InstallLine.tsx` — финальный вид по `InstallPlanView`.
- Контракты-заглушки: `apps/web/src/server/install/{types.ts,index.ts}` (`index.ts` отдаёт пустую
  карту и `null`); `apps/web/src/server/mode.ts` (`isDemoMode()` пока читает
  `process.env.DEMO_MODE === 'true'`); в `apps/web/src/server/documents.ts` добавить фасад
  `loadPublishedDocument(kind)` с текущим поведением.

### P1 — главная и вау-фича

- `packages/domain/src/{install-window,work-hours,install-load-demo}.ts`, экспорт в
  `packages/domain/src/index.ts`; `packages/domain/test/{install-window,work-hours,install-load-demo}.test.ts`.
- `apps/web/src/server/install/{index,load-source,demo-load-source,bookings-load-source,config}.ts`
  (заменяет заглушку `index.ts`, `types.ts` не меняет), `apps/web/test/install-plan.test.ts`.
- `apps/web/src/app/(site)/page.tsx`.
- `apps/web/src/components/home/{Hero,HeroFacts,InstallWindowDemo,InstallChain,LiftLoadStrip,InstallFormulaSheet,ArticleOrVin,OrderRoute,PickupPointSection,PickupSchematic}.tsx`.
- Удаление `apps/web/src/components/{HowItWorks,TrustBlock,VinCta}.tsx` (используются только на главной).

### P2 — рестайл страниц

- `apps/web/src/app/(site)/{search,cart,checkout,about,returns,vin}/page.tsx`,
  `apps/web/src/app/(site)/docs/[slug]/page.tsx`, `apps/web/src/app/(site)/o/[token]/page.tsx`.
  Docs и returns переходят на `loadPublishedDocument`. Checkout в начале проверяет
  `isDemoMode()` и рендерит `DemoCheckoutNotice`.
- `apps/web/src/components/{OfferRow,AddToCartForm,CartLineRow,CartSummary,DiffBanner,EmptyState,LegalDocumentView,PaymentModeNotice}.tsx`.
- `apps/web/src/components/search/{FilterChips,ResultsHeader,OfferGroup}.tsx`.
- `apps/web/src/components/checkout/*`, `apps/web/src/components/order/*` (+ `OrderStepper.tsx`).
- `apps/web/src/components/demo/DemoCheckoutNotice.tsx`.
- `apps/web/src/lib/markdown.tsx` — только разметка, если нужна.
- Вызовы `planInstallForOffers` / `planInstallForDate` из страниц search и `o/[token]`.

### P3 — демо-режим и Vercel

- `packages/config/src/{env,index}.ts`, тесты config, `.env.example`.
- `packages/rossko/src/memory.ts` (+ экспорт в `index.ts`, тест).
- `apps/web/src/server/{mode,db,redis,supplier,search,settings,documents,checkout-gate,health,startup-checks}.ts`,
  `apps/web/src/server/cart/{index,count}.ts`, `apps/web/src/server/demo/*`.
- `apps/web/src/proxy.ts`, `apps/web/src/instrumentation.ts`, `apps/web/src/app/api/**`,
  `apps/web/src/app/admin/layout.tsx`, `apps/web/src/app/(site)/o/demo/page.tsx`.
- `apps/web/next.config.ts`, `apps/web/vercel.json`, `apps/web/scripts/gen-legal-bundle.ts`,
  `apps/worker/src/create-deps.ts`, `docs/demo-vercel.md`, `apps/web/test/demo-*.test.ts`.

После слияния: общий прогон e2e (`screens.spec.ts` переснимает скриншоты), ревью по
анти-чеклисту и проверка на 375 px: нет горизонтального скролла, полоса корзины не перекрывает
кнопки.
