import { row as backendClaude } from './backends/claude/row.js';
import { row as stepDecision } from './steps/decision/row.js';
import type { BuiltinRow } from '../core/plugins/load.js';

/**
 * Перечень строк движка (`plugin-tree`, design.md, Решение 3): список
 * модулей, а не программа — ни одного тела строки здесь нет. Добавление и
 * изъятие строки дефолта — правка этого списка, и только его: ни обход
 * дерева (`src/core/plugins/load.ts`), ни состав дефолта (`src/parts/load.ts`),
 * ни разрешение конфигурации (`src/core/config/resolve.ts`) при этом не
 * правятся.
 *
 * Порядок обязателен: он же порядок семени дерева, порядок регистрации
 * вкладов и порядок перечисления в подсказке отказа о несуществующей
 * встроенной строке.
 */
export const BUILTIN_ROWS: readonly BuiltinRow[] = [backendClaude, stepDecision];

/** Id встроенных строк — то, чем `config/resolve.ts` заводит семя дерева (design.md, Решение 3). */
export const BUILTIN_ROW_IDS: readonly string[] = BUILTIN_ROWS.map((row) => row.id);
