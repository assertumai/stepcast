import { join, relative } from 'node:path';

import { effectiveGroup, parseBacklogFile, readBacklogFile, type BacklogEntry } from '../core/backlog/index.js';
import { isStepcastError } from '../core/errors.js';
import type { Overview } from './overview.js';

/**
 * Вид очереди улучшений по проектам, видимым в обзоре.
 *
 * Читает диск (`backlog.md` в корне каждого проекта), поэтому браузеру этот
 * модуль не отдаётся: ни в `server.fs.allow` (`vite.config.ts`), ни в
 * `include` (`ui/tsconfig.json`) он не входит, в отличие от `routes.ts` и
 * `grouping.ts`.
 *
 * Список проектов и их корни берутся из готового обзора (`buildOverview`), а
 * не обходом корня прогонов заново: обзор уже отбросил проекты без прогонов и
 * уже разрешил путь по указателю `projects.json` (design.md, Решение 2).
 */

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
}

export interface BacklogProjectView {
  readonly projectKey: string;
  readonly projectPath: string;
  /** Пункты в порядке файла — тот же порядок и есть приоритет отбора. */
  readonly items: readonly BacklogItemView[];
  /**
   * Файл очереди есть, но не разбирается. Поля — теми же именами, что у
   * `PipelineView` (`src/ui/pipelines.ts`): карточка неразбираемого пайплайна
   * и раздел неразбираемой очереди показываются одним и тем же приёмом.
   *
   * Подсказки (`errorHint` у пайплайна) здесь нет: ядро очереди её не даёт
   * вовсе — ни один отказ `src/core/backlog/parse.ts` не заполняет `hint`, а
   * `readBacklogFile` кладёт в ошибку только путь и причину. Поле, которое
   * никогда не заполняется, обещало бы экрану несуществующее объяснение.
   */
  readonly error?: string;
  readonly errorFile?: string;
  readonly errorAt?: string;
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

/** Отказ разбора в полях раздела: место внутри документа — половина объяснения. */
interface Failure {
  readonly error: string;
  readonly errorFile?: string;
  readonly errorAt?: string;
}

function toFailure(error: unknown, projectPath: string): Failure {
  if (!isStepcastError(error)) return { error: (error as Error).message };
  const file = error.file === undefined ? undefined : relative(projectPath, error.file).replace(/\\/g, '/');
  return {
    error: error.message,
    ...(file === undefined || file === '' ? {} : { errorFile: file }),
    ...(error.at === undefined ? {} : { errorAt: error.at }),
  };
}

function toItemView(entry: BacklogEntry): BacklogItemView {
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
  };
}

export function buildBacklog(overview: Overview): BacklogOverview {
  const projects: BacklogProjectView[] = [];

  for (const project of overview.projects) {
    // Проект без пути в указателе: читать очередь неоткуда, догадка о пути запрещена.
    if (project.path === undefined) continue;

    const file = join(project.path, 'backlog.md');

    let text: string;
    try {
      text = readBacklogFile(file);
    } catch (error) {
      if (isMissingFile(error)) continue;
      projects.push({ projectKey: project.key, projectPath: project.path, items: [], ...toFailure(error, project.path) });
      continue;
    }

    try {
      const entries = parseBacklogFile(file, text);
      projects.push({ projectKey: project.key, projectPath: project.path, items: entries.map(toItemView) });
    } catch (error) {
      projects.push({ projectKey: project.key, projectPath: project.path, items: [], ...toFailure(error, project.path) });
    }
  }

  return { projects, generatedAt: overview.generatedAt };
}
