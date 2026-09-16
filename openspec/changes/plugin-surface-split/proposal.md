## Why

Шаг 8 плана `docs/microkernel-target.md` — последняя дорога, которой домен
возвращается в ядро. Шаг 7 (`pipeline-owns-services`) убрал доменные имена из
сборки ядра: `createKernel()` заводит один сервис `commands`, а `backends`,
`predicates` и `steps` объявляет строка `pipeline`. Но публикуемая поверхность
осталась одна на двоих, и через неё домен по-прежнему живёт в модулях ядра:

- `src/core/plugins/contract.ts` импортирует `core/backend/types.js`,
  `core/config/resolve.js`, `core/config/schema.js`, `core/expect/evaluate.js`
  и `core/journal/schema.js` — ради типов вклада, которые `src/plugin.ts`
  реэкспортирует. Исключение линта на первый из них заведено с пометкой
  «снятие исключения — шаг 8» (`eslint.config.js`); сам `src/plugin.ts` тянет
  сверх того `core/backend/permissions.js` и `core/pipeline/model.js`;
- `src/core/plugins/context.ts` объявляет `Context` с полями `backends`,
  `predicates` и `steps`, типизированными доменными вкладами, — контекст ядра
  знает по именам то, чего само ядро уже не заводит;
- `CommandEnv` несёт `config: Config` и `registry: Registry` — обе модели
  доменные: первая перечисляет бэкенды и проект, вторая — карты бэкендов,
  предикатов и видов шага.

Отсюда следствие, ради которого шаг и назван в плане отдельным: пока подпуть
один, вынос сервисов остаётся формальным. Автор плагина, пишущий команду или
плагин контекста, всё равно тянет объявления пайплайна; `import … from
'stepcast/plugin'` в рантайме грузит `core/backend/types.js` и
`core/backend/permissions.js`; а любая правка доменной модели становится
правкой публичной поверхности ядра.

**Почему сейчас.** Раньше делить было нечего: до шага 7 три доменных сервиса
объявляло само ядро, и поверхность лишь повторяла его устройство. Теперь
устройство другое — сервисы заводит строка, — и поверхность обязана повторить
именно его: у строки `pipeline` свой подпуть, как у ядра свой.

## What Changes

- **Два подпути вместо одного.** `stepcast/plugin` остаётся поверхностью ядра;
  доменные объявления переезжают в новый подпуть `stepcast/pipeline`, чей
  модуль лежит у строки, которая эти сервисы и заводит, —
  `src/parts/pipeline/surface.ts`. `package.json` объявляет оба; `stepcast/step`
  и `stepcast/backends/codex` не трогаются.
- **Критерий деления назван и применён к каждому имени:** знает ли объявление о
  пайплайне. В ядре остаются контекст и его области, дерево строк, каркас CLI
  (`CliIo`, `CommandSpec`, `ParsedArgs`, `FlagSpec`), диагностика
  (`StepcastError`, `ExitCode`), `PluginDiagnostic`, `parseDuration`,
  `runProcess`, `definePlugin`, формы плагина контекста и `LoadedPlugin`. В
  домен уходят `BackendContribution`, `PredicateContribution`,
  `StepKindContribution` со всей роднёй (`StepKindInput`, `StepKindOutcome`,
  `StepKindLog`, `StepKindDocumentForm`, `StepKindDecision*`, `DecisionEffect`,
  `DecisionOutcome`, `LintSite`), вся поверхность бэкенда (`BackendAdapter`,
  `BackendEvent`, `BackendModel`, `BackendRefusal*`, `LaunchSpec`,
  `AgentInvocation`, `ModelDiscovery`, `ProbeOutput`, `PermissionDenial`,
  `BackendCapabilities`, `describeRefusal`, `emptyUsage`, `mergeUsage`,
  `sumUsage`, `effectivePermissions`, `Permissions`, `McpServer(s)`),
  `EvaluationInput`, `PredicateResult`, `Usage`, `Config`, `BackendConfig` и
  хелперы `defineBackend`, `definePredicate`, `defineStepKind`.
- **Контекст ядра перестаёт называть доменные сервисы.** Публикуемый `Context`
  объявляет `commands` и способности области (`effect`, `get`, `set`,
  `provide`, `inject`); `backends`, `predicates` и `steps` объявляет
  `PipelineContext` из доменного подпути. Ему же принадлежат
  `PredicateRegistrar` и `StepKindRegistrar`. Автору, которому в теле
  `ctx.inject([...], …)` нужен доменный контекст, доменный подпуть даёт
  `pipelineContext(ctx)` — сужение с названным отказом, если состав этих
  сервисов не несёт (голая аннотация параметра обратного вызова в `inject`
  проверяется контравариантно и не компилируется).
- **Окружение команды делится тем же критерием.** `CommandEnv` ядра — `cwd`,
  `ctx`, `pluginTree`, `pluginOutcomes`; `config` и `registry` объявляет
  `PipelineCommandEnv` доменного подпути. `CommandContribution` становится
  обобщённым по окружению с ядерным умолчанием, так что команда пайплайна
  объявляется без единого приведения, а команда, которой хватает `cwd`,
  компилируется, не зная о пайплайне вовсе.
