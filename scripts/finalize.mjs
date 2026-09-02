#!/usr/bin/env node
/**
 * Завершение захода петли больше не ведёт этот скрипт — работа `finalize`
 * зовёт `stepcast backlog settle` напрямую через `$STEPCAST_BIN`
 * (`.stepcast/jobs/finalize.yml`). Файл остаётся заглушкой, а не исчезает:
 * физическое удаление вне прав работы `implement-express`
 * (openspec/changes/agent-cannot-clean-up/proposal.md) — тело, несущее
 * прежнюю логику, читалось бы вторым, расходящимся источником правды.
 */
process.stderr.write(
  'finalize.mjs: команда заменена `stepcast backlog settle` — этот скрипт больше не проставляет исходы\n',
);
process.exit(1);
