## 1. Фикстуры и разведка

- [x] 1.1 Перенести `openspec/changes/codex-backend-adapter/recordings/*.jsonl` и `schema.json` в `test/fixtures/codex/` с README (версия CLI, дата, команда записи, отсутствие записи 429 — как в `recordings/README.md`). Каталог `recordings/` из изменения удалить.
- [x] 1.2 Живая проверка MCP (решение 6): во временном каталоге запустить `codex exec --json --skip-git-repo-check -c 'mcp_servers.probe.command="npx"' -c 'mcp_servers.probe.args=["-y","@modelcontextprotocol/server-everything"]' -` с промптом, зовущим инструмент сервера; записать поток в `test/fixtures/codex/mcp.jsonl`, если в нём есть `mcp_tool_call`. Если CLI переопределение не принял — записать stderr в README фикстур и зафиксировать решение `mcp: false` для 4.6 и 7.2.
- [x] 1.3 Проверить на живом CLI, что `--output-schema` принимает файл с полем `$schema` (в `run1` принял) и что `-c approval_policy="never"` не отклоняется формой `resume`. Расхождения — в README фикстур.

## 2. Правка ядра: `init` несёт идентификатор сессии

- [x] 2.1 Падающий тест в `test/backend.test.ts` («направление идентификатора сессии»): адаптер с `sessionIdSource: 'backend'` отдаёт `init` с `sessionId`; `AgentStepResult.sessionId` равен ему, `step.json` содержит сведения инициализации, второй шаг псевдонима запускается с этим идентификатором и `resumeSession: true`.
- [x] 2.2 Падающий тест там же: первая попытка продолжала засеянный идентификатор, бэкенд ответил `init` с тем же `sessionId`, процесс вышел с ненулевым кодом — засев **не** снимается (`onFailedContinuation` не вызывается).
- [x] 2.3 `src/core/backend/types.ts`: вариант `init` события получает `readonly sessionId?: string` с комментарием, почему поле здесь (решение 1). `src/core/exec/agentStep.ts`: на `init` с `sessionId` — то же, что на `session_started`. Проверить `judgePass.ts`: судья идентификатор игнорирует, как и `session_started`.
- [x] 2.4 Убедиться, что в `src/core` ничего сверх 2.3 не изменилось (`git diff --stat src/core`).

## 3. Публичная поверхность

- [x] 3.1 `src/plugin.ts`: экспортировать `effectivePermissions`, `messagePrefix`, `BACKEND_REFUSAL_PREDICATE`, тип `McpServerStatus` — каждый с комментарием, зачем адаптеру. По завершении раздела 4 убрать экспорты, которые не понадобились.

## 4. Адаптер Codex