- **Доменная половина контракта выезжает из `contract.ts`** в соседний модуль
  `src/core/plugins/pipeline-contract.ts`: доменные типы вклада, их схемы
  загрузки, внутренние формы (`native`), таблица ключей декларативной формы и
  доменные объявления контекста. Ядерный `contract.ts` перестаёт импортировать
  `core/backend/**` — исключение линта снимается, как и обещано шагом 2.
  Соседство с ядром — временное: шаг 10 переносит модуль в
  `src/parts/pipeline/`, и это единственное, что мешает сделать так сразу
  (`registry.ts` и загрузчик читают доменные типы, а ядру импортировать
  `src/parts/**` запрещено — Решение 3 шага 2).
- **BREAKING: доменные имена больше не импортируются из `stepcast/plugin`, и
  реэкспорта с пометкой об устаревании не заводится.** Половина переехавших
  имён — значения (`effectivePermissions`, `emptyUsage`, `describeRefusal`,
  `defineBackend`), и реэкспорт вернул бы домен в рантайм-граф ядра, то есть
  ровно то, ради чего шаг и делается; типовой реэкспорт вернул бы его в граф
  объявлений. Половинчатая совместимость — реэкспорт типов без значений —
  разошлась бы с самой собой. Подсказку несёт не компилятор (он называет
  недостающее имя), а таблица переезда в `docs/plugins.md` и в заголовке
  `src/plugin.ts`; выбор записан в `docs/plugins.md`, как требует пункт очереди.
- **Плагины поставки переписаны на новое деление:** `src/backends/codex`
  (адаптер — доменный подпуть, `StepcastError` — ядерный),
  `src/parts/steps/decision` (вклад — доменный, `parseDuration` — ядерный),
  образец `examples/plugins/typed`. Образцы `board/` и `element/` — браузерная
  половина плагина, движковой поверхности не касаются и не правятся.
- **Новый образец kernel-only:** `examples/plugins/command/` — плагин, который
  вносит одну команду и не знает о пайплайне. Он и есть машинная проверка
  признака «плагин, пользующийся только ядром, компилируется без доменного
  подпути»: входит в `npm run typecheck:plugin` и разрешает `stepcast/plugin`
  самоссылкой пакета, как и `typed`.
- **Граница проверяется машиной, а не соглашением:** `test/plugin-surface.test.ts`
  признаёт вторым законным направлением доменный подпуть; проверка состава
  экспорта (`test/plugin-load.test.ts`) сверяет оба подпути — что ядерный не
  отдаёт доменных имён, а доменный отдаёт, — и что `stepcast/pipeline`
  разрешается в поддельной установке пакета наравне с `stepcast/plugin`.

Прочих ломающих изменений нет: состав дефолта, дерево строк, реестр, прогоны,
диагностика и схема проекта остаются прежними — меняются адреса объявлений, а
не поведение.

## Capabilities

### New Capabilities

Новых нет: обе затронутые способности уже существуют.

### Modified Capabilities

- `plugin-contributions`: публичная поверхность вклада делится на два подпути
  по знанию о пайплайне; хелперы объявления публикуются подпутём того вклада,
  который объявляют; переезд доменного имени ломает прежний импорт и называет
  новый адрес документом, а не реэкспортом; плагины поставки пишутся только
  публичными подпутями.
- `plugin-kernel`: контекст ядра и окружение команды не называют доменных
  сервисов и доменных моделей; доменный контекст — тип доменного подпути с
  сужением, дающим названный отказ в составе без пайплайна; модуль ядерной
  поверхности не тянет домена ни в рантайме, ни в объявлениях.

## Impact

- Добавляется: `src/parts/pipeline/surface.ts` — публикуемая поверхность
  `stepcast/pipeline` (доменные объявления и хелперы, сужение контекста);
  `src/core/plugins/pipeline-contract.ts` — доменная половина контракта и
  контекста; `examples/plugins/command/{index.ts,tsconfig.json}` — образец,
  знающий только ядро.
- `src/plugin.ts` — только ядерные имена и таблица переезда в заголовке;
  `src/core/plugins/contract.ts`, `context.ts`, `define.ts` — ядерные половины;
  `src/core/plugins/registry.ts` и `load.ts` — импорт доменных типов от соседа
  (поведение не меняется).
- `package.json` — экспорт `./pipeline` и `typecheck:plugin` с третьим
  проектом; `eslint.config.js` — исключение `contract.ts` снято, доменному
  модулю заведён свой блок с теми же границами, что у поверхности.
- `src/backends/codex/{index.ts,adapter.ts}`, `src/parts/steps/decision/{index.ts,fields.ts}`,
  `examples/plugins/typed/index.ts` — импорты по новому делению;
  `src/cli/main.ts` — встроенные команды объявляются доменным окружением.
- Тесты: `test/plugin-surface.test.ts` (второе законное направление),
  `test/plugin-load.test.ts` (состав обоих подпутей и разрешение
  `stepcast/pipeline`), `test/plugin-helpers.test.ts`,
  `test/codex-adapter.test.ts` (импорты), `test/example-plugin.test.ts`
  (образцы), `test/eslint-config.test.ts` (блоки границ).
- Документация: `docs/plugins.md` — раздел о двух подпутях, таблица переезда и
  записанный выбор «ломается, а не реэкспортируется»; `docs/microkernel-target.md`
  — отметка шага 8 и названные остатки (`registry.ts`, таблица декларативной
  формы и `pipeline-contract.ts` уезжают шагом 10); `examples/README.md` —
  образцы движковой половины плагина.
