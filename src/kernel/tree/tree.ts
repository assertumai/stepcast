import { StepcastError } from '../errors.js';
import type { PluginPatchRow } from './patch.js';

/**
 * Дерево плагинов (`plugin-tree`): упорядоченный список именованных строк.
 * Порядок строк — порядок загрузки, он же порядок, в котором строки занимают
 * имена вкладов (design.md, Решение 1). «Дерево» здесь метафора порядка, а не
 * вложенности: ни группировки, ни глубины у списка нет.
 */

/**
 * Слой, давший строке её последнюю редакцию: встроенный, файл (design.md,
 * Решение 7) либо каталог, найденный обходом слоя (`user-plugins`, design.md,
 * Решение 1) — со своим слоем, проектным либо домашним.
 */
export type TreeRowSource =
  | { readonly kind: 'builtin' }
  | { readonly kind: 'file'; readonly path: string }
  | { readonly kind: 'directory'; readonly dir: string; readonly layer: 'project' | 'home' };

/**
 * Форма `use`, которой строка называет фабрику встроенного слоя, а не модуль
 * на диске (`plugin-tree`, design.md, Решение 2). Объявлена здесь, а не в
 * загрузчике: по ней же отличает встроенную строку от модуля и проекция
 * `Config.plugins` (`config/resolve.ts`).
 */
export const BUILTIN_USE_PREFIX = 'stepcast:';

/** Строка занята встроенной фабрикой: её `use` — не путь и не пакет, а имя из таблицы `builtin.ts`. */
export function isBuiltinUse(use: string): boolean {
  return use.startsWith(BUILTIN_USE_PREFIX);
}

/**
 * Причина, по которой строка отказывает ещё до загрузки — до всякого чтения
 * диска и импорта. Сегодня такая причина одна: каталог назван идентификатором
 * встроенной строки (`user-plugins`, design.md, Решение 5). Отказ обязан быть
 * состоянием строки, а не исключением из сборки дерева: чужая папка с
 * неудачным именем не вправе сделать неработоспособными все команды разом.
 */
export interface TreeRowFailure {
  readonly message: string;
  readonly hint?: string;
}

export interface TreeRow {
  readonly id: string;
  readonly use: string;
  readonly enabled: boolean;
  readonly source: TreeRowSource;
  /**
   * Строка заведомо неприменима (`TreeRowFailure`). Загрузчик не трогает ради
   * неё ни диска, ни импорта — отказ отдаётся сразу, и дальше с ним поступают
   * по общему правилу: у строки, найденной обходом, он становится её
   * состоянием (design.md, Решение 10).
   */
  readonly failure?: TreeRowFailure;
}

/**
 * Операция слоя: заменить строку с известным `id` целиком либо вставить
 * новую по названной позиции. Копится из ключа `plugins` слоя и его патча, в
 * этом порядке (design.md, Решение 4), и сворачивается в дерево, накопленное
 * предыдущими слоями (Решение 3).
 */
export interface TreeOperation {
  /**
   * Откуда операция: `key` — строка ключа `plugins` (сокращённая форма,
   * design.md Решение 4), `patch` — строка документа `plugins.patch.yml`,
   * `directory` — каталог, найденный обходом слоя (`user-plugins`, design.md,
   * Решение 1, 2). Различие между `key` и прочими видно в одном месте —
   * повторе уже стоящей в дереве строки (`applyOperation`): `key` оставляет
   * строку, объявившую `id` первой, за собой, а `directory` и `patch` заменяют
   * её целиком — так верхний слой (проектный обход поверх домашнего) берёт
   * приоритет тем же правилом, что и патч.
   */
  readonly kind: 'key' | 'patch' | 'directory';
  readonly id: string;
  readonly use: string;
  readonly enabled: boolean;
  readonly before?: string;
  readonly after?: string;
  /** Файл, объявивший операцию, — для отказов и для `source` новой строки. */
  readonly file: string;
  /** Слой каталога — только при `kind: 'directory'` (`TreeRowSource`, вид `directory`). */
  readonly layer?: 'project' | 'home';
  /**
   * Строка заведомо неприменима (`TreeRowFailure`). Такая операция никогда не
   * заменяет строку, уже стоящую в дереве: см. `applyOperation`.
   */
  readonly failure?: TreeRowFailure;
}

/**
 * Строки ключа `plugins` слоя: вставка в конец с `id`, равным спецификатору
 * (design.md, Решение 4). Повтор спецификатора не отклоняется и ничего в
 * дереве не меняет — см. схлопывание в `applyOperation`.
 */
export function keyOperations(specs: readonly string[], file: string): TreeOperation[] {
  return specs.map((spec) => ({ kind: 'key' as const, id: spec, use: spec, enabled: true, file }));
}

/**
 * Строки, найденные обходом каталога плагинов слоя (`user-plugins`,
 * design.md, Решение 1, 2): вставка в конец с `id`, равным имени каталога, и
 * `use` — абсолютным путём каталога. В отличие от `key`, повтор `id` между
 * слоями не схлопывается — верхний слой заменяет найденную строку целиком
 * (`applyOperation`, ветка по умолчанию), а не оставляет её за нижним.
 */
export function directoryOperations(
  dirs: readonly { readonly id: string; readonly dir: string; readonly failure?: TreeRowFailure }[],
  layer: 'project' | 'home',
): TreeOperation[] {
  return dirs.map(({ id, dir, failure }) => ({
    kind: 'directory' as const,
    id,
    use: dir,
    enabled: true,
    file: dir,
    layer,
    ...(failure === undefined ? {} : { failure }),
  }));
}

