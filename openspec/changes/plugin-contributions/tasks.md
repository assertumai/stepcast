## 1. Контракт и реестр

- [x] 1.1 `src/core/plugins/contract.ts`: типы `StepcastPlugin`, `BackendContribution`, `PredicateContribution`, `CommandContribution`, `LoadedPlugin`; zod-схема `StepcastPluginSchema` для валидации объекта по умолчанию (имя — слаг kebab-case; `schema` предиката — объект; `create`, `evaluate`, `run` — функции).
- [x] 1.2 `src/core/plugins/registry.ts`: тип `Registry` с картами `backends`, `predicates`, `commands` и списком `plugins`; `builtinRegistry()`; `addPlugin(registry, plugin, source)` с отказом на конфликт имён — сообщение называет вид вклада, имя и обоих претендентов («встроенный» либо имя плагина).
- [x] 1.3 `src/core/plugins/builtin.ts`: встроенные вклады — бэкенд `claude` (фабрика `createClaudeAdapter`) и все команды CLI полноценными вкладами; встроенные предикаты — перечнем имён `BUILTIN_PREDICATE_NAMES` (девять: `exit_code`, `file_exists`, `schema`, `matches`, `not_matches`, `changed_only`, `knowledge_valid`, `cmd`, `judge`), а не вкладами с `evaluate`: их модель типизирована и вычисляется `switch`, проверяемым на полноту, — обмен девяти проверенных ветвей на девять приведений типа изменение не делает (design.md, решение 3). Комментарии объясняют оба выбора.
- [x] 1.4 Тесты `test/plugin-registry.test.ts`: встроенный реестр содержит все имена бэкендов, команд и встроенных предикатов; конфликт с встроенным и между двумя плагинами даёт ошибку с обоими претендентами; разные виды с одним именем не конфликтуют.

## 2. Ключ `plugins` в конфигурации и загрузчик

- [x] 2.1 `src/core/config/schema.ts`: `plugins: z.array(z.string().min(1)).min(1).optional()` в `RawConfigSchema`; `UNION_LIST_KEYS` пополняется `plugins`; комментарий — почему пустой список отклоняется и почему ключ допустим в обоих слоях.
- [x] 2.2 `src/core/config/resolve.ts`: `Config.plugins: readonly string[]` по образцу `env_deny` — объединение слоёв и схлопывание повторов даёт сам `mergeLayers` через `UNION_LIST_KEYS`. Файл объявления, нужный для разрешения относительного пути, берётся не из `Config`, а из `denyContributions` результата разрешения (там источник каждого вклада уже есть): `pluginDeclarations(resolved)` в загрузчике строит пары «строка — файл объявления». Заводить второе представление списка в `Config` не нужно и вредно: оно разошлось бы с отчётом `stepcast config`, который читает те же вклады.
- [x] 2.3 `src/core/plugins/load.ts`: `loadPlugins(config, { projectRoot, engineRoot })` — разрешение `./`/`../` от файла объявления, иначе `createRequire(join(projectRoot, 'package.json')).resolve`, запасной вариант от каталога движка; `import()` по `pathToFileURL`; валидация экспорта по умолчанию; отказ — `StepcastError` с кодом `configError`, строкой объявления, файлом и причиной.
- [x] 2.4 Тесты `test/plugin-load.test.ts` на поддельных модулях во временном каталоге: путь от файла объявления; пакет из `node_modules` проекта; отсутствующий модуль; модуль без экспорта по умолчанию; объект без `name`; объединение слоёв и схлопывание повтора.
- [x] 2.5 Перегенерировать `schema/config.schema.json` (`npm run schema`), убедиться, что `plugins` описан массивом строк с `minItems: 1`.

## 3. Бэкенды через реестр

- [x] 3.1 `src/core/backend/registry.ts`: `resolveAdapter(name, config, registry = builtinRegistry())` — запись в `config.backends` обязательна (прежняя ошибка), вклад обязателен (новая ошибка с перечнем доступных адаптеров); `switch` удалён.
- [x] 3.2 `src/core/config/plugins-defaults.ts` (или в `resolve.ts`): `applyPluginDefaults(resolved, registry)` — слой `plugin:<имя>` между `builtin` и глобальным конфигом, пересборка только `backends.<имя>`; проверка `GLOBAL_ONLY_KEYS` для `command` из умолчаний не применяется (умолчания — не проектный файл), а для проектного слоя — как прежде.
- [x] 3.3 `RunOptions.registry`, `RunContext.registry`; `adapterOf` и `judgePass.adapterFor` идут через реестр. `lintPipeline` получает `registry` в `LintOptions` и проверяет бэкенд судьи против реестра: настроенный, но не предоставленный бэкенд — ошибка линта с перечнем доступных.
- [x] 3.4 Тесты `test/backend.test.ts`, `test/config.test.ts`, `test/lint.test.ts`: плагинный бэкенд у шага и у судьи проходит сквозной прогон с поддельным адаптером из плагина; «настроен, но не предоставлен» отказывает до первой работы; умолчания плагина видны с источником `plugin:<имя>`, перекрываются глобальным конфигом, не трогают остальные ключи и происхождение.

## 4. Предикаты через реестр

