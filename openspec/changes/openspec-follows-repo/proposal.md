## Why

Петля знает, что описание изменения — это OpenSpec, и знает это буквально:
тридцать вхождений в одиннадцати файлах `.stepcast/`.

- `.stepcast/prompts/propose.md` — вся работа: `openspec new change`,
  `openspec instructions <artifact> --change … --json`, `openspec status`,
  `openspec validate … --strict`, правило про `SHALL` в первой физической
  строке требования;
- `.stepcast/jobs/propose.yml` — право `Bash(openspec *)` и граница правок
  `changed_only: [openspec/changes/**]`;
- `.stepcast/jobs/plan.yml` — четыре пути контекста с именами документов
  OpenSpec: `proposal.md`, `design.md`, `tasks.md`, `specs/**/*.md`;
- `.stepcast/jobs/implement.yml`, `.stepcast/jobs/review.yml`,
  `.stepcast/jobs/fix-review.yml` — те же имена в контексте и тот же
  `openspec/changes/**` в границах;
- `.stepcast/prompts/plan.md`, `implement.md`, `review.md`, `fix-review.md` —
  имена документов и путь `openspec/changes/${params.change}/` словами;
- `.stepcast/schemas/propose.json` — описание поля: «слаг… он же имя
  OpenSpec-изменения».

Это последняя жёсткая привязка петли к устройству репозитория. Очередь ушла в
`stepcast backlog` (`portable-backlog-format`), сведение — в
`stepcast merge-lanes` (`builtin-merge-lanes`), команда проверки — в
объявление `project.check` (`configurable-check-command`), сводный учёт
упразднён (`drop-status-doc`). Осталось знание о том, что у изменения есть
каталог `openspec/changes/<слаг>/`, что документы в нём зовутся так-то и что
заводит их вот эта CLI.

Цена привязки двусторонняя. Репозиторий без OpenSpec петлю не примет вовсе:
первая же работа зовёт отсутствующую команду, а `plan`, `implement` и `review`
читают контекст по путям, которых нет. Репозиторий со своими правилами получит
навязанное чужое устройство — а правила бывают разные и в пределах одной
машины: в этом workspace корневой `openspec/` отведён межрепозиторным
изменениям, и репозиторно-локальный заводится только там, где он уже есть.

Решение о том, где живёт описание изменения и по каким правилам оно пишется,
принадлежит репозиторию, для которого петля запущена. Механизм для такого
решения уже есть и обкатан на команде проверки: объявление в секции `project`
плюс подстановка `${project.*}`, раскрываемая при разборе. Не хватает не
устройства, а второй настройки.

## What Changes

- **Секция `project` пополняется группой `spec` — объявлением практики
  спецификации репозитория.** Три строковых ключа, каждый со своим
  потребителем:

  ```yaml
  # .stepcast/pipelines/self-improve.yml (или .stepcast/config.yml)
  project:
    check: npm run check
    spec:
      dir: openspec/changes              # где лежат документы изменения
      rules: .stepcast/prompts/spec-rules.md   # правила репозитория для propose
      tool: openspec                     # инструмент, которым они заводятся
  ```

  Слой и запреты те же, что у `project.check`: ключи допустимы только в
  проектном конфиге, документ пайплайна может объявить их сам и перекрыть
  конфигурацию, встроенных умолчаний нет. `dir` и `rules` — относительные пути
  от корня репозитория; пустые значения, абсолютные пути и выход за корень
  (`..`) отклоняются разбором, потому что пустой `dir` превратил бы границу
  правок `${project.spec.dir}/**` в разрешение на всё дерево.

- **Пространство подстановки `project` перестаёт быть одним именем.**
  `${project.spec.dir}`, `${project.spec.rules}`, `${project.spec.tool}`
  раскрываются при разборе документа наравне с `${project.check}`; обращение к
  необъявленному — отказ `stepcast lint` и `stepcast run` с подсказкой,
  называющей оба места объявления, а не пустая строка.

- **Запрет глобального слоя чинится для вложенных ключей.**
  `PROJECT_ONLY_KEYS = ['project.*']` сегодня не ловит `project.spec.dir`:
  `matchesKeyPattern` требует равного числа сегментов, и `project.*` совпадает
  только с `project.check`. Ключи секции обязаны отклоняться в
  `~/.stepcast/config.yml` целиком, поэтому шаблон получает хвостовую форму
  `project.**` — «ключ и всё под ним».

- **Работы петли называют место документов подстановкой.** Контекст `plan`,
  `implement` и `review` — `${project.spec.dir}/${params.change}/**/*.md` одним
  входом вместо перечня имён OpenSpec; границы `changed_only` работ `propose`,
  `implement` и `fix-review` — `${project.spec.dir}/**`; право работы `propose`
  — `Bash(${project.spec.tool} *)`. Литералов `openspec` в `.stepcast/jobs/` и
  `.stepcast/prompts/` не остаётся.

