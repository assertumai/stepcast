## 1. Закрепить нынешнее поведение тестами

- [x] 1.1 `test/plugin-registry.test.ts`: отказ регистрации плагинного вида шага с именем ключа общей части шага — проверить текст сообщения и подсказку дословно (`Имя вида шага expect занято ключом общей части шага`).
- [x] 1.2 `test/plugin-registry.test.ts`: отказ регистрации плагинного вида шага с именем ключа встроенного вида — проверить текст с перечнем видов-владельцев (`prompt` → `agent`, `on_fail` → `run, script, uses`) и подсказку.
- [x] 1.3 `test/plugin-registry.test.ts`: снимок состава дефолтного дерева — бэкенды, виды шага (включая порядок регистрации встроенных: `run`, `uses`, `script`, `agent`, затем `decision`), зарезервированные имена предикатов, — чтобы переезд было чем сверить.
- [x] 1.4 Убедиться, что `npm run test:only` на этих тестах зелёный до единой правки кода.

## 2. Перенести проверку имени вида шага на сторону домена

- [x] 2.1 `src/core/pipeline/schema.ts`: перенести `assertStepKindNameAvailable` из `plugins/kernel.ts` — оба текста, обе подсказки и порядок проверок дословно; поправить комментарий у `STEP_COMMON_KEYS` («список общий с ядром» → «читает отказ ниже»).
- [x] 2.2 `src/core/plugins/kernel.ts`: объявить `ContributionNameGuard` и `KernelOptions.nameGuards`, принять их в `createKernel(options)` и пробросить в `ContributionService`.
- [x] 2.3 `src/core/plugins/kernel.ts`: заменить в `register` условие `this.kind === 'steps'` на вызов проверки своего вида; правило «вклад области ядра проверку не проходит» оставить.
- [x] 2.4 `src/core/plugins/kernel.ts`: удалить импорт `../pipeline/schema.js` и сам `assertStepKindNameAvailable`.
- [x] 2.5 `src/core/plugins/builtin.ts`: подать проверку в `createKernel` из `createKernelShell`.
- [x] 2.6 Тест: ядро, собранное `createKernel()` без проверок, регистрирует вид шага с именем `expect` без отказа; тесты 1.1–1.2 по-прежнему зелёные на встроенном ядре.

## 3. Вынести встроенный слой и состав дефолта из ядра

- [x] 3.1 `src/core/plugins/load.ts`: объявить тип `BuiltinRow` (перенести из `builtin.ts`) рядом с `LoadOptions.builtinRows`.
- [x] 3.2 `src/core/plugins/load.ts`: переименовать `loadPlugins` → `applyPluginTree` и `inspectPluginTree` → `walkPluginTree`, первым параметром — готовое `Kernel`; убрать вызов `createKernelShell`.
- [x] 3.3 `src/core/plugins/load.ts`: искать фабрику строки только в `options.builtinRows`; удалить импорт `./builtin.js` вместе с `findBuiltinRow` и `BUILTIN_ROW_IDS`; подсказку `unknownBuiltinRow` собирать из поданных строк в их порядке.
- [x] 3.4 Перенести `src/core/plugins/builtin.ts` → `src/parts/builtin.ts` без правки содержания; поправить относительные пути его импортов. Прежний путь остаётся пустой заглушкой `export {}`: удалять файлы агенту нечем (design.md, «Migration Plan»).
- [x] 3.5 Завести `src/parts/load.ts`: `loadPlugins` и `inspectPluginTree` с прежними именами и сигнатурами — поднимают `createKernelShell`, подставляют `BUILTIN_ROWS` перед `options.builtinRows` и зовут ядерную пару.
- [x] 3.6 Перенести `src/core/plugins/resolve.ts` → `src/parts/resolve.ts` без правки содержания; прежний путь — та же пустая заглушка, что и у 3.4.
- [x] 3.7 Тест: `walkPluginTree` на дереве со строкой `stepcast:backend-claude` без поданных строк поставки отказывает как на несуществующей встроенной строке.
- [x] 3.8 Тест: текст подсказки о несуществующей встроенной строке для дефолтного состава прежний, и строки вызывающего идут после строк движка (`test/plugin-tree.test.ts`).

## 4. Провести вызывающих по новым путям

