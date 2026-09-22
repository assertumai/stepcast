## Why

Витрина (`stepcast up`) выросла экран за экраном и читается как черновик:
русские подписи вперемешку с английскими идентификаторами, голые `<button>` и
`<input>` рядом с компонентами `@stepcast/ui`, экран «Шаги» без единого
действия, экран «Виджеты», где нечего добавить, экран «Предложения» из
хэшей с подписью «очередь пуста», и повсюду следы грязных прогонов: проекты
из `/var/folders/...`, оставленные тестами и eval-раннером, и абсолютный путь
локального релиза `~/.stepcast/releases/…-dirty/src/builtin/routes.yml` в
подписи встроенного слоя.

## What Changes

- **Английский язык** для всего, что видит браузер: страницы `ui/src`,
  заголовки экранов (`declaration.ts`), тексты ошибок и подсказок в ответах
  `/api/*` и в потоке событий. CLI, комментарии и документация — по-прежнему
  по-русски.
- **`@stepcast/ui` пополнен** Badge, Label, Separator, Alert, Switch,
  Combobox, PageHeader, EmptyState — без новых зависимостей; версия таблицы
  общих модулей поднята до 2. Все страницы переведены на эти компоненты.
- **Меню группами**: маршрут получает `nav.group`, поставка объявляет
  `work` / `extend` / `system`.
- **`/steps` удалён** целиком: экран, маршрут, строка, `/api/steps`.
  Модуль `src/parts/ui/steps.ts` остаётся ради `uses:` на экране пайплайнов.
- **Каталог виджетов** в `src/builtin/widgets/` (`clock`, `projects`,
  `active-runs`, `usage-today`), экран «Widgets» показывает каталог с превью
  и кнопкой «Add to project»; `GET /api/widgets/catalog`,
  `POST /api/widgets/install`, модуль превью по ключу `builtin`.
- **«Agents»**: поле модели — Combobox со свободным вводом и поиском; варианты —
  из CLI агента плюс уже сохранённые в конфигурации имена.
- **«Proposals»**: объяснение сущности в шапке, только проекты с записями,
  имя проекта из пути, вкладки Pending / Resolved.
- **Проекты-призраки**: демон при старте вычёркивает проекты, чей путь
  больше не существует (`pruneOrphanProjects`), вместе с каталогом прогонов
  и записями расхода; экраны пропускают проекты с исчезнувшим путём;
  встроенный слой маршрутов подписан `bundled` без абсолютного пути.

## Capabilities

### Modified Capabilities

- `ui-dashboard`, `ui-daemon`, `run-cleanup` — дельты в `specs/`.

## Impact

- Браузерные тесты `ui/test/*` и серверные `test/ui-*.test.ts` — ожидания
  переведены; новые: `test/ui-widgets-catalog.test.ts`,
  `ui/test/agents.test.tsx`, тесты каталога в `ui/test/widgets.test.tsx`.
- `docs/widgets.md`, `docs/proposals.md`, `docs/routes.md`,
  `docs/ui-plugins.md`, `docs/plugins.md`, `docs/pipeline-format.md`.
- Дизайн (на английском): `docs/superpowers/specs/2026-09-22-ui-overhaul-design.md`;
  план: `docs/superpowers/plans/2026-09-22-ui-overhaul.md`.
