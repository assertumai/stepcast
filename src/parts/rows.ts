import { row as pipeline } from './pipeline/row.js';
import { row as backendClaude } from './backends/claude/row.js';
import { row as predicates } from './expect/row.js';
import { row as stepRun } from './steps/run/row.js';
import { row as stepUses } from './steps/uses/row.js';
import { row as stepScript } from './steps/script/row.js';
import { row as stepAgent } from './steps/agent/row.js';
import { row as stepDecision } from './steps/decision/row.js';
import type { PartRow } from './pipeline/services.js';

/**
 * Перечень строк движка (`plugin-tree`, design.md, Решение 3): список
 * модулей, а не программа — ни одного тела строки здесь нет. Добавление и
 * изъятие строки дефолта — правка этого списка, и только его: ни обход
 * дерева (`src/core/plugins/load.ts`), ни состав дефолта (`src/parts/load.ts`),
 * ни разрешение конфигурации (`src/core/config/resolve.ts`) при этом не
 * правятся.
 *
 * `pipeline` (design.md изменения `pipeline-owns-services`, Решение 1) стоит
 * первой: она заводит служебные сервисы движка пайплайнов (`backends`,
 * `predicates`, `steps`), а прочие строки этого перечня — их потребители,
 * находящие сервис через `inject` (Решение 2), а не через порядок. Порядок
 * потребителей друг относительно друга при этом остаётся значимым и после
 * переезда сервисов в строку: он же порядок регистрации вкладов и порядок
 * перечисления в подсказке отказа о несуществующей встроенной строке; для
 * строк видов шага (`step-run`, `step-uses`, `step-script`, `step-agent`) он
 * же и порядок их узнавания в документе (`builtin-step-kinds-as-rows`,
 * design.md, Решение 2) — `step-uses` стоит раньше `step-script` ровно поэтому
 * (комментарий у `parseUsesStep`, `src/core/pipeline/expand.ts`). У строки
 * встроенных предикатов своего ограничения порядка нет: ключи предикатов не
 * пересекаются, и место строки `predicates` в перечне не влияет ни на разбор
 * документа, ни на вычисление (`builtin-predicates-as-row`, design.md,
 * Решение 8) — она стоит сразу после `backend-claude` просто по соседству с
 * `src/core/expect`, откуда берёт формы.
 *
 * Отключение или замена строки `pipeline` патчем состава — законное
 * состояние (`plugin-tree`, «Служебные сервисы пайплайна приносит строка
 * перечня дефолта»): потребители, оставшиеся без поставщика, отказывают
 * названно, каскадно снимаясь вместе с ним, если он снят после применения.
 */
export const BUILTIN_ROWS: readonly PartRow[] = [
  pipeline,
  backendClaude,
  predicates,
  stepRun,
  stepUses,
  stepScript,
  stepAgent,
  stepDecision,
];

/** Id встроенных строк — то, чем `config/resolve.ts` заводит семя дерева (design.md, Решение 3). */
export const BUILTIN_ROW_IDS: readonly string[] = BUILTIN_ROWS.map((row) => row.id);
