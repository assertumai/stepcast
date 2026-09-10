import { join } from 'node:path';

import { effectiveGroup, parseBacklogFile, readBacklogFile, type BacklogEntry } from '../core/backlog/index.js';
import { isStepcastError } from '../core/errors.js';
import type { Overview } from './overview.js';

/**
 * Вид очереди улучшений по проектам, видимым в обзоре.
 *
 * Читает диск (`backlog.md` и `resolved.md` в корне каждого проекта), поэтому
 * браузеру этот модуль не отдаётся: ни в `server.fs.allow` (`vite.config.ts`), ни в
 * `include` (`ui/tsconfig.json`) он не входит, в отличие от `routes.ts` и
 * `grouping.ts`.
 *
 * Список проектов и их корни берутся из готового обзора (`buildOverview`), а
 * не обходом корня прогонов заново: обзор уже отбросил проекты без прогонов и
 * уже разрешил путь по указателю `projects.json` (design.md, Решение 2).
 */

/**
 * Два файла проекта, которые читает очередь: открытые пункты и решённые,
 * вынесенные из `backlog.md` (`docs/backlog.md`). Порядок перечня — порядок
 * их слияния в разделе проекта: сперва пункты `backlog.md`, затем `resolved.md`.
 */
const SOURCE_FILES = ['backlog.md', 'resolved.md'] as const;
export type BacklogSourceFile = (typeof SOURCE_FILES)[number];

export interface BacklogItemView {
  readonly slug: string;
  readonly status: 'pending' | 'in_progress' | 'done' | 'failed';
  readonly title: string;
  /**
   * `why` и `done_when` — абзацы текста, а не строки списка: список из тысячи
   * пунктов они сделали бы нечитаемым. Экран раскрывает их по требованию
   * (design.md, Решение 3), но само значение вид несёт всегда.
   */
  readonly why: string;
  readonly doneWhen: string;
  /** Объявленная группа либо, если пункт её не назвал, слаг самого пункта. */
  readonly group: string;
  /** Объявленный вес пункта; пусто, когда поле не заполнено — без слова по умолчанию. */
  readonly track: string;
  readonly startedAt?: string;
  readonly reason?: string;
  /** Файл, из которого пришёл пункт — `backlog.md` либо `resolved.md`. */
  readonly sourceFile: BacklogSourceFile;
}

/**
 * Отказ разбора одного файла очереди проекта. Поля — теми же именами, что у
 * `PipelineView` (`src/ui/pipelines.ts`): карточка неразбираемого пайплайна и
 * запись неразбираемой очереди показываются одним и тем же приёмом.
 *
 * Подсказки (`errorHint` у пайплайна) здесь нет: ядро очереди её не даёт
 * вовсе — ни один отказ `src/core/backlog/parse.ts` не заполняет `hint`, а
 * `readBacklogFile` кладёт в ошибку только путь и причину. Поле, которое
 * никогда не заполняется, обещало бы экрану несуществующее объяснение.
 *
 * Отдельного `errorFile` нет: `sourceFile` уже называет отказавший файл — оба
 * поля несли бы одно и то же значение.
 */
export interface BacklogFailure {
  readonly sourceFile: BacklogSourceFile;
  readonly error: string;
  readonly errorAt?: string;
}

export interface BacklogProjectView {
  readonly projectKey: string;
  readonly projectPath: string;
  /**
   * Пункты обоих файлов одним списком: сперва `backlog.md` в его файловом
   * порядке, затем `resolved.md` в его. Тот же порядок — приоритет отбора.
   */
  readonly items: readonly BacklogItemView[];
  /** Отказ разбора — по одному на файл, не разобравшийся по формату; пустой список — оба разобрались (или отсутствуют). */
  readonly failures: readonly BacklogFailure[];
}

export interface BacklogOverview {
  readonly projects: readonly BacklogProjectView[];
  readonly generatedAt: string;
}

/** Отсутствие файла — не беда: `readBacklogFile` кладёт код ошибки чтения в `cause`, текст сообщения не смотрим. */
function isMissingFile(error: unknown): boolean {
  if (!isStepcastError(error)) return false;
  return (error.cause as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

/** Место внутри документа — половина объяснения; файл называет вызывающий по своему `sourceFile`. */
function toFailure(error: unknown, sourceFile: BacklogSourceFile): BacklogFailure {
  if (!isStepcastError(error)) return { sourceFile, error: (error as Error).message };
  return { sourceFile, error: error.message, ...(error.at === undefined ? {} : { errorAt: error.at }) };
}

function toItemView(entry: BacklogEntry, sourceFile: BacklogSourceFile): BacklogItemView {
  return {
    slug: entry.slug,
    status: entry.data.status,
    title: entry.data.title,
    why: entry.data.why,
    doneWhen: entry.data.done_when,
    group: effectiveGroup(entry),
    track: entry.data.track ?? '',
    ...(entry.data.started_at === undefined ? {} : { startedAt: entry.data.started_at }),
    ...(entry.data.reason === undefined ? {} : { reason: entry.data.reason }),
    sourceFile,
  };
}

export function buildBacklog(overview: Overview): BacklogOverview {
  const projects: BacklogProjectView[] = [];

  for (const project of overview.projects) {
    // Проект без пути в указателе: читать очередь неоткуда, догадка о пути запрещена.
    if (project.path === undefined) continue;

    const items: BacklogItemView[] = [];
    const failures: BacklogFailure[] = [];
    // Хотя бы один из двух файлов должен существовать — иначе разделу проекта
    // нечего показывать, тем же правилом, что раньше решало судьбу одного
    // `backlog.md` (design.md изменения ui-backlog-reads-resolved).
    let anyFilePresent = false;

    for (const sourceFile of SOURCE_FILES) {
      const file = join(project.path, sourceFile);

      let text: string;
      try {
        text = readBacklogFile(file);
      } catch (error) {
        if (isMissingFile(error)) continue;
        anyFilePresent = true;
        failures.push(toFailure(error, sourceFile));
        continue;
      }

      anyFilePresent = true;
      try {
        const entries = parseBacklogFile(file, text);
        for (const entry of entries) items.push(toItemView(entry, sourceFile));
      } catch (error) {
        failures.push(toFailure(error, sourceFile));
      }
    }

    if (!anyFilePresent) continue;
    projects.push({ projectKey: project.key, projectPath: project.path, items, failures });
  }

  return { projects, generatedAt: overview.generatedAt };
}