- [x] 4.1 Падающий тест `test/codex-adapter.test.ts`, сборка запуска: новая нить — `[command, 'exec', '--json', '--skip-git-repo-check', '-c', 'approval_policy="never"', …, '-']`, `stdin` равен промпту; модель → `-m`; схема → `--output-schema <путь>`; `resumeSession: true` с идентификатором → `[command, 'exec', 'resume', id, '--json', …, '-']` без `-s`/`-C`/`--add-dir`; без идентификатора — формы `resume` нет.
- [x] 4.2 Падающий тест там же, политика: `mode: workspace-write` → `-c sandbox_mode="workspace-write"`; `mode: acceptEdits` → `StepcastError` с `codex`, значением и словарём; `allow`/`deny` → `StepcastError` с `codex`, списками и причиной; без `permissions` — ни `sandbox_mode`, ни отказа. `effectivePermissions` берётся из `stepcast/plugin` (конфигурация бэкенда как база).
- [x] 4.3 Падающий тест там же, MCP: процессный сервер → `-c mcp_servers.<имя>.command="…"`, `.args=[…]`, `.env={…}`; HTTP → `.url="…"`, `.http_headers={…}`; при `config.mcp === false` переопределения не собираются.
- [x] 4.4 Падающий тест там же, разбор по фикстурам: `run1` — `thread.started` → `init` с `sessionId` и без `mcpServers`; `item.started` → `ignored`; `item.completed` `command_execution` → `tool_use` с именем `command_execution` и `input` без `aggregated_output`; оба `agent_message` → `result` с `text` и `structured` (объект); `turn.completed` → `usage` `{tokens_in: 18600, cache_read: 16640, cache_write: 0, tokens_out: 303}` без `reported_cost_usd` и `rate_limits`. `run2` — тот же `thread_id` в `init`. `run3` — `item.completed` типа `error` → `ignored`; `error` и `turn.failed` → `result` с `failed: true`, без `refusal` (код 400), `text` равен сообщению как есть. Битая строка → `unparsed`; пустая → `ignored`; `reasoning`/`todo_list` → `ignored`.
- [x] 4.5 Падающий тест там же, отказы: сообщение `run3` с подменённым `"status":429` → `refusal.class === 'rate_limit'` (имя теста называет подмену); `401` и `403` → `unauthenticated`; сообщение без JSON с `usage limit` → `rate_limit`, с `not logged in` → `unauthenticated`; `resetAt` заполнен только при `resets_at`/`resets_in_seconds` в ответе.
- [x] 4.6 `src/backends/codex/adapter.ts`: `createCodexAdapter(config)` — `capabilities` из записи конфигурации, `sessionIdSource: 'backend'`; `launch()` по 4.1–4.3; `parseLine()` по 4.4–4.5. Импорты — только `../../plugin.js` и Node.
- [x] 4.7 `src/backends/codex/index.ts`: плагин по умолчанию — `name: 'codex'`, `version` из `package.json` пакета либо литерал, вклад `backends.codex` с `create` и `defaults` (`command`, `sessions`, `structured_output`, `strict_permissions: false`, `mcp` по 1.2, `concurrency: 2`, `cache_read_weight: 0.1`).
- [x] 4.8 `package.json`: `"./backends/codex": "./dist/src/backends/codex/index.js"` в `exports`.
- [x] 4.9 Тест загрузки (в `test/codex-adapter.test.ts` либо `test/plugin-load.test.ts`): плагин, объявленный ключом `plugins` путём к собранному модулю, даёт `resolveAdapter('codex', …)` адаптер с `sessionIdSource: 'backend'`; умолчания вклада видны в `stepcast config` источником плагина; без объявления — прежний отказ «не предоставлен ни встроенно, ни плагином».
- [x] 4.11 **Найдено живой приёмкой:** `stepcast lint`/`run`/`resume` разрешали конфигурацию заново (`resolveConfig({ cwd })`) и теряли слой умолчаний плагинных бэкендов — «Неизвестный бэкенд codex», хотя `stepcast config` его показывал. Команды берут `env.config` из точки входа; тест в `test/cli-plugins.test.ts` (lint и run --dry-run на бэкенде из умолчаний плагина). Остальные команды с собственным `resolveConfig` (status, usage, gc, up, …) бэкендов не трогают — названо в 7.1 как найденное и не правленное.
- [x] 4.12 **Найдено живой приёмкой:** судья запускался с окружением только из `launch.env` — без `PATH` (`extendEnv: false`), и `codex` из `~/.local/bin` не находился: «Процесс судьи не удалось запустить» при исправном шаге. `runJudgePass` получает `env` шага (`stepEnv`), процесс судьи идёт с ним, как процесс шага; тест в `test/judge.test.ts` на бинарник, доступный только через `PATH`. Вторая правка ядра, названа в design (решение 11).
- [x] 4.10 Тест исполнения шага на `createFakeBackend`-подобной обёртке над адаптером Codex либо через `executeAgentStep` с адаптером, чей `launch` печатает `run1`/`run2`: сессия шага равна `thread_id`, `output.json` записан из последнего `agent_message`, второй шаг псевдонима собирается формой `resume`.

## 5. Приёмочный пайплайн

