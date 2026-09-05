## Why

Проверка документов изменения записана в файлах работ петли строкой
`${params.spec_tool} validate "${params.change}" --strict` — в
`.stepcast/jobs/verify.yml` (шаг `validate-spec`), в
`.stepcast/jobs/implement.yml`, `.stepcast/jobs/fix-review.yml` и
`.stepcast/jobs/implement-express.yml` (предикат `cmd` в `until`).
Подстановкой оттуда берётся только имя инструмента; грамматика — подкоманда
`validate`, позиция слага, флаг `--strict` — зашита литералом в четыре файла
работ.

Это ровно тот сорт литерала, который из работ уже вычистили три изменения
подряд: `configurable-check-command` вынес команду проверки кода,
`job-tools-declaration` — инструменты, `changed-only-boundaries-declaration` —
границы правок. Репозиторий с другой практикой (`make spec-check`,
`npx spectral lint`, скрипт без подкоманд вовсе) перенести петлю правкой
объявления не может: `make validate "<слаг>" --strict` — это две цели `make` и
неизвестный флаг, и переносящему придётся резать четыре файла работ.

Сторож на такие литералы есть — `test/loop-portability.test.ts`, список
`FORBIDDEN`, — но эту запись он не ловит: слова `openspec` в ней нет, а
грамматика подкоманд ни под один образец не подходит. Цену дыры видно в самом
тесте: сквозной прогон против чужого объявления пришлось перевести на
`spec.tool: "true"` — единственное имя, которое переживёт подстановку в
`<имя> validate <слаг> --strict`, — потому что объявленный там `make` такой
команды не знает. То есть проверка переносимости доказывает переносимость
только на имени, подобранном под чужую грамматику.

Прямого пути объявить полную команду сегодня нет: пространство `${project.*}`
состоит из `check`, `tools`, `edit_paths` и составных `spec.dir`, `spec.rules`,
`spec.tool`, а обращение к имени вне этого состава отказывает разбором.

## What Changes

- **Секция `project.spec` пополняется ключом `check` — полной командой
  проверки документов изменения.** Объявляется наравне с `project.check`:
  непустая строка, которую движок не разбирает, а передаёт оболочке.

  ```yaml
  # .stepcast/config.yml
  project:
    spec:
      dir: openspec/changes
      rules: .stepcast/prompts/spec-rules.md
      tool: openspec
      check: openspec validate "$SPEC_CHANGE" --strict   # make spec-check
  ```

  Слои, запрет глобального слоя, отсутствие умолчания и полистовое слияние —
  те же, что у соседей по группе. Ключ принимает и объектная форма элемента
  `project.nested_repos`: `RawSpecSchema` у них общая.

- **Слаг изменения доезжает до объявленной команды переменной окружения
  `SPEC_CHANGE`.** Её объявляют блоком `env` сами файлы работ петли
  (`SPEC_CHANGE: "${params.change}"`) — там, где слаг известен параметром
  дорожки. Объявление о пространстве `params` при этом не знает ничего: оно
  видит обычную переменную оболочки и вправе её не читать вовсе (команда,
  проверяющая все документы разом, слаг проигнорирует). Переменная уровня
  работы доходит и до шагов, и до предикатов `cmd` в `until` — свойство
  движка, уже закреплённое `test/until-env.test.ts`.

- **Ключ `spec.tool` остаётся и смысла не меняет.** Это имя, из которого
  собирается право `Bash(<tool> *)` работам `propose` и `propose-express`, а
  не команда; команда с аргументами в записи права означала бы другое и
  работала бы не так. Два ключа отвечают на два разных вопроса: чем агенту
  разрешено заводить документы и чем движок их проверяет.

- **Четыре файла работ перестают знать грамматику подкоманд.** `verify`,
  `implement`, `fix-review` и `implement-express` меняют параметр `spec_tool`
  на `spec_check` и зовут `cd "${params.repo_dir}" && ${params.spec_check}`.
  Обвязка обеих петель (`self-improve.yml`, `self-improve-memory.yml`)
  передаёт им `${jobs.slots.output.lanes.<дорожка>.repo.spec.check}`.

- **Разрешение репозитория пункта требует пятой величины.** `resolveItemRepo`
  объявляет полным репозиторий, назвавший `check`, `spec.dir`, `spec.rules`,
  `spec.tool` и `spec.check`; отказ называет первую недостающую по порядку.
  Значение — команда, исполняемая после `cd` в каталог репозитория, поэтому
  приставкой каталога оно не склеивается, в отличие от `spec.dir` и
  `spec.rules`. Блок `repo` выхода `stepcast backlog pick --lanes` (он же
  `artifacts/slots.json`) несёт новое поле, и публикуемая схема — тоже.

- **Сторож переносимости начинает ловить грамматику, а не имя практики.**
  Правило: подстановка имени инструмента (`${params.spec_tool}`,
  `${project.spec.tool}`) допустима в файле работы только внутри записи права
  `Bash(… *)`; любое другое её вхождение — команда, собранная файлом работы из
  чужой грамматики, и отказ называет файл и строку. Вдобавок в `FORBIDDEN`
  входит `--strict`. Проверка обязана падать на сегодняшних четырёх файлах —
  до правки, а не после.

