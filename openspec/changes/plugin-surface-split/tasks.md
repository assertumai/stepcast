## 1. Закрепить нынешнее поведение до переезда объявлений

- [x] 1.1 `test/plugin-load.test.ts`: убедиться, что проверка «отдаёт автору плагина ровно объявленную поверхность» перечисляет значения ядерного подпутя поимённо, и дополнить её перечнем доменных значений (`emptyUsage`, `mergeUsage`, `sumUsage`, `describeRefusal`, `effectivePermissions`, `defineBackend`, `definePredicate`, `defineStepKind`) — после переезда этот же перечень станет проверкой их отсутствия.
- [x] 1.2 `npm run test:only` зелёный на этих проверках до правок кода.

## 2. Доменная половина контракта выезжает из ядра

- [x] 2.1 Завести `src/core/plugins/pipeline-contract.ts`: доменные объявления вклада (`BackendContribution`, `PredicateContribution`, `StepKindContribution` и родня — `StepKindInput`, `StepKindOutcome`, `StepKindLog`, `StepKindDocumentForm`, `StepKindDecision*`, `DecisionEffect`, `DecisionOutcome`, `DecisionHalt`, `LintSite`), внутренние формы (`Native*`, `isNative*`, `has*Executor`), их схемы загрузки, `StepcastPluginSchema`, `DECLARATIVE_CONTRIBUTION_FIELDS` и доменная форма плагина (`PipelinePlugin`). Заголовок модуля называет его временное место и шаг 10 (design.md, Решение 3).
- [x] 2.2 Туда же — доменные объявления контекста: `PredicateRegistrar`, `StepKindRegistrar`, `PipelineContext extends Context` (design.md, Решение 4) и `PipelineCommandEnv extends CommandEnv` (Решение 6).
- [x] 2.3 `src/core/plugins/contract.ts`: остаются ядерные объявления — `CommandContribution<E extends CommandEnv = CommandEnv>`, ядерный `CommandEnv` (`cwd`, `ctx`, `pluginTree`, `pluginOutcomes`), `PluginDiagnostic`, `LoadedPlugin`, `ContextPlugin*`, `isContextPlugin`, ядерная форма `StepcastPlugin` (`name`, `version`, `commands`); импортов `core/backend/**`, `core/config/**`, `core/expect/**`, `core/journal/**`, `core/pipeline/**` в модуле не остаётся ни одного.
- [x] 2.4 `src/core/plugins/context.ts`: `Context` теряет `backends`, `predicates`, `steps`; остаются `commands` и способности области. Докстринг переписан: сервис пайплайна объявляет строка, и его поле — у доменного контекста.
- [x] 2.5 `src/core/plugins/define.ts`: остаётся `definePlugin` ядерной формы; `defineBackend`, `definePredicate<T>`, `defineStepKind<F>` вместе с `Typed*Contribution` переезжают в доменный модуль, семантика не меняется (design.md, Решение 8).
- [x] 2.6 Импортёры внутри ядра переключаются на соседа: `src/core/plugins/registry.ts`, `src/core/plugins/load.ts`; прочие импортёры `contract.js` вне `src/core/plugins/**` (`core/pipeline/**`, `core/run/**`, `core/exec/**`, `core/lint.ts`, `src/ui/pipelines.ts`, `src/parts/**`) — на тот модуль, где теперь лежит нужное им имя. Поведение загрузки и реестра не меняется.
- [x] 2.7 `npm run typecheck` зелёный: ядро и домен разошлись по модулям, поверхность ещё прежняя.

## 3. Два подпутя