/**
 * Строки документа `plugins.patch.yml`: каждая — операция замены либо
 * вставки (`applyOperations` решает, что именно, по наличию `id` в текущем
 * дереве). Повтор `id` внутри списка одного файла отклоняется здесь —
 * design.md, Решение 9.
 */
export function patchOperations(rows: readonly PluginPatchRow[], file: string): TreeOperation[] {
  const seen = new Set<string>();
  const operations: TreeOperation[] = [];
  for (const row of rows) {
    if (seen.has(row.id)) {
      throw new StepcastError(`Строка ${row.id} объявлена в патче дважды`, {
        file,
        at: row.id,
        hint: 'Каждый id допустим в файле патча один раз — уберите повтор',
      });
    }
    seen.add(row.id);
    operations.push({
      kind: 'patch',
      id: row.id,
      use: row.use,
      enabled: row.enabled ?? true,
      ...(row.before === undefined ? {} : { before: row.before }),
      ...(row.after === undefined ? {} : { after: row.after }),
      file,
    });
  }
  return operations;
}

/** Источник новой строки: каталог — для операции обхода, файл — для ключа и патча (design.md, Решение 1, 7). */
function operationSource(operation: TreeOperation): TreeRowSource {
  if (operation.kind === 'directory') {
    // `layer` всегда задан операциями `directoryOperations` — необязательность
    // поля здесь только ради того, чтобы `key`/`patch` его не носили.
    return { kind: 'directory', dir: operation.use, layer: operation.layer! };
  }
  return { kind: 'file', path: operation.file };
}

/** Применить одну операцию к дереву — замена известного `id` либо вставка нового (design.md, Решение 3). */
function applyOperation(tree: readonly TreeRow[], operation: TreeOperation): TreeRow[] {
  const index = tree.findIndex((row) => row.id === operation.id);
  const row: TreeRow = {
    id: operation.id,
    use: operation.use,
    enabled: operation.enabled,
    source: operationSource(operation),
    ...(operation.failure === undefined ? {} : { failure: operation.failure }),
  };

  if (operation.failure !== undefined) {
    // Заведомо неприменимая строка не занимает чужого места: каталог, названный
    // идентификатором встроенной строки, обязан отказать сам, а встроенная
    // строка — остаться в дереве нетронутой (`user-plugins`, «Каталог назван
    // именем встроенной строки»; design.md, Решение 5). Отсюда и повтор `id` в
    // дереве: две строки с одним именем — ровно то, что произошло на диске, и
    // печать состава (`stepcast plugins`) показывает обе — действующую
    // встроенную и отказавшую каталожную с причиной.
    return [...tree, row];
  }

  if (index !== -1 && operation.kind === 'key') {
    // Ключ `plugins` — вставка, а не правка: строка с этим `id` уже в дереве,
    // значит вставлять нечего, и повтор не меняет ничего — ни модуля, ни
    // `enabled`, ни слоя-источника (`plugin-tree`, «Повтор между слоями»).
    //
    // Именно `source` тут и важен: относительный `use` разрешается от файла,
    // объявившего строку, и перенос объявления к верхнему слою сменил бы базу
    // разрешения — `./adapters/x.mjs`, названный и дома, и в проекте, стал бы
    // грузиться из проекта, хотя прежний список ключа `plugins` грузил его из
    // дома. Заменить строку верхний слой по-прежнему может — патчем, который
    // для того и заведён.
    return [...tree];
  }

  if (index !== -1) {
    // Известный id — замена целиком. Незаполненные поля берут умолчания
    // формата (уже разрешённые в operation.enabled), а не значения строки,
    // которую заменяют, — иначе результат зависел бы от того, что написано в
    // чужом файле.
    if (operation.before !== undefined || operation.after !== undefined) {
      throw new StepcastError(`Строка ${operation.id} уже в дереве: замена сохраняет её место`, {
        file: operation.file,
        at: operation.id,
        hint: 'Уберите before/after у замены — переставить строку патч не может',
      });
    }
    const next = [...tree];
    next[index] = row;
    return next;
  }

  if (operation.before !== undefined && operation.after !== undefined) {
    throw new StepcastError(`Строка ${operation.id} называет и before, и after`, {
      file: operation.file,
      at: operation.id,
      hint: 'Назовите только одно поле позиции — before либо after',
    });
  }

  const anchorId = operation.after ?? operation.before;
  if (anchorId !== undefined) {
    const anchorIndex = tree.findIndex((existing) => existing.id === anchorId);
    if (anchorIndex === -1) {
      throw new StepcastError(`Строка ${anchorId} не найдена в дереве`, {
        file: operation.file,
        at: operation.id,
        hint: `Строка ${operation.id} ссылается на ${anchorId} через ${operation.after !== undefined ? 'after' : 'before'} — такой строки в дереве нет`,
      });
    }
    const insertAt = operation.after !== undefined ? anchorIndex + 1 : anchorIndex;
    return [...tree.slice(0, insertAt), row, ...tree.slice(insertAt)];
  }

  return [...tree, row];
}

/** Свернуть операции слоя в дерево, накопленное предыдущими слоями (design.md, Решение 3). */
export function applyOperations(tree: readonly TreeRow[], operations: readonly TreeOperation[]): readonly TreeRow[] {
  let next = tree;
  for (const operation of operations) next = applyOperation(next, operation);
  return next;
}

/**
 * Начальное дерево встроенного слоя: `use` в форме `stepcast:<id>` — тем же
 * путём, каким патч называет строку, поставляемую пакетом (design.md,
 * Решение 2, 5). Порядок совпадает с порядком `ids`.
 */
export function builtinSeedRows(ids: readonly string[]): TreeRow[] {
  return ids.map((id) => ({ id, use: `${BUILTIN_USE_PREFIX}${id}`, enabled: true, source: { kind: 'builtin' } }));
}
