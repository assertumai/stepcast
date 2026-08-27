import { existsSync } from 'node:fs';
import { isAbsolute, relative } from 'node:path';

import {
  isRunAlive,
  listProjects,
  listRunsByKey,
  readManifest,
  readStatus,
  readUsageSoft,
} from '../core/journal/reader.js';
import { runPaths } from '../core/journal/paths.js';
import type { StatusValue } from '../core/journal/schema.js';

/**
 * Обзор всего, что происходит: проекты корня прогонов и их прогоны.
 *
 * Собирается целиком на каждый запрос, без кеша: файлы небольшие, а
 * «пересчитать заново» вместо «кешировать и инвалидировать по частям» — уже
 * стиль движка.
 */

export interface RunOverview {
  readonly runId: string;
  readonly shortId: string;
  readonly pipeline: string;
  /**
   * Файл пайплайна, которым запущен прогон, — путь относительно корня проекта,
   * ровно в том же виде, что `PipelineView.file` (`src/ui/pipelines.ts`): по
   * нему первый экран витрины и находит прогону его пайплайн, потому что имя
   * для этого не годится — два файла проекта могут объявить одно имя, а у
   * неразбираемого файла имени нет вовсе. Путь вне корня проекта (или при
   * неизвестном корне) остаётся абсолютным: он честно не совпадёт ни с одним
   * найденным пайплайном. Отсутствует, если манифест не прочитался.
   */
  readonly pipelineFile?: string;
  /** Отсутствует, если ни манифест, ни состояние прочитать не удалось. */
  readonly status?: StatusValue;
  readonly running: boolean;
  /** Состояние осталось `running`, но процесс мёртв. Ложно вне `running`. */
  readonly abandoned: boolean;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  /** Прогон спит до сброса окна лимита: отличает сон от зависания. */
  readonly wakeAt?: string;
  /** Прогон после уборки: подробностей на диске уже нет. */
  readonly swept: boolean;
  /** Продолжительность прогона: от старта до завершения, а у идущего — до сих пор. */
  readonly durationMs?: number;
  /** Манифест или состояние не читаются — прогон показан, но неполно. */
  readonly unreadable: boolean;
  /** Отсутствует, если состояние прогона не прочиталось. */
  readonly usage?: RunUsageOverview;
}

/**
 * Разрез токенов по видам. Есть только когда сводка прогона уже записана: на
 * идущем прогоне состояние хранит одну оплачиваемую сумму, и раскладывать её
 * по видам было бы выдумкой.
 */
export interface TokenBreakdown {
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}

export interface RunUsageOverview {
  readonly billableTokens: number;
  readonly wallclockMs: number;
  readonly breakdown?: TokenBreakdown;
  /** `null` — цена ни разу не сообщена, а не «потрачено ноль». */
  readonly costUsd: number | null;
  /** Сводка расхода прочитана: `unreported` достоверен. */
  readonly aggregated: boolean;
  readonly unreported: readonly string[];
}

export interface ProjectOverview {
  readonly key: string;
  /** Путь корня проекта. Отсутствует, если его нет в указателе. */
  readonly path?: string;
  readonly runs: readonly RunOverview[];
}

export interface Overview {
  readonly projects: readonly ProjectOverview[];
  readonly generatedAt: string;
}

/**
 * Продолжительность прогона. У завершённого — по отметкам манифеста, у
 * идущего — до текущего момента: замерший на нуле счётчик у часового прогона
 * хуже, чем растущий.
 */
function duration(startedAt: string | undefined, finishedAt: string | undefined, now: Date): number | undefined {
  if (startedAt === undefined) return undefined;
  const from = new Date(startedAt).getTime();
  const to = finishedAt === undefined ? now.getTime() : new Date(finishedAt).getTime();
  if (Number.isNaN(from) || Number.isNaN(to)) return undefined;
  return Math.max(0, to - from);
}

/**
 * Файл пайплайна в том же виде, в каком его называет экран пайплайнов:
 * относительно корня проекта и через прямой слэш. Всё, что за корень не
 * укладывается, отдаётся как есть — подменять такой путь относительным
 * значило бы выдать чужой файл за свой.
 */
