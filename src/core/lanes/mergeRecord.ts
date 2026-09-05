import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { StepcastError } from '../errors.js';
import { atomicWrite } from '../journal/writer.js';

/**
 * Чтение и запись `merge-<дорожка>.json` каталога прогона — исход сведения
 * дорожки, записанный `stepcast merge-lanes`. Каталог прогона, а не дерево
 * проекта: это факт прогона, переживающий восстановление дерева при `resume`
 * (design.md, решение 6).
 */

export type LaneMergeKind =
  | 'merged'
  | 'empty'
  | 'no_item'
  | 'unfit'
  | 'conflict'
  | 'check_failed'
  | 'no_contribution'
  | 'not_reached'
  | 'already_merged';

export interface LaneMergeRecord {
  readonly lane: string;
  readonly kind: LaneMergeKind;
  readonly slug?: string;
  readonly reason?: string;
  /** Затронутые репозитории — только у исхода `merged`. */
  readonly repos?: readonly string[];
  /** Коммит сведения на репозиторий, где он действительно возник. */
  readonly commits?: Readonly<Record<string, string>>;
  readonly at: string;
}

const MERGE_KINDS: ReadonlySet<string> = new Set<LaneMergeKind>([
  'merged',
  'empty',
  'no_item',
  'unfit',
  'conflict',
  'check_failed',
  'no_contribution',
  'not_reached',
  'already_merged',
]);

const MERGE_FILE = /^merge-(.+)\.json$/;

function mergePath(runDir: string, lane: string): string {
  return join(runDir, `merge-${lane}.json`);
}

/** Записать исход сведения дорожки — тем же атомарным писателем, что и журнал прогона. */
export function writeLaneMerge(runDir: string, record: LaneMergeRecord): void {
  atomicWrite(mergePath(runDir, record.lane), `${JSON.stringify(record, null, 2)}\n`);
}

/** Перечень строк — или `undefined`, если значение им не является. */
function stringList(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) return undefined;
  return value as readonly string[];
}

/** Отображение «репозиторий → SHA» — или `undefined`, если значение им не является. */
function stringMap(value: unknown): Readonly<Record<string, string>> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const entries = Object.entries(value);
  if (entries.some(([, sha]) => typeof sha !== 'string')) return undefined;
  return Object.fromEntries(entries) as Record<string, string>;
}

/**
 * Исход сведения дорожки. Отсутствие файла — `undefined`: сведение не
 * пробовалось.
 *
 * Состав файла проверяется, а не принимается на веру приведением типа: на этой
 * записи держится отказ от повторного наложения сведённой дорожки, и запись с
 * незнакомым или отсутствующим видом исхода (файл другой версии движка,
 * обрезанный файл) молча выключала бы щит вместо того, чтобы отказать. Отказ
 * называет файл — как и у файла пункта дорожки (`item.ts`).
 */
export function readLaneMerge(runDir: string, lane: string): LaneMergeRecord | undefined {
  const path = mergePath(runDir, lane);
  if (!existsSync(path)) return undefined;

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new StepcastError(
      `Не удалось прочитать запись сведения дорожки ${lane}: ${(error as Error).message}`,
      { file: path, cause: error },
    );
  }

  const record = (raw ?? {}) as Record<string, unknown>;
  const kind = record.kind;
  if (typeof kind !== 'string' || !MERGE_KINDS.has(kind)) {
    throw new StepcastError(
      `Запись сведения дорожки ${lane} не называет знакомого исхода: ${
        kind === undefined ? 'поле kind отсутствует' : `kind = ${JSON.stringify(kind)}`
      }`,
      { file: path, hint: 'Запись писал движок другой версии либо файл повреждён — удалите его, чтобы свести дорожку заново' },
    );
  }
  const at = record.at;
  if (typeof at !== 'string' || at === '') {
    throw new StepcastError(`Запись сведения дорожки ${lane} не называет момента`, { file: path });
  }

  const repos = stringList(record.repos);
  const commits = stringMap(record.commits);
  return {
    lane,
    kind: kind as LaneMergeKind,
    at,
    ...(typeof record.slug === 'string' ? { slug: record.slug } : {}),
    ...(typeof record.reason === 'string' ? { reason: record.reason } : {}),
    ...(repos === undefined ? {} : { repos }),
    ...(commits === undefined ? {} : { commits }),
  };
}

/** Дорожки, у которых в этом прогоне есть запись исхода сведения. */
export function mergedLanes(runDir: string): readonly string[] {
  if (!existsSync(runDir)) return [];
  return readdirSync(runDir)
    .map((name) => MERGE_FILE.exec(name)?.[1])
    .filter((lane): lane is string => lane !== undefined);
}
