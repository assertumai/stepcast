# Записи потока `codex exec --json`

Сняты 2026-09-08 с `codex-cli 0.149.0`, вход через ChatGPT, macOS. Пути
домашнего каталога заменены на `~`; содержательные поля не правились.
Записи читает `test/codex-adapter.test.ts`; в тесты нельзя добавлять сочинённые записи, кроме заведомо битой строки.

| Файл | Команда | Что внутри |
|---|---|---|
| `run1.jsonl` | `echo '<промпт>' \| codex exec --json --skip-git-repo-check -s read-only -C . --output-schema ./schema.json -` | новая нить, схема, `command_execution`, два `agent_message`, `turn.completed` с расходом |
| `run2.jsonl` | `echo '<промпт>' \| codex exec resume --json --skip-git-repo-check <thread_id> -` | продолжение нити: тот же `thread_id`, один `agent_message`, расход |
| `run3.jsonl` | `echo 'привет' \| codex exec --json --skip-git-repo-check -s read-only -C . -m no-such-model-xyz -` | отказ турна: `item.completed` типа `error` (предупреждение), `error`, `turn.failed` со `status: 400`; код возврата 1 |
| `run4.jsonl` | `echo '<промпт>' \| codex exec resume --json --skip-git-repo-check -c 'approval_policy="never"' -c 'sandbox_mode="read-only"' --output-schema ./schema.json <thread_id> -` | продолжение нити формой `resume` с переопределениями `-c` и схемой: форма принимает и то, и другое |
| `mcp.jsonl` | `echo '<промпт>' \| codex exec --json --skip-git-repo-check -c 'approval_policy="never"' -c 'sandbox_mode="read-only"' -c 'mcp_servers.probe.command="npx"' -c 'mcp_servers.probe.args=["-y","@modelcontextprotocol/server-everything"]' -` | MCP-сервер, объявленный переопределением `-c`: `item.started` и `item.completed` типа `mcp_tool_call` с `server: probe`, `tool: echo`; плоский `agent_message` без схемы |
| `schema.json` | — | схема, переданная в `run1` и `run4`; поле `$schema` CLI принял без правок |

Записи отказа по лимиту (429) и отказа аутентификации нет: поймать их
намеренно нельзя. Тест классификации подменяет код в сообщении `run3` и
называет это в своём имени.

В `stderr` первого запуска CLI писал ошибки подключения к MCP-серверу из
пользовательского `~/.codex/config.toml` (`localhost:7171`) — свидетельство
того, что пользовательская конфигурация подгружается без указаний.
