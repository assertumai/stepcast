## 1. Очередь улучшений

- [x] 1.1 Создать `backlog.md` в корне репозитория с пятью засеянными пунктами
      в порядке: `judge-predicate`, `budget-wait-on-exceed`,
      `numeric-field-substitution`, `schedule-trigger`,
      `dependent-job-workspace`. У каждого — `status: pending`, `title`, `why`,
      `done_when`
- [x] 1.2 Написать `scripts/backlog.mjs`: разбор `backlog.md` в список записей,
      с отказом по ненулевому коду при отсутствии обязательного поля или
      неизвестном `status`
- [x] 1.3 Добавить в `scripts/backlog.mjs` подкоманду выбора: первый `pending`
      либо `in_progress` старше 6 часов, перевод в `in_progress` с
      `started_at` в ISO 8601, печать JSON со `slug`, `title`, `why`,
      `done_when` в stdout, отказ при отсутствии свободных пунктов
- [x] 1.4 Добавить в `scripts/backlog.mjs` подкоманду проставления исхода:
      `done` либо `failed` с полем `reason`, отказ при неизвестном слаге
- [x] 1.5 Написать тест разбора и проверок формата в `test/backlog.test.ts`
- [x] 1.6 Написать тест выбора пункта в `test/backlog.test.ts`: свободный есть,
      свободных нет, протухший берётся, занятый пропускается, занятый без
      свободных ниже даёт отказ
- [x] 1.7 Написать тест проставления исхода в `test/backlog.test.ts`

## 2. Промпты и схемы

- [x] 2.1 Создать `.stepcast/schemas/propose.json` — слаг взятого пункта и
      сводка заведённого OpenSpec-изменения
- [x] 2.2 Создать `.stepcast/schemas/plan.json` — список задач с файлами и
      признаком выполненности (за основу взять
      `examples/target-state/schemas/plan.json`)
- [x] 2.3 Создать `.stepcast/schemas/implement.json` — изменённые файлы,
      выполненное и оставшееся
- [x] 2.4 Создать `.stepcast/schemas/review.json` — находки с уровнем severity,
      файлом и строкой
- [x] 2.5 Создать `.stepcast/prompts/propose.md` — завести OpenSpec-изменение
      по слагу и описанию пункта очереди
- [x] 2.6 Создать `.stepcast/prompts/plan.md` — разобрать изменение и составить
      план, не начиная реализацию
- [x] 2.7 Создать `.stepcast/prompts/implement.md` — реализовать план, чинить
      причину непрошедшей проверки, а не симптом
- [x] 2.8 Создать `.stepcast/prompts/review.md` — отревьюить диф против плана,
      вернуть находки, ничего не исправляя
- [x] 2.9 Создать `.stepcast/prompts/fix-review.md` — исправить находки ревью
      из контекста предшественника

## 3. Работы пайплайна

- [x] 3.1 Создать `.stepcast/jobs/propose.yml`: командный шаг проверки чистоты
      дерева до агентских шагов, командный шаг выбора пункта через
      `scripts/backlog.mjs`, агентский шаг заведения OpenSpec-изменения на
      `model: opus`, `output.from` со слагом
- [x] 3.2 Создать `.stepcast/jobs/plan.yml`: агентский шаг разбора изменения на
      `model: opus`, `output.from` с планом, `expect` по схеме
- [x] 3.3 Создать `.stepcast/jobs/implement.yml`: `until` с `max_iterations` и
      проверкой `npm run check`, агентский шаг реализации на `model: sonnet` с
      `changed_only` по `src/**`, `test/**`, `docs/**`, `openspec/changes/**`,
      `backlog.md`; эскалация попыток модель не повышает
- [x] 3.4 Создать `.stepcast/jobs/review.yml`: агентский шаг ревью на
      `model: opus` с `permissions` только на чтение и `git diff`,
      `output.from` с находками
- [x] 3.5 Создать `.stepcast/jobs/fix-review.yml`: `until` с проверкой
      `npm run check`, агентский шаг исправления на `model: opus` без
      объявления `context` на артефакт ревью
- [x] 3.6 Создать `.stepcast/jobs/verify.yml`: командные шаги типизации, линта
      и тестов с `expect: exit_code: 0`
- [x] 3.7 Написать `scripts/finalize.mjs`: слаг берётся из `item.json` в
      каталоге прогона (а не из выхода `propose` — работа обязана отработать и
      когда `propose` упала), исход по статусу `verify`, коммит только при
      успехе
- [x] 3.8 Создать `.stepcast/jobs/finalize.yml`: командный шаг, зовущий
      `scripts/finalize.mjs` со статусом `verify`
- [x] 3.9 Написать тест `test/finalize.test.ts`: пункт не брался, успех даёт
      один коммит с правками и отметкой, отказ не коммитит, правки агента при
      отказе остаются, пропущенный `verify` считается отказом

## 4. Пайплайн

- [x] 4.1 Создать `.stepcast/pipelines/self-improve.yml`: `workspace.mode: cwd`,
      `concurrency: 1`, бюджет прогона, `defaults` с агентом и общей сессией
- [x] 4.2 Подключить семь работ через `uses` с последовательными `needs`;
      `finalize` — с `needs: all` и `on: always`
- [x] 4.3 Прогнать `stepcast lint` на пайплайне и устранить замечания
- [x] 4.4 Проверить, что сумма бюджетов работ укладывается в бюджет прогона
      (`stepcast lint --budget` описан в документации, но в CLI не
      реализован — считается вручную)

## 5. Проверка петли

- [x] 5.1 Проверить отказ на грязном дереве: внести правку, запустить петлю,
      убедиться в отказе `propose` до траты токенов и в неизменности очереди
- [x] 5.2 Проверить `stepcast run --dry-run`: граф раскрывается, все семь
      работ на местах, `finalize` отрабатывает по `needs: all` даже когда
      `propose` упала
- [ ] 5.3 Прогнать петлю на первом пункте очереди целиком и убедиться, что
      создан один коммит, включающий и правки, и отметку `done`

## 6. Документация

- [x] 6.1 Обновить `docs/status.md`: строка о пайплайне саморазвития в таблице
      «Работает»
- [x] 6.2 Обновить `README.md`: упоминание петли и ссылка на `backlog.md`
