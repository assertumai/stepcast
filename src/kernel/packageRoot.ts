import { existsSync } from 'node:fs';
import { dirname, join, parse as parsePath } from 'node:path';

import { StepcastError } from './errors.js';

/**
 * Корень пакета stepcast: ближайший каталог с `package.json` вверх по
 * дереву. Единственная доменно пустая половина прежнего `package-schema.ts`
 * (design.md, Решение 6) — нужна обходу дерева плагинов (`load.ts`), у
 * которого доменного разрешения схем, пайплайнов и обёрток нет вовсе.
 */
export function findPackageRoot(from: string): string {
  let current = from;
  for (;;) {
    if (existsSync(join(current, 'package.json'))) return current;
    const parent = dirname(current);
    if (parent === current || parent === parsePath(current).root) {
      throw new StepcastError('Не удалось найти корень пакета stepcast');
    }
    current = parent;
  }
}
