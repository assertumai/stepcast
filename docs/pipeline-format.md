# Формат пайплайна

Файл `scarp.yml` в корне репозитория — пайплайн по умолчанию. Несколько
пайплайнов живут в `.scarp/pipelines/<name>.yml`. Работы можно выносить в
отдельные файлы и подключать через `uses:`.

## Верхний уровень

```yaml
version: 1
name: implement-change

inputs:                          # аргументы запуска
  change:
    type: string
    required: true
  skip_e2e:
    type: bool
    default: false

defaults:                        # наследуется всеми jobs и steps
  agent: claude
  workspace: worktree

budget:                          # потолок на весь прогон
  tokens: 2M
  wallclock: 2h

concurrency: 3                   # сколько jobs одновременно

jobs: { ... }                    # что делают работы
flow: { ... }                    # когда они запускаются
```

`jobs` и `flow` разделены намеренно. `jobs` описывает работу и ничего не знает
об окружении. `flow` описывает граф и условия. Одна и та же job подключается в
разные пайплайны с разной обвязкой.

## jobs

```yaml
jobs:
  implement:
    description: Реализовать задачи из change

    workspace: worktree          # repo | worktree | temp
    inputs:                      # объявленные входы — участвуют в ключе шага
      - openspec/changes/${inputs.change}/**
      - src/**
    outputs:                     # публикуется зависимым работам
      report: reports/implement.json
      patch: ${run.job_dir}/diff.patch

    budget:
      tokens: 500k
      wallclock: 30m

    until:                       # условие сходимости внутреннего цикла
      max_iterations: 4
      check:
        - cmd: npm test
        - cmd: npx tsc --noEmit

    steps: [ ... ]

  build:
    uses: ./.scarp/jobs/build.yml
    with:
      target: desktop
```

**`workspace`** — где работает job. `repo` — общее рабочее дерево, `worktree` —
отдельный git worktree (изоляция параллельных работ без контейнеров), `temp` —
чистая директория. Контейнеры добавятся позже как ещё одно значение, формат не
изменится.

**`inputs`** — не документация, а ключ кеша. Шаг считается неизменившимся, если
не изменилось содержимое объявленных входов. Необъявленный вход ломает `resume`
и дифф прогонов — это осознанный размен, тот же, что в Bazel и Turborepo.

**`until`** — цикл живёт внутри job, не между работами. После прохода `steps`
проверяется `check`; если он не прошёл и бюджет не исчерпан, цикл повторяется,
и вывод упавшей проверки попадает в контекст шагов следующей итерации. `until`
без `budget` и без `max_iterations` отклоняется линтером.

Итоговый статус job: `success | failed | skipped | canceled | budget_exceeded`.

## flow

```yaml
flow:
  implement:                     # без after — стартовая работа

  review:
    after: [implement]

  e2e:
    after: [implement]
    when: "not inputs.skip_e2e"

  ship:
    after: [review, e2e]
    when: "success(review) and (success(e2e) or skipped(e2e))"

  triage:
    after: [implement, e2e]
    when: "any_failed()"
```

`after` задаёт зависимости, `when` — условие запуска. По умолчанию `when` —
«все зависимости завершились успехом». Работы без взаимных зависимостей идут
параллельно в пределах `concurrency`.

Отдельного `on_failure` нет: обработка отказа — это обычная работа с условием
`failed(...)`. Один механизм вместо двух.

### Выражения

Доступны `inputs.*`, `run.*`, `jobs.<id>.status`, `jobs.<id>.outputs.*`,
`jobs.<id>.cost.tokens`. Функции: `success(job)`, `failed(job)`,
`skipped(job)`, `any_failed()`, `all_ok()`.

Язык намеренно куцый: сравнения, `and/or/not`, обращение к полям. Всё, что
сложнее, выносится в `run`-шаг, который печатает результат в stdout. Это
защита от превращения YAML в язык программирования.

## Шаги

### agent

```yaml
steps:
  - id: plan
    agent: claude                # claude | codex | ...
    model: opus                  # опционально
    prompt: file:./prompts/plan.md
    context:                     # что подкладывается шагу
      - openspec/changes/${inputs.change}/proposal.md
      - openspec/changes/${inputs.change}/tasks.md
    output:
      file: reports/plan.json
      schema: ./schemas/plan.json    # передаётся бэкенду, если он это умеет
    expect:
      - file_exists: reports/plan.json
      - schema: ./schemas/plan.json
    attempts:
      max: 3
```

Шаг получает промпт, объявленный контекст и рабочую директорию. Пайплайн ему не
виден — он не знает ни о соседних шагах, ни о том, что будет дальше.

Запуск только через pipe, без псевдотерминала. Структурированный вывод берётся
из штатного headless-режима бэкенда, оттуда же приходит расход токенов.

### run

```yaml
  - id: test
    run: npm test
    expect:
      - exit_code: 0
    on_fail:
      analyze: claude            # разбор падения агентом
      prompt: file:./prompts/triage-tests.md
```

`on_fail.analyze` не чинит и не повторяет — он производит разбор в
`analysis.md` и завершает шаг отказом. Решение о том, что делать дальше,
принимает `flow`.

## expect

Предикаты делятся на структурные и смысловые. Структурные дёшевы и
детерминированы, смысловые — нет.

| Предикат | Тип | Описание |
|---|---|---|
| `exit_code: 0` | структурный | код возврата |
| `file_exists: <path>` | структурный | файл создан |
| `schema: <path>` | структурный | JSON-вывод соответствует схеме |
| `matches: /re/` | структурный | stdout содержит |
| `not_matches: /re/` | структурный | stdout не содержит |
| `changed_only: [glob]` | структурный | изменения не вышли за границы |
| `cmd: "..."` | структурный | команда завершилась нулём |
| `judge: "..."` | смысловой | оценка агентом-судьёй |

`judge` по умолчанию совещательный: результат пишется в отчёт, шаг не падает.
Жёстким гейтом делается явно:

```yaml
      - judge: "План покрывает все требования из спеки"
        hard: true
        agent: claude
```

Причина умолчания: если валидация дороже и менее надёжна, чем сама работа, она
даёт шум, а не сигнал. Ограничения на это в движке нет — есть умолчание.

## attempts

```yaml
    attempts:
      max: 3
      escalation:
        - include_failure: true            # 2-я: + вывод упавшей проверки
        - include_failure: true            # 3-я: + сильнее модель
          model: opus
      allow_identical: false               # умолчание
```

Повтор с идентичным входом запрещён по умолчанию: он маскирует дефект промпта
или спеки, жжёт бюджет и создаёт видимость работающего процесса. Каждая попытка
обязана отличаться хотя бы одним элементом ключа. Когда `escalation` короче
`max`, последняя ступень повторяется — при `allow_identical: false` это
означает, что попытки закончились.

Если шаг стабильно проходит только с третьей попытки — это диагноз, и он виден
в `cost.json` и в UI.

## scarp lint

Отклоняет до запуска:

- циклы в `after`, недостижимые работы, ссылки на несуществующие job id;
- `when`, обращающийся к неопределённым `inputs` или к работе, которой нет в
  `after`;
- неизвестный бэкенд, отсутствующий файл промпта или схемы;
- `until` без `budget` и без `max_iterations` — незавершающийся цикл;
- выход, который читается ниже по графу, но не объявлен в `outputs`;
- нераскрываемые `uses:`.

Предупреждает:

- у шага нет ни одного структурного предиката в `expect` — гейт держится только
  на суждении агента;
- `allow_identical: true`;
- у job нет `inputs` — `resume` и дифф для неё работать не будут.