- [x] 3.1 Завести `src/parts/pipeline/surface.ts` — публикуемая поверхность `stepcast/pipeline`: доменные объявления вклада и контекста из `pipeline-contract.js`, поверхность бэкенда (`core/backend/types.js`, `effectivePermissions`), `Permissions`/`McpServer(s)`, `EvaluationInput`, `PredicateResult`, `Usage`, `Config`/`BackendConfig`, `Registry`, четыре хелпера (`definePipelinePlugin`, `defineBackend`, `definePredicate`, `defineStepKind`). Ядерных имён не реэкспортирует (design.md, Решение 9).
- [x] 3.2 Там же — `pipelineContext(ctx)`: сужение с проверкой трёх сервисов и `StepcastError` с подсказкой про `inject`, если состав их не несёт (design.md, Решение 5).
- [x] 3.3 `src/parts/pipeline/services.ts`: доменный близнец `pluginContext()` — функция, которой компилятор проверяет соответствие настоящего контекста объявленному `PipelineContext` (design.md, Решение 4).
- [x] 3.4 `src/plugin.ts`: только ядерные имена; в заголовке — таблица переезда «прежнее имя → `stepcast/pipeline`» и причина разрыва (design.md, Решение 7).
- [x] 3.5 `package.json`: `exports["./pipeline"] = "./dist/src/parts/pipeline/surface.js"`.

## 4. Плагины поставки и встроенные команды

- [x] 4.1 `src/backends/codex/index.ts` и `adapter.ts`: вклад и типы бэкенда — из `../../parts/pipeline/surface.js`, `StepcastError` — из `../../plugin.js`.
- [x] 4.2 `src/parts/steps/decision/index.ts` и `fields.ts`: `defineStepKind`, `StepKindOutcome`, `DecisionEffect`, `DecisionOutcome`, `LintSite` — из доменной поверхности, `parseDuration` и `PluginDiagnostic` — из ядерной.
- [x] 4.3 `src/cli/main.ts`: `BUILTIN_COMMANDS` аннотируется `CommandContribution<PipelineCommandEnv>[]`, `buildIndependentCommandEnv` возвращает то же окружение; тела команд не трогаются.
- [x] 4.4 Проверить командные модули `src/cli/commands/**`, аннотирующие окружение явно, и перевести их на доменное окружение там, где они читают `config`/`registry`.

## 5. Образцы

- [x] 5.1 `examples/plugins/typed/index.ts`: `definePipelinePlugin`, `definePredicate`, `defineStepKind` — из `stepcast/pipeline`; комментарий о том, что образец показывает именно доменный подпуть.
- [x] 5.2 Завести `examples/plugins/command/index.ts` — плагин, вносящий одну команду и знающий только `stepcast/plugin` (`definePlugin`, `CommandContribution`, `CliIo`, `ParsedArgs`, `StepcastError`).
- [x] 5.3 `examples/plugins/command/tsconfig.json` по образцу `typed/tsconfig.json`: разрешение подпутя самоссылкой пакета, без `paths`; комментарий называет, что этот образец — проверка признака «плагин ядра компилируется без доменного подпутя».
- [x] 5.4 `package.json`: третий проект в `typecheck:plugin`.
- [x] 5.5 `examples/README.md`: назвать образцы движковой половины плагина — `typed/` (доменный вклад) и `command/` (только ядро) — рядом с браузерными `board/` и `element/`.

## 6. Границы под машинной проверкой

- [x] 6.1 `eslint.config.js`: снять исключение блока `src/core/plugins/contract.ts` (`backend/types.js`); завести блок для `src/core/plugins/pipeline-contract.ts` с теми доменными импортами, которые он действительно несёт, и комментарием о шаге 10.
- [x] 6.2 `test/eslint-config.test.ts`: проверки под новый состав блоков — прежнее исключение снято, новое действует именно на доменном модуле.
- [x] 6.3 `test/plugin-surface.test.ts`: вторым законным направлением для `src/backends/**` и `src/parts/steps/decision/**` становится `src/parts/pipeline/surface.ts`; докстринг называет оба подпутя, разбор форм импорта не меняется.
- [x] 6.4 `test/plugin-load.test.ts`: `stepcast/pipeline` разрешается в поддельной установке пакета; состав экспорта обоих подпутей — доменные значения есть в доменном и отсутствуют в ядерном (перечень из задачи 1.1).
- [x] 6.5 Тест: импорт ядерного подпутя не грузит доменных модулей — проверить по графу загрузки собранного `dist/src/plugin.js` (специфики его собственных импортов), тем же приёмом разбора, что и в `test/plugin-surface.test.ts`.
- [x] 6.6 `test/plugin-helpers.test.ts` и `test/codex-adapter.test.ts`: импорты по новому делению; `test/example-plugin.test.ts` — образец `typed` собирается и его схемы вкладываются печатью схемы проекта, как прежде.

