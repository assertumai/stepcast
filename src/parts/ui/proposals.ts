import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { listProjects } from '../pipeline/run/journal/reader.js';
import type { ProposalRecord } from '../pipeline/domain/proposals/entry.js';
import { proposalsDirPath, readProposalsDir, type ProposalsReadResult } from '../pipeline/domain/proposals/store.js';

/**
 * Обзор очереди предложений всех проектов и отпечаток её каталога — тем же
 * устройством, что `buildWidgets`/`widgetFingerprint` (`src/parts/ui/widgets.ts`) и
 * `buildDashboards`/`dashboardsDirFingerprint` (`src/parts/ui/dashboardsFile.ts`):
 * этот модуль обходит `projects.json`, чтение одного проекта — забота
 * `parts/pipeline/domain/proposals/store.ts`.
 */

export interface ProjectProposalsView extends ProposalsReadResult {
  readonly projectKey: string;
}

export interface ProposalsOverview {
  readonly projects: readonly ProjectProposalsView[];
}

/**
 * Очередь предложений каждого проекта с известным путём (`ui-proposals`,
 * «Состав очереди идёт потоком событий»). Проект без каталога очереди —
 * законное состояние, пустой раздел, не пропуск.
 */
export function buildProposals(runsRoot: string): ProposalsOverview {
  const projects: ProjectProposalsView[] = [];
  for (const project of listProjects(runsRoot)) {
    if (project.path === undefined || !existsSync(project.path)) continue;
    const result = readProposalsDir(project.path);
    projects.push({ projectKey: project.key, ...result });
  }
  return { projects };
}

/** Запись очереди в потоке событий — без содержимого файла (до 256 КиБ на запись). */
export type ProposalStreamRecord = Omit<ProposalRecord, 'content'>;

export interface ProjectProposalsStream {
  readonly projectKey: string;
  readonly records: readonly ProposalStreamRecord[];
  readonly invalid: ProposalsReadResult['invalid'];
}

export interface ProposalsStreamPayload {
  readonly projects: readonly ProjectProposalsStream[];
}

/**
 * Обзор очереди в форме события потока (design.md Решение 15: «запись несёт
 * содержимое файла — в поток обзора его класть незачем; поток несёт только
 * состав очереди»): содержимое снимается, остальное идёт как есть. Поток — это
 * сигнал «перечитай `GET /api/proposals`», и содержимое в нём было бы
 * дублирующим трафиком: экран по событию всё равно запрашивает свой маршрут,
 * где лежит и содержимое записи, и текущее содержимое цели для дифа.
 */
export function proposalsStreamPayload(overview: ProposalsOverview): ProposalsStreamPayload {
  return {
    projects: overview.projects.map((project) => ({
      projectKey: project.projectKey,
      records: project.records.map(({ content: _content, ...rest }) => rest),
      invalid: project.invalid,
    })),
  };
}

/**
 * Отпечаток каталога очереди проекта — имя и `mtime`+размер каждой записи,
 * тем же приёмом, что `dashboardsDirFingerprint`. Отсутствие каталога —
 * законное состояние отпечатка (`ui-daemon`, «Наблюдение очереди её не
 * изменяет»).
 */
export function proposalsDirFingerprint(projectPath: string): string {
  const dir = proposalsDirPath(projectPath);
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return '-';
  }
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => entry.name)
    .sort();
  if (files.length === 0) return 'empty';
  return files
    .map((name) => {
      try {
        const stat = statSync(join(dir, name));
        return `${name}:${stat.mtimeMs}:${stat.size}`;
      } catch {
        return `${name}:-`;
      }
    })
    .join(',');
}