- **Промпт `propose` делится надвое.** Портируемая часть остаётся в
  `.stepcast/prompts/propose.md`: завести описание изменения по правилам
  репозитория, обоснование и признак выполненности из пункта — вход, а не
  готовый текст, ничего не реализовывать, `backlog.md` не трогать.
  Репозиторная часть уезжает в файл, названный `project.spec.rules`, — для
  этого репозитория в новый `.stepcast/prompts/spec-rules.md`: три команды
  `openspec`, порядок артефактов по зависимостям и правило про `SHALL` в первой
  физической строке. Работа `propose` получает этот файл контекстом.

- **Границы правок `implement` и `fix-review` пополняются
  `${project.spec.rules}`.** Правила спецификации — часть петли того же рода,
  что `.stepcast/config.yml`: править их должен уметь заход. Подстановкой, а не
  путём: тогда перенос файла правил в другое место делается правкой одного
  объявления.

- **Поведение петли этого репозитория не меняется.** `dir` объявлен как
  `openspec/changes`, `tool` — как `openspec`, правила — те же, что стояли в
  промпте; все подстановки раскрываются в то, что стояло литералом. Разница
  одна и намеренная: контекст `implement` берёт документы изменения одним
  входом в режиме `reference` вместо `tasks.md` строкой и спек ссылкой —
  перечислять имена документов работа больше не может, а порог
  `context.inline_threshold` и без того переводил крупные спеки в ссылки.

## Capabilities

### New Capabilities

Новых возможностей изменение не вводит: конфигурация, подстановки и петля —
возможности существующие, к которым добавляются требования.

### Modified Capabilities

- `stepcast-configuration`: секция `project` получает группу `spec` с ключами
  `dir`, `rules`, `tool`, требования к их значениям и распространение
  проектного-только запрета на вложенные ключи. Дельта — `## ADDED
  Requirements`: разрешение слоёв и существующие запреты изменение не
  переписывает.
- `pipeline-definition`: состав пространства `project` перестаёт быть одним
  именем, и подстановки `${project.spec.*}` раскрываются при разборе документа
  наравне с `${project.check}`. Требование «Состав пространства project» живёт
  в неархивированном изменении `configurable-check-command`, поэтому дельта
  здесь — `## ADDED Requirements`, а не переписывание: новое требование
  добавляет имена, не отменяя ничего сказанного про `check`.
- `self-improvement-loop`: работы петли берут место и правила описания
  изменения из настройки проекта, а не несут их устройством. Базовая спека
  возможности тоже лежит в неархивированном изменении
  (`self-improve-pipeline`), дельта — `## ADDED Requirements`.

Возможность `improvement-backlog` изменение не трогает: слаг пункта очереди
остаётся именем изменения, а о том, где это имя превращается в путь, очередь
не знает.

## Impact

- `src/core/config/schema.ts` — `RawSpecSchema` (`dir`, `rules`, `tool`) внутри
  `RawProjectSchema`, модель относительного пути, `PROJECT_ONLY_KEYS` в форме
  `project.**`.
- `src/core/config/merge.ts` — хвостовой `**` в `matchesKeyPattern`.
- `src/core/config/resolve.ts` — `project.spec` в типе `Config` (каждый ключ
  разрешается отдельно: слои сливаются по листьям).
- `src/core/pipeline/schema.ts` — та же группа в верхнем ключе `project`
  документа пайплайна, теми же моделями значений.
- `src/core/pipeline/expand.ts` — действующее значение группы (пайплайн поверх
  конфигурации), `spec` в области видимости пайплайна и тела работы,
  `PROJECT_NAMES` и объяснение необъявленного ключа для составных имён.
- `schema/config.schema.json`, `schema/pipeline.schema.json` —
  перегенерируются (`test/schema-generated.test.ts` держит свежесть).
- `test/config-*.test.ts`, `test/expand.test.ts`, `test/lint.test.ts` — приём
  ключей, отказ на пустом значении, абсолютном пути и `..`, отказ ключа в
  глобальном слое, перекрытие пайплайном, раскрытие в контексте, границах и
  промпте, диагностика необъявленного.
- `.stepcast/pipelines/self-improve.yml` — объявление `project.spec`.
- `.stepcast/jobs/propose.yml`, `plan.yml`, `implement.yml`, `review.yml`,
  `fix-review.yml` — контекст, границы и права через подстановки.
- `.stepcast/prompts/propose.md` (портируемая часть), `plan.md`,
  `implement.md`, `review.md`, `fix-review.md`;
  `.stepcast/prompts/spec-rules.md` — новый файл правил этого репозитория.
- `.stepcast/schemas/propose.json` — описание поля перестаёт называть OpenSpec.
- `test/loop-portability.test.ts` — новый: в файлах петли нет литералов
  спецификации, и петля с чужим объявлением раскрывается в чужие пути.
- `docs/config.md` — раздел про объявление практики спецификации;
  `docs/pipeline-format.md` — состав пространства `project`.