- **Сквозной прогон против чужого объявления перестаёт зависеть от подбора
  имени.** Чужое объявление в `test/loop-portability.test.ts` возвращает
  `tool: make` и объявляет `check: 'test "$SPEC_CHANGE" = demo-change'` —
  команда исполнима в любом дереве и заодно доказывает, что слаг доехал.
  Обходного `spec.tool: "true"` не остаётся.

Ломающих изменений в движке нет: `project.spec.check` — новый необязательный
ключ конфигурации. **BREAKING** для чужого дерева, уже перенёсшего петлю: его
`.stepcast/config.yml` обязан объявить `spec.check`, иначе `stepcast project
repos` откажет на первом же пункте очереди, — та же цена, что платили
`configurable-check-command` и `job-tools-declaration`.

**Чего изменение не обещает.** Оно не отменяет `spec.tool` и не превращает его
в команду. Оно не меняет того, что проверяется у этого репозитория: после
правки гейт исполняет ту же строку `openspec validate "<слаг>" --strict`,
только прочитанную из объявления. Оно не заводит проверки того, что
объявленная команда существует и исполнима, — как и `project.check`, она
проверяется исполнением. Оно не трогает `.stepcast/prompts/spec-rules.md`:
файл правил — то самое место, где практика названа своим именем.

## Capabilities

### New Capabilities

Новых нет: и объявление свойств проекта, и переносимость петли уже описаны
существующими возможностями.

### Modified Capabilities

- `stepcast-configuration`: секция `project.spec` получает ключ `check` —
  полную команду проверки документов изменения, с теми же слоями, запретом
  глобального слоя и отсутствием умолчания, что у `project.check`.
- `pipeline-definition`: состав пространства `project` пополняется именем
  `spec.check`, и документ пайплайна принимает ключ в секции `project`.
- `backlog-queue`: репозиторий, названный пунктом очереди, считается
  объявленным полностью только с `spec.check`, и блок `repo` ответа
  `backlog pick --lanes` несёт эту команду.
- `self-improvement-loop`: гейт документов изменения исполняет объявленную
  команду, а не собирает её из имени инструмента; слаг доезжает до неё
  переменной окружения; файл работы грамматики подкоманд не содержит.

## Impact

Код движка:

- `src/core/config/schema.ts` — `RawSpecSchema` пополняется
  `check: CheckCommandSchema.optional()` (модель та же, что у `project.check`
  и `spec.tool`, — переиспользование, а не копия);
- `src/core/config/resolve.ts` — чтение листа `spec.check`;
- `src/core/pipeline/schema.ts` — `spec` документа пайплайна;
- `src/core/pipeline/expand.ts` — `PROJECT_NAMES` и `resolveProjectValues`;
- `src/core/project/repos.ts` — `ResolvedRepo['spec'].check` и порядок отказа
  в `requireComplete`;
- `src/core/backlog/schema.ts` — блок `repo` ответа `backlog pick --lanes`;
- `src/cli/commands/config.ts` — строка отчёта `stepcast config`.

`src/core/pipeline/interpolate.ts` и `src/core/exec/env.ts` не затрагиваются:
и раскрытие составного имени, и доставка переменной работы до шага и до
предиката `until` уже общие.

Публикуемые схемы `schema/config.schema.json`, `schema/pipeline.schema.json` и
`schema/backlog-slots.schema.json` перегенерируются (`npm run schema`);
`test/schema-generated.test.ts` сторожит расхождение.

Файлы петли: `.stepcast/config.yml` (объявление),
`.stepcast/jobs/verify.yml`, `.stepcast/jobs/implement.yml`,
`.stepcast/jobs/fix-review.yml`, `.stepcast/jobs/implement-express.yml`
(параметр, `env`, вызов), `.stepcast/pipelines/self-improve.yml` и
`.stepcast/pipelines/self-improve-memory.yml` (обвязка обеих дорожек и обеих
веток).

Тесты: `test/loop-portability.test.ts` (новое правило сторожа, чужое
объявление, сквозной прогон), `test/config.test.ts`, `test/expand.test.ts`,
тесты разрешения репозитория пункта.

Документация: `docs/config.md` — раздел «Практика спецификации» (четвёртый
ключ и контракт переменной `SPEC_CHANGE`), пример секции `project` в начале
файла; `docs/pipeline-format.md` — состав пространства `project` и пример
секции. `docs/status.md` в признаке выполненности пункта назван по инерции:
документ упразднён изменением `drop-status-doc`, и `test/no-status-doc.test.ts`
запрещает заводить его снова — этой правки в изменении нет.

Не затрагивается: витрина (`src/ui/pipelines.ts` отдаёт секцию `project`
целиком), предикаты, формат журнала, команды `merge-lanes` и `assert-clean`,
работы `propose`, `propose-express`, `plan`, `review`, `merge`, `finalize`.
