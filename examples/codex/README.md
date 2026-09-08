# Приёмка адаптера Codex

Живой прогон на установленном и аутентифицированном `codex` (проверено на
`codex-cli 0.149.0`, вход через ChatGPT). Тратит квоту подписки: четыре
коротких вызова модели плюс судья.

## Почему из временного проекта

Адаптер поставляется плагином (`stepcast/backends/codex`), а не встроен. В
`.stepcast/config.yml` этого репозитория он **не объявляется**: движок петли
саморазвития зафиксирован снимком, модуль лежит в `dist/` рабочего дерева и до
сборки не существует, а отказ загрузки плагина прекращает любую команду — в том
числе `stepcast data`, которую агент зовёт внутри шага. Поэтому приёмка идёт из
отдельного каталога с собственной конфигурацией.

## Как запускать

```bash
npm run build
```

```bash
T=$(mktemp -d) && mkdir -p "$T/.stepcast" && printf 'plugins: ["%s/dist/src/backends/codex/index.js"]\ndefaults:\n  agent: codex\n' "$PWD" > "$T/.stepcast/config.yml" && git -C "$T" init -q && echo "$T"
```

```bash
cd "$T" && stepcast config | grep codex
```

Ожидается запись `backends.codex.*` с источником `plugin:codex` и сам плагин в
перечне загруженных.

```bash
cd "$T" && stepcast lint /путь/к/stepcast/examples/codex/stepcast.yml && stepcast run /путь/к/stepcast/examples/codex/stepcast.yml
```

## Что сверить по журналу прогона

- статус обеих работ — `success`;
- `отвечает/по-схеме/output.json` — объект по `schemas/answer.json`, вердикт
  судьи в `step.json`;
- `usage` шагов несёт `cache_read` и `tokens_in` **без** кешированных
  (у Codex `input_tokens` включает кеш, адаптер вычитает);
- `session` шага равна `thread_id` из первой строки его `stdout.log`;
- `stdout.log` у `продолжает/вспоминает` начинается с того же `thread_id`,
  что у `загадывает`, и `session` обоих шагов в `status.json` совпадает —
  второй шаг собран формой `codex exec resume` и продолжил нить;
- события `backend.degraded` в журнале нет.