- [x] 4.1 `src/core/`: поправить импорты `builtinRegistry`/`createBuiltinKernel` в `pipeline/expand.ts`, `lint.ts`, `run/runner.ts`, `backend/registry.ts`, `config/resolve.ts` (`BUILTIN_ROW_IDS`).
- [x] 4.2 `src/cli/`: `main.ts` (`resolveWithPlugins`) и `commands/plugins.ts` (`inspectPluginTree`) — на `src/parts/`.
- [x] 4.3 `src/ui/`: `kernel.ts`, `pipelines.ts`, `screens/rows.ts`, `screens/registry.ts` — `loadPlugins`, `resolveWithPlugins`, тип `BuiltinRow`.
- [x] 4.4 `scripts/generate-schema.ts` и тесты, зовущие `builtinRegistry`, `createBuiltinKernel`, `loadPlugins`, `resolveWithPlugins`, — только строка импорта, без правки тел.
- [x] 4.5 Комментарии, называющие прежние расположения (`plugins/builtin.ts` в `expand.ts`, `runner.ts`, `introspect.ts`, `registry.ts` витрины), привести в соответствие.

## 5. Закрыть границу правилом линтера

- [x] 5.1 `eslint.config.js`: объявить `kernelBoundaryPatterns` с деревьями `core/pipeline`, `core/backend`, `core/run`, `steps`, `backends`, `parts`, `ui` и сообщением, называющим шаг 2 плана.
- [x] 5.2 `eslint.config.js`: блок на `src/core/plugins/**/*.ts` (кроме `contract.ts`), перечисляющий одной записью `paths: enginePaths` и `patterns: [...coreBoundaryPatterns, ...kernelBoundaryPatterns]`.
- [x] 5.3 `eslint.config.js`: блок на `src/core/plugins/contract.ts` — те же запреты, но с разрешённым `core/backend/types.js`, с комментарием, называющим шаг 8 плана условием снятия исключения.
- [x] 5.4 `test/eslint-config.test.ts`: модуль ядра плагинов, импортирующий `pipeline/expand.js` значением и типом, отклоняется обоими способами.
- [x] 5.5 `test/eslint-config.test.ts`: `contract.ts` с `backend/types.js` замечаний не получает, с `backend/claude.js` — получает.
- [x] 5.6 `test/eslint-config.test.ts`: на файле ядра плагинов срабатывают одновременно граница ядра плагинов, граница ядра и поверхности и запрет прямого временного каталога.

## 6. Сверить и описать

- [x] 6.1 `npm run typecheck` и `npm run lint` зелёные.
- [x] 6.2 `npm run check` зелёный целиком (включая `typecheck:plugin`, сборку образцов и тесты витрины).
- [x] 6.3 Убедиться, что `grep` по `src/core/plugins/` не находит ни одного импорта запрещённых деревьев, кроме объявленного исключения в `contract.ts`.
- [x] 6.4 `docs/microkernel-target.md`: отметить шаг 2 исполненным, назвав остаток (типовой импорт поверхности), уходящий в шаг 8.

## 7. Правки по ревью

- [x] 7.1 `src/core/plugins/load.ts` + `src/parts/load.ts`: `builtinCommands` уезжает из `LoadOptions` ядерной пары в `DefaultLoadOptions` состава дефолта — поле, которое обход не читает, больше не компилируется в его вызове; `src/parts/resolve.ts` строит `ResolveWithPluginsOptions` на опциях обёртки.
- [x] 7.2 `eslint.config.js` + `test/eslint-config.test.ts`: блок `src/parts/**/*.ts` с `{ paths: enginePaths, patterns: coreBoundaryPatterns }` — граница ядра и поверхности, снятая с переехавших модулей, восстановлена на новом месте и закрыта двумя случаями («импорт поверхности отклоняется», «оба запрета в одном файле»).
- [x] 7.3 `src/parts/builtin.ts`: удалён `findBuiltinRow` — без вызывающих он вёл мимо настоящего пути разрешения строки; шапка файла больше не утверждает, что связь с разбором «не по кругу», а называет цикл и шаг, который его разрывает.
- [x] 7.4 `src/core/plugins/load.ts` + `test/plugin-tree.test.ts`: подсказка отказа о несуществующей встроенной строке на обходе без единой поданной строки называет причину вместо пустого перечня «Пакет поставляет: »; текст закреплён тестом.
- [x] 7.5 `eslint.config.js`: комментарий у `kernelBoundaryPatternsExceptBackend` приведён в соответствие с кодом под ним — отрицание в `group` работает и используется, отдельная группа нужна затем, что исключение действует в ней одной.
- [x] 7.6 `test/eslint-config.test.ts`: случай «блок `contract.ts` не снял ни границы поверхности, ни запрета временного каталога» — для блока исключения та же проверка, что уже была для блока ядра.