## 7. Документация

- [x] 7.1 `docs/plugins.md`: раздел «Два подпутя» — критерий деления, что где лежит, оба образца; таблица переезда доменных имён; записанный выбор «прежние импорты ломаются, реэкспорта нет» с причиной (признак выполненности пункта требует записать именно это).
- [x] 7.2 `docs/plugins.md`, раздел «Контекст, область и сервис»: доменный контекст и сужение `pipelineContext` вместо полей `ctx.backends`/`ctx.steps` на ядерном контексте; примеры плагина контекста обновлены.
- [x] 7.3 `docs/microkernel-target.md`: шаг 8 отмечен выполненным с уточнениями (деление имён, разрыв вместо реэкспорта) и названными остатками — `pipeline-contract.ts`, `registry.ts` и таблица декларативной формы уезжают шагом 10, таблица — параметром сборки на шаге 9.

## 8. Проверка

- [x] 8.1 `npm run check` зелёный целиком.
- [x] 8.2 `npm run typecheck:plugin` зелёный на всех трёх образцах, в том числе на `command/` — без доменного подпутя в его импортах.
- [x] 8.3 `openspec validate plugin-surface-split --strict` проходит.

## 9. Правки по ревью

- [x] 9.1 `test/plugin-load.test.ts`: разбор графа загрузки видит `export … from '…'` наравне с `import` — иначе обход `dist/src/plugin.js` (сплошной реэкспорт) состоял из одного узла и прошёл бы при любом откате; добавлена проверка, что граф не вырожден (обход доходит до `core/errors.js`, `core/exec/process.js`, `core/units.js`, `core/plugins/define.js`).
- [x] 9.2 `src/parts/pipeline/surface.ts`: доменная форма плагина `PipelinePlugin` публикуется типом — хелпер необязателен, и литерал с аннотацией больше нечем было аннотировать; пропуск ловится компиляцией (`test/plugin-helpers.test.ts`), а не только составом значений.
- [x] 9.3 `src/parts/pipeline/surface.ts`: `DecisionHalt` из подпутя убран — класс заводится и ловится только внутри движка, прежним подпутём не публиковался и в таблице переезда стоять не мог; таблицы в `docs/plugins.md` и `src/plugin.ts` исправлены, строка про доменные поля контекста названа тем, чем она есть.
- [x] 9.4 `eslint.config.js`: доменные деревья `expect/**` и `journal/**` закрыты ядру плагинов наравне с `backend/**`; из `config/**` разрешены два поимённо названных модуля (остаток шага 10); блок `pipeline-contract.ts` перечисляет ровно тот набор доменных модулей, который он несёт. `test/eslint-config.test.ts` доказывает обе стороны.
- [x] 9.5 `test/plugin-helpers.test.ts`: сценарий «Доменный ключ в ядерной форме плагина» проверяется машинно — `@ts-expect-error` на `definePlugin({ …, steps })` и на литерале с аннотацией `StepcastPlugin`.
- [x] 9.6 `src/parts/pipeline/surface.ts`: `pipelineContext(ctx, [...])` проверяет названное подмножество сервисов, а подсказка отказа различает необъявленную зависимость и состав, не заводящий имени вовсе; спека и `docs/plugins.md` дополнены, оба исхода покрыты в `test/plugin-kernel.test.ts`.
- [x] 9.7 `docs/microkernel-target.md`: остаток шага 2 («`contract.ts` сохраняет импорт `backend/types.js`») снят — он противоречил отмеченному выполненным шагу 8.