function pipelineFileView(projectPath: string | undefined, absolute: string): string {
  if (projectPath === undefined || !isAbsolute(absolute)) return absolute;
  const rel = relative(projectPath, absolute).replace(/\\/g, '/');
  if (rel === '' || rel === '..' || rel.startsWith('../')) return absolute;
  return rel;
}

function readRun(
  runsRoot: string,
  key: string,
  runId: string,
  now: Date,
  projectPath: string | undefined,
): RunOverview {
  const paths = runPaths(runsRoot, key, runId);
  const shortId = runId.slice(runId.lastIndexOf('-') + 1);

  let pipeline = '';
  let pipelineFile: string | undefined;
  let startedAt: string | undefined;
  let finishedAt: string | undefined;
  let status: StatusValue | undefined;
  let wakeAt: string | undefined;
  let unreadable = false;
  let usage: RunUsageOverview | undefined;

  try {
    const manifest = readManifest(paths);
    pipeline = manifest.pipeline;
    pipelineFile = pipelineFileView(projectPath, manifest.pipeline_file);
    startedAt = manifest.started_at;
    finishedAt = manifest.finished_at;
    status = manifest.status;
  } catch {
    unreadable = true;
  }

  // Состояние точнее манифеста для идущего прогона: манифест дописывается
  // статусом только в конце, а состояние переписывается по ходу.
  try {
    const state = readStatus(paths);
    status = state.status;
    wakeAt = state.wake_at;
    if (pipeline === '') pipeline = state.pipeline;

    // Расход читается тем же проходом: сводка, если уже записана и проходит
    // схему, точнее — `status.budget` растёт по ходу прогона и не хранит
    // `unreported`; на идущем прогоне сводки ещё нет, и берётся состояние.
    const { summary } = readUsageSoft(paths);
    const costUsd = summary?.total.cost_usd ?? state.budget.cost_used_usd;
    usage = {
      billableTokens: summary?.total.billable_tokens ?? state.budget.tokens_used,
      wallclockMs: summary?.total.wallclock_ms ?? state.budget.wallclock_ms,
      ...(summary === undefined
        ? {}
        : {
            breakdown: {
              tokensIn: summary.total.tokens_in,
              tokensOut: summary.total.tokens_out,
              cacheRead: summary.total.cache_read,
              cacheWrite: summary.total.cache_write,
            },
          }),
      costUsd: costUsd === undefined ? null : costUsd,
      aggregated: summary !== undefined,
      unreported: summary?.unreported ?? [],
    };
  } catch {
    if (status === undefined) unreadable = true;
  }

  const durationMs = duration(startedAt, finishedAt, now);
  // Живость проверяется только для идущих: на завершённом прогоне
  // `isRunAlive` неизбежно ложно и лишь тратит чтение файлов впустую.
  const abandoned = status === 'running' && !isRunAlive(paths, now.getTime());

  return {
    runId,
    shortId,
    pipeline,
    ...(pipelineFile === undefined ? {} : { pipelineFile }),
    ...(status === undefined ? {} : { status }),
    running: status === 'running',
    abandoned,
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(finishedAt === undefined ? {} : { finishedAt }),
    ...(wakeAt === undefined ? {} : { wakeAt }),
    ...(durationMs === undefined ? {} : { durationMs }),
    // Каталог работ исчезает только после уборки: движок создаёт его всегда.
    swept: !existsSync(paths.jobs),
    unreadable,
    ...(usage === undefined ? {} : { usage }),
  };
}

export function buildOverview(runsRoot: string, now: Date = new Date()): Overview {
  const projects = listProjects(runsRoot).map((project) => ({
    key: project.key,
    ...(project.path === undefined ? {} : { path: project.path }),
    runs: listRunsByKey(runsRoot, project.key).map((runId) =>
      readRun(runsRoot, project.key, runId, now, project.path),
    ),
  }));

  return {
    // Проект без единого прогона показывать незачем: он попал бы в обзор
    // только из-за пустого каталога.
    projects: projects.filter((project) => project.runs.length > 0),
    generatedAt: now.toISOString(),
  };
}