- [x] 4.1 `src/core/pipeline/schema.ts`: `predicateSchema(registry)` — объединение встроенных ветвей и по ветви `z.object({ [name]: z.unknown() }).strict()` на плагинный предикат; `StepSchema`, `UntilSchema`, `JobDocumentSchema`, `PipelineDocumentSchema` становятся функциями от реестра с константными версиями для встроенного реестра (`scripts/schema-targets.ts` продолжает печатать встроенные).
- [x] 4.2 `src/core/pipeline/model.ts`: вариант `{ kind: 'plugin'; name: string; value: unknown }` в `Predicate`.
- [x] 4.3 `src/core/pipeline/expand.ts`: `ExpandOptions.registry`; `toPredicate` проверяет значение плагинного предиката через ajv по JSON Schema вклада — отказ `StepcastError` с путём поля и сообщением ajv; неизвестный ключ — отказ с перечнем доступных ключей (встроенные и плагинные).
- [x] 4.4 `src/core/expect/evaluate.ts`: `evaluatePredicates` становится `async`, получает реестр; ветка `plugin` зовёт `evaluate` вклада, приводит результат к `PredicateResult` с `predicate: name` и `hard` по вкладу (по умолчанию `true`). Три вызова в `runner.ts` получают `await`; порядок и правило отмены судьи сохраняются.
- [x] 4.5 `src/core/lint.ts`: для `kind: 'plugin'` зовётся `lint` вклада с `LintSite { file, at, cwd, substitutions }`; диагностики печатаются как встроенные. Предупреждения о составе `expect` считают плагинный предикат структурным.
- [x] 4.6 Убедиться, что `stepKey.ts`, `lock.ts`, `resumePlan.ts` и витрина видят плагинный предикат как данные и правок не требуют; зафиксировать тестом, что ключ шага меняется при смене значения плагинного предиката.
- [x] 4.7 Тесты `test/expect.test.ts`, `test/expand.test.ts`, `test/run.test.ts`, `test/until.test.ts`: значение не по схеме отклоняется разбором; неизвестный ключ называет доступные; вычислитель вызывается в объявленном порядке, синхронный и асинхронный; жёсткий отказ плагинного предиката отменяет судью; предикат в `until.check`; результат в `status.json` с именем из реестра; `stepcast status` читает прогон без плагина.

## 5. Команды через реестр

- [x] 5.1 `src/cli/main.ts`: порядок `resolveConfig → loadPlugins → applyPluginDefaults → parseArgs(registry.commands) → run вклада`; `switch` удалён; встроенные команды переезжают во вклады `builtin.ts` с сигнатурой `run(args, io, env)`. Отказ загрузки печатается `reportError` с кодом `configError` до диспетчеризации.
- [x] 5.2 Справка и ошибка «неизвестная команда» перечисляют команды из реестра, включая плагинные.
- [x] 5.3 Тесты `test/cli-plugins.test.ts`: команда плагина с флагом исполняется и возвращает свой код; неизвестная команда называет плагинную среди доступных; `stepcast config` при отказе загрузки не печатает конфигурацию.

## 6. Манифест, отчёт, публикуемый подпуть

- [x] 6.1 `src/core/journal/schema.ts`: `plugins: z.array({ name, version?, source }).optional()` в `RunManifestSchema`; `runner.ts` пишет список (пустой без плагинов); читатели принимают манифест без поля.
- [x] 6.2 `src/cli/commands/config.ts`: раздел «Плагины» — имя, версия, путь модуля, источник объявления, вклады по видам; вклад слоёв в `plugins` по образцу `env_deny`.
- [x] 6.3 `src/plugin.ts` и `package.json` `exports["./plugin"]`: реэкспорт типов контракта и `runProcess`, `emptyUsage`, `mergeUsage`, `sumUsage`, `describeRefusal`, `EvaluationInput`, `PredicateResult`, `CommandSpec`, `ParsedArgs`, `CliIo`. Тест по образцу `packaged-schema.test.ts`: подпуть разрешается из поддельной установки пакета.
- [x] 6.4 `stepcast diff` печатает различие в списке плагинов двух прогонов; тест в `test/diff.test.ts`.

## 7. Документы

- [x] 7.1 Новый `docs/plugins.md`: ключ `plugins`, разрешение путей, контракт с примером плагина (бэкенд с умолчаниями, предикат с JSON Schema и `lint`, команда), конфликты имён, доверие (плагин — код с правами процесса), известное ограничение генерируемой схемы документа.
- [x] 7.2 `docs/config.md`: ключ `plugins` рядом с `env_deny` (складывающийся список), отчёт о плагинах, источник `plugin:<имя>`.
- [x] 7.3 `docs/pipeline-format.md`: раздел о предикатах пополняется плагинным предикатом и правилом «неизвестный ключ — отказ разбора с перечнем»; оговорка об асинхронном первом проходе.
- [x] 7.4 `docs/run-layout.md`: поле `plugins` манифеста.
- [x] 7.5 `README.md`: одна строка в «Принципах» или «Раскладке» о плагинах со ссылкой на `docs/plugins.md`.
- [x] 7.6 `openspec/changes/plugin-contributions/status.md`: раздел «Работает» и «Известные ограничения» (генерируемая схема без плагинных предикатов; семантика плагинного предиката не входит в ключ шага); `npm run status:build`.

## 8. Проверка целиком

- [x] 8.1 `npm run check` зелёный; `stepcast lint .stepcast/pipelines/self-improve.yml` без новых диагностик; раскрытый пайплайн петли байт в байт совпадает с прежним (`pipeline.lock.yml` без изменений при пустом `plugins`).
- [x] 8.2 `openspec validate plugin-contributions --strict` проходит.
