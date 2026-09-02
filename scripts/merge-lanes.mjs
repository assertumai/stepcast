#!/usr/bin/env node
/**
 * Сведение дорожек больше не ведёт этот скрипт — петля зовёт `stepcast
 * merge-lanes` (`src/core/lanes/merge.ts`) напрямую через `$STEPCAST_BIN`
 * (`.stepcast/jobs/merge.yml`). Файл остаётся заглушкой, а не исчезает:
 * физическое удаление вне прав работы `implement-express`
 * (openspec/changes/agent-cannot-clean-up/proposal.md) — тело, несущее
 * прежнюю логику, читалось бы вторым, расходящимся источником правды.
 */
process.stderr.write(
  'merge-lanes.mjs: команда заменена `stepcast merge-lanes` — этот скрипт больше не сводит дорожки\n',
);
process.exit(1);
