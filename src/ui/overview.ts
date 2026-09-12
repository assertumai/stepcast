import { existsSync } from 'node:fs';
import { isAbsolute, relative } from 'node:path';

import {
  isRunAlive,
  listProjects,
  listRunsByKey,
  readManifestSoft,
  readStatusSoft,
  readUsageSoft,
  type JournalProblem,
} from '../core/journal/reader.js';
import { runPaths } from '../core/journal/paths.js';
import type { AwaitingDecision, StatusValue, UsageRecord } from '../core/journal/schema.js';
import { readUsageStore } from '../core/journal/usageStore.js';

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
  /**
   * Ожидания решения человека, идущие прямо сейчас (`user-decision-steps`,
   * design.md решение 2, решение 11): тем же полем, что и `wake_at`, читается
   * из состояния без нового маршрута — экран «Решения» берёт этот же обзор.
   */
  readonly awaiting?: readonly AwaitingDecision[];
  /** Прогон после уборки: подробностей на диске уже нет, но каталог остался. */
  readonly swept: boolean;
  /**
   * У прогона нет каталога вовсе — файлы удалены, а запись хранилища расхода
   * (`journal/usageStore.ts`) сохранена (run-stats-retention, Решение 12).
   * Отличимо от `swept`: там каталог, пусть и пустой, ещё существует.
   */
  readonly filesGone: boolean;
  /** Продолжительность прогона: от старта до завершения, а у идущего — до сих пор. */
  readonly durationMs?: number;
  /** Манифест или состояние не читаются — прогон показан, но неполно. */
  readonly unreadable: boolean;
  /**
   * Диагноз беды чтения: файл, место, версии. Отсутствует, когда манифест и
   * состояние читаются штатно. Манифест разбирается первым — при беде в
   * обоих файлах называется его диагноз.
   */
  readonly problem?: JournalProblem;
  /** Отсутствует, если состояние прогона не прочиталось. */
  readonly usage?: RunUsageOverview;
}

/**
 * Разрез токенов по видам. Есть только когда сводка прогона уже прочитана —
 * на идущем прогоне так же, как на завершённом, раз сводка теперь пишется по
 * ходу (usage-live-progress). Отсутствует, только если сводки ещё нет вовсе
 * (окно до первой записи, прогон прежней формы) — тогда состояние хранит одну
 * оплачиваемую сумму, и раскладывать её по видам было бы выдумкой.
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
  /**
   * Сводка прочитана, но прогон ещё не завершён: показанные величины
   * накоплены на текущий момент, а не подведены. Ложно и когда сводки нет
   * вовсе (`aggregated: false`), и когда прогон завершился, — читать признак
   * есть смысл только вместе с `aggregated: true`.
   */
  readonly partial: boolean;
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

/**
 * Беда, о которой стоит говорить. Отсутствие `status.json` или `usage.json`
 * при читаемом манифесте — обычное состояние начинающегося прогона: манифест
 * пишется первым, а состояние и сводка расхода — следом, первой же записью
 * прогона (`writeStatus` в `run/runner.ts`), так что окно без них — доли
 * секунды старта. Тем же выглядит и прогон прежней формы, чья сводка
 * писалась только в конце и не дождалась его. Называть это бедой значило бы
 * обвинять здоровый прогон.
 */
function worthTelling(problem: JournalProblem | undefined): JournalProblem | undefined {
  return problem?.kind === 'missing' ? undefined : problem;
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
  let awaiting: readonly AwaitingDecision[] | undefined;
  let usage: RunUsageOverview | undefined;
  let usageProblem: JournalProblem | undefined;

  const { manifest, problem: manifestProblem } = readManifestSoft(paths);
  if (manifest !== undefined) {
    pipeline = manifest.pipeline;
    pipelineFile = pipelineFileView(projectPath, manifest.pipeline_file);
    startedAt = manifest.started_at;
    finishedAt = manifest.finished_at;
    status = manifest.status;
  }

  // Состояние точнее манифеста для идущего прогона: манифест дописывается
  // статусом только в конце, а состояние переписывается по ходу.
  const { status: state, problem: statusProblem } = readStatusSoft(paths);
  if (state !== undefined) {
    status = state.status;
    wakeAt = state.wake_at;
    awaiting = state.awaiting;
    if (pipeline === '') pipeline = state.pipeline;

    // Расход читается тем же проходом: сводка, если уже записана и проходит
    // схему, точнее — она несёт разрез по видам токенов и `unreported`,
    // которых `status.budget` не хранит. Сводка есть и у идущего прогона:
    // она пишется по ходу (usage-live-progress) и лишь помечена `partial`.
    // Состояние остаётся запасным — на окно до первой записи сводки и на
    // прогон, чья сводка не проходит текущую схему.
    const { summary, problem: usageFailure } = readUsageSoft(paths);
    usageProblem = usageFailure;
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
      partial: summary?.partial === true,
      unreported: summary?.unreported ?? [],
    };
  }

  // Манифест разбирается первым — при беде в нескольких файлах его диагноз и
  // есть ответ на вопрос «почему прогон показан неполно». Сводка расхода идёт
  // последней: её беда объясняет пустую ячейку расхода, когда манифест и
  // состояние читаются.
  const problem =
    manifestProblem ?? worthTelling(statusProblem) ?? worthTelling(usageProblem);
  // То же правило, что было у пары try/catch: манифест не прочитался —
  // прогон неполон; состояние не прочиталось — неполон, только если статус
  // не достался и от манифеста тоже.
  const unreadable = manifest === undefined || (state === undefined && status === undefined);

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
    ...(awaiting === undefined || awaiting.length === 0 ? {} : { awaiting }),
    ...(durationMs === undefined ? {} : { durationMs }),
    // Каталог работ исчезает только после уборки: движок создаёт его всегда.
    swept: !existsSync(paths.jobs),
    filesGone: false,
    unreadable,
    ...(problem === undefined ? {} : { problem }),
    ...(usage === undefined ? {} : { usage }),
  };
}

