import { realpathSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

import { resolveConfig } from '../../core/config/resolve.js';
import { ExitCode, StepcastError, type ExitCodeValue } from '../../core/errors.js';
import { findProjectRoot } from '../../core/journal/paths.js';
import { assertCleanTree } from '../../core/lanes/tree.js';
import type { ParsedArgs } from '../args.js';

/**
 * `stepcast assert-clean [--allow <пути через запятую>]` — проверка чистоты
 * рабочего дерева и объявленных вложенных репозиториев (`project.nested_repos`),
 * не изменяя ни одного из них. Существует потому, что состав вложенных
 * репозиториев сознательно не публикуется подстановкой `${project.*}` (см.
 * `nested-repo-anchor`) — головному шагу петли (`.stepcast/jobs/slots.yml`)
 * прочитать его в `sh -c` неоткуда, а команде бинаря есть где: она читает
 * конфигурацию проекта сама, как и `merge-lanes`.
 *
 * Проверяется корень рабочего дерева git, а не буквальный каталог запуска.
 * Иначе команда из подкаталога отвечала бы «чисто» на грязный вложенный
 * репозиторий: и проектный конфиг (`<корень>/.stepcast/config.yml`), и пути
 * `project.nested_repos` объявлены от корня, а `resolveConfig` ищет конфиг
 * ровно в переданном каталоге, вверх не поднимаясь. Тишина здесь неотличима
 * от чистоты — ровно та ошибка, ради которой проверка и обходит части.
 * Пути `--allow` при этом остаются относительными каталогу запуска: их пишет
 * человек в своей оболочке, и приводятся они к абсолютным здесь.
 */

function stringFlag(flags: ParsedArgs['flags'], name: string): string | undefined {
  const value = flags[name];
  return typeof value === 'string' ? value : undefined;
}

function parseAllowList(raw: string): readonly string[] {
  const paths = raw.split(',').map((entry) => entry.trim());
  if (paths.some((path) => path === '')) {
    throw new StepcastError('ключ --allow требует непустого перечня путей через запятую');
  }
  return paths;
}

export function runAssertCleanCommand(args: ParsedArgs, cwd: string): ExitCodeValue {
  // Оба пути считаются от одного основания: `findProjectRoot` возвращает
  // корень с разрешёнными симлинками, и относительный `--allow`, приведённый
  // к сырому `cwd`, не совпал бы с ним ни одной записью статуса (`/var` и
  // `/private/var` на macOS — тот же каталог двумя именами).
  const base = realpathSync(cwd);
  const allowFlag = stringFlag(args.flags, 'allow');
  const allow =
    allowFlag === undefined ? undefined : parseAllowList(allowFlag).map((path) => resolvePath(base, path));

  const root = findProjectRoot(cwd);
  const { config } = resolveConfig({ cwd: root });

  assertCleanTree(root, {
    ...(allow === undefined ? {} : { allow }),
    ...(config.project.nestedRepos === undefined ? {} : { nested: config.project.nestedRepos }),
  });

  return ExitCode.ok;
}