- [x] 5.1 `examples/codex/stepcast.yml`: работа с одним шагом на `agent: codex`, `permissions: { mode: read-only }`, `output_schema` и предикатом `judge` на том же бэкенде; вторая работа с двумя шагами в `session: shared`, второй ссылается на сказанное в первом. Потолок токенов и короткие таймауты по образцу `examples/acceptance/stepcast.yml`.
- [x] 5.2 `examples/codex/README.md`: запуск из временного каталога-проекта с `.stepcast/config.yml`, объявляющим `plugins: [<абсолютный путь>/dist/src/backends/codex/index.js]` и `defaults.agent: codex`; готовые команды; почему плагин не объявляется в конфигурации самого репозитория (движок петли зафиксирован снимком).
- [x] 5.3 `examples/README.md`: строка про `codex/` с пометкой о требуемом CLI и аутентификации.

## 6. Живой прогон

- [x] 6.1 Собрать (`npm run build`) и прогнать `examples/codex/` по README. Проверить по журналу: статус работ, `output.json` шага, вердикт судьи, расход с `cache_read`, `sessionId` шага равен `thread_id` из `stdout.log`, второй шаг общей сессии собран формой `resume` и продолжил нить, события `backend.degraded` нет.
- [x] 6.2 Если 1.2 подтвердило MCP — прогнать шаг с объявленным сервером и убедиться, что в `step.json` есть `tool_use` с именем `mcp__<server>__<tool>`. Выполнено с уточнением: `step.json` имён вызванных инструментов не хранит (движок пишет только пути читающих инструментов), поэтому сверено по `stdout.log` шага — две записи `mcp_tool_call` сервера `probe` (`item.started` и `item.completed`), шаг `success` на ответе сервера.
- [x] 6.3 Исход назвать в отчёте о работе прямо: что прошло, что нет. Записанный поток за живой прогон не выдавать. Прогон 8c7ae2 (2026-09-08): три шага и судья — `success`; первый заход 89346a упал на судье — дефект окружения судьи, исправлен решением 11. Прогон 6f1fa2: шаг с MCP — `success`.

## 7. Документация

- [x] 7.1 `docs/plugins.md`, раздел о втором бэкенде: что понадобилось (поле `sessionId` у `init` — почему; экспорты 3.1), чего хватило без правок (путь схемы, классификация отказов, умолчания вклада, `-c` как форма передачи всего остального), чего не хватило и не правилось (расход одним итогом → потолок не обрывает шаг по ходу; нет предстартовой проверки невыполнимых списков — отказ из `launch()`; `enforce: strict` без аналога; состав MCP-серверов в потоке не сообщается). Подключение: `plugins: [stepcast/backends/codex]`.
- [x] 7.2 `docs/plugins.md`, «Известные ограничения»: схема применяется ко всем сообщениям турна; `~/.codex/config.toml` подгружается всегда; структурированный вывод разбирается из текста «на всякий случай»; итог 1.2 про MCP.
- [x] 7.3 `docs/config.md`: пример `plugins` + `backends.codex` с перечнем умолчаний вклада; замечание про `OPENAI_API_KEY` под `env_deny` и как разрешить точечно.
- [x] 7.4 `docs/pipeline-format.md`: у `permissions.mode` — словарь Codex (`read-only`, `workspace-write`, `danger-full-access`) и что `allow`/`deny` на Codex отказывают; проверить упоминание `--sandbox` (строка ~907) — заменить на `-c sandbox_mode`.
- [x] 7.5 `openspec/changes/first-real-backend-plugin/tasks.md`: одной строкой под заголовком — незакрытые пункты перенесены в `codex-backend-adapter`; при архивации спека `codex-backend` берётся оттуда.

## 8. Проверка

- [x] 8.1 `npm run check` проходит целиком, включая `test/codex-adapter.test.ts`, `test/plugin-surface.test.ts` с непустым `src/backends/` и обновлённые тесты сессий.
- [x] 8.2 `npm run check` не требует CLI и сети (никакой тест не зовёт `codex`).
- [x] 8.3 `openspec validate codex-backend-adapter --strict` проходит.