/**
 * Продолжительность записи хранилища: у незавершённого переноса
 * (`finished_at` отсутствует) считать нечего — тот же смысл, что и у
 * `duration()` для прогона без времени завершения.
 */
function recordDurationMs(record: UsageRecord): number | undefined {
  if (record.finished_at === undefined) return undefined;
  const from = new Date(record.started_at).getTime();
  const to = new Date(record.finished_at).getTime();
  return Number.isNaN(from) || Number.isNaN(to) ? undefined : Math.max(0, to - from);
}

/**
 * Прогон без каталога — целиком из записи хранилища (Решение 12). Разрез по
 * моделям в обзоре не показывается (это дело экрана расхода), только итог —
 * тот же набор полей, что несёт `RunUsageOverview` для прогона с диска.
 */
function overviewFromRecord(record: UsageRecord, projectPath: string | undefined): RunOverview {
  const durationMs = recordDurationMs(record);
  return {
    runId: record.run_id,
    shortId: record.run_id.slice(record.run_id.lastIndexOf('-') + 1),
    pipeline: record.pipeline.name,
    pipelineFile: pipelineFileView(projectPath, record.pipeline.file),
    status: record.status,
    running: false,
    abandoned: false,
    startedAt: record.started_at,
    ...(record.finished_at === undefined ? {} : { finishedAt: record.finished_at }),
    ...(durationMs === undefined ? {} : { durationMs }),
    swept: false,
    filesGone: true,
    unreadable: false,
    usage: {
      billableTokens: record.total.billable_tokens,
      wallclockMs: record.total.wallclock_ms,
      breakdown: {
        tokensIn: record.total.tokens_in,
        tokensOut: record.total.tokens_out,
        cacheRead: record.total.cache_read,
        cacheWrite: record.total.cache_write,
      },
      costUsd: record.total.cost_usd ?? null,
      aggregated: true,
      partial: false,
      unreported: record.unreported,
    },
  };
}

/** Путь проекта из любой его записи хранилища — запасной вариант, когда каталога уже нет. */
function pathFromRecords(records: ReadonlyMap<string, UsageRecord>, key: string): string | undefined {
  for (const record of records.values()) if (record.project.key === key) return record.project.path;
  return undefined;
}

export function buildOverview(runsRoot: string, now: Date = new Date()): Overview {
  // Хранилище только читается здесь: перенос накопленного делает тот, кто
  // открывает хранилище (демон при старте), а не сборка обзора на каждый
  // запрос (design.md изменения run-stats-retention, Решение 9).
  const { records } = readUsageStore(runsRoot);

  const diskProjects = listProjects(runsRoot);
  const pathByKey = new Map(diskProjects.map((project) => [project.key, project.path] as const));
  const keys = new Set(diskProjects.map((project) => project.key));
  for (const record of records.values()) keys.add(record.project.key);

  const projects = [...keys].sort().map((key) => {
    const path = pathByKey.get(key) ?? pathFromRecords(records, key);
    const diskRunIds = listRunsByKey(runsRoot, key);
    const diskRuns = diskRunIds.map((runId) => readRun(runsRoot, key, runId, now, path));

    // Прогоны, чьи файлы удалены, а запись сохранена: не входят в
    // `listRunsByKey`, потому что каталога у них нет вовсе.
    const onDisk = new Set(diskRunIds);
    const recordOnlyRuns = [...records.values()]
      .filter((record) => record.project.key === key && !onDisk.has(record.run_id))
      .map((record) => overviewFromRecord(record, path));

    // Общий порядок — новейшими первыми, тот же, что даёт `listRunsByKey` для
    // каталогов: идентификатор прогона начинается отметкой времени.
    const runs = [...diskRuns, ...recordOnlyRuns].sort((a, b) => b.runId.localeCompare(a.runId));

    return { key, ...(path === undefined ? {} : { path }), runs };
  });

  return {
    // Проект без единого прогона показывать незачем: он попал бы в обзор
    // только из-за пустого каталога.
    projects: projects.filter((project) => project.runs.length > 0),
    generatedAt: now.toISOString(),
  };
}
