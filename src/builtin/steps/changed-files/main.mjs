// Встроенный переиспользуемый шаг: перечень изменённых файлов рабочего
// дерева. Написан на голом контракте (design.md изменения reusable-steps,
// решение 12) — только `process.env.STEPCAST_INPUT`/`STEPCAST_OUTPUT`,
// `node:fs` и `node:child_process`. Ни импорта `stepcast/step`, ни расчёта
// на default export обёртки раннера: шаг обязан работать одинаково из
// глобальной установки, из node_modules целевого проекта, из исходников — и
// в проекте, переопределившем раннер node со снятой обёрткой (wrapper: none).

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const input = JSON.parse(readFileSync(process.env.STEPCAST_INPUT, 'utf8'));
const ref = input.ref ?? 'HEAD';
const includeUntracked = input.include_untracked ?? false;

function gitLines(args) {
  return execFileSync('git', args, { encoding: 'utf8' })
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

const tracked = gitLines(['diff', '--name-only', ref]);
const files = includeUntracked
  ? [...new Set([...tracked, ...gitLines(['ls-files', '--others', '--exclude-standard'])])].sort()
  : tracked;

writeFileSync(process.env.STEPCAST_OUTPUT, JSON.stringify({ files }));
