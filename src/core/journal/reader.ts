import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { uptime } from 'node:os';
import { join } from 'node:path';

import { StepcastError } from '../errors.js';
import { describeSchemaFailure } from '../schema-failure.js';
import { JOURNAL_FORMAT, probeJournalFormat } from './format.js';
import {
  iterationDirName,
  parseIterationDirName,
  parseStepDirName,
  projectKey,
  runPaths,
  stepDir,
  type RunPaths,
} from './paths.js';
import { z } from 'zod';

import {
  EventSchema,
  ExpectReportSchema,
  RunManifestSchema,
  RunStatusSchema,
  UsageReportSchema,
  type Event,
  type ExpectReport,
  type RunManifest,
  type RunStatus,
  type UsageReport,
} from './schema.js';

/**
 * Вид беды. `version-skew` — журнал новее читателя: лечится перезапуском.
 * `legacy-journal` — журнал старше читателя и написан в форме, которой
 * действующие схемы уже не знают (поле удалено или переименовано): лекарства
 * нет, и предлагать перезапуск было бы враньём. `malformed` — файл пострадал,
 * `missing` — файла нет.
 */
export type JournalProblemKind = 'version-skew' | 'legacy-journal' | 'malformed' | 'missing';

/**
 * Беда чтения файла журнала — данные, а не только текст исключения: витрина и
 * лог демона решают по ним, что показать и что предложить.
 */
export interface JournalProblem {
  readonly kind: JournalProblemKind;
  /** Файл журнала — именем внутри каталога прогона: `run.json`, `status.json`. */
  readonly file: string;
  /** Место внутри документа: имя ключа или путь вроде `jobs.2.steps.0`. */
  readonly at?: string;
  /** Что именно не так: «неизвестный ключ pid». */
  readonly detail: string;
  /** Версия формата, объявленная журналом. Нет у журнала прежней формы. */
  readonly journalFormat?: number;
  /** Версия формата, которую знает этот читатель. */
  readonly readerFormat: number;
}

/**
 * Куда разошлись версии, когда строгая схема отвергла незнакомый ключ.
 *
 * Журнал старше читателя — значит поле было удалено или переименовано с тех
 * пор, и читатель отвергает запись, которую сам когда-то писал: перезапуск
 * демона такому прогону не поможет, и называть это устаревшим читателем
 * нельзя. Во всех прочих случаях — журнал новее или вовсе не объявляет
 * версии — отстал читатель.
 *
 * Случай `legacy-journal` становится достижимым с версии 2: при первой версии
 * журнала объявить версию меньше читательской нечем.
 */
export function unknownKeyKind(
  journalFormat: number | undefined,
  readerFormat: number,
): 'version-skew' | 'legacy-journal' {
  return journalFormat !== undefined && journalFormat < readerFormat
    ? 'legacy-journal'
    : 'version-skew';
}

/**
 * Диагноз документа журнала: читает файл сырым `JSON.parse`, пробует схему,
 * классифицирует отказ по правилам design.md (Решение 4).
 *
 * `journalFormat` передаётся вызывающим, а не вычисляется здесь: у
 * `status.json` версии нет вовсе, и её берут из соседнего `run.json` — один
 * процесс одной сборки пишет оба файла, версия у них одна.
 */
function diagnoseDocument<T>(
  filePath: string,
  fileName: string,
  schema: z.ZodType<T>,
  journalFormat: number | undefined,
): { readonly data?: T; readonly problem?: JournalProblem } {
  const readerFormat = JOURNAL_FORMAT;

  if (!existsSync(filePath)) {
    return { problem: { kind: 'missing', file: fileName, detail: 'файл не найден', readerFormat } };
  }

  let text: string;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch (error) {
    return {
      problem: {
        kind: 'malformed',
        file: fileName,
        detail: `не удалось прочитать: ${(error as Error).message}`,
        readerFormat,
      },
    };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return {
      problem: {
        kind: 'malformed',
        file: fileName,
        detail: `документ не разбирается как JSON: ${(error as Error).message}`,
        readerFormat,
      },
    };
  }

  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const failure = describeSchemaFailure(parsed.error);
    // Строгая схема отвергает ключ ровно тогда, когда читатель его не знает:
    // движок ключей вне схемы не пишет, значит разошлись версии, а не файл
    // пострадал. Куда разошлись — говорит объявленная версия: журнал старше
    // читателя означает поле, удалённое или переименованное с тех пор, и
    // перезапуск демона тут не лекарство.
    const unknownKey = parsed.error.issues.some((issue) => issue.code === 'unrecognized_keys');
    return {
      problem: {
        kind: unknownKey ? unknownKeyKind(journalFormat, readerFormat) : 'malformed',
        file: fileName,
        ...(failure.at === undefined ? {} : { at: failure.at }),
        detail: failure.message,
        ...(journalFormat === undefined ? {} : { journalFormat }),
        readerFormat,
      },
    };
  }

  // Разбор прошёл, но объявленная версия новее читателя: новые поля
  // необязательны, и удавшийся разбор не значит, что прочитано всё.
  if (journalFormat !== undefined && journalFormat > readerFormat) {
    return {
      data: parsed.data,
      problem: {
        kind: 'version-skew',
        file: fileName,
        detail: `версия формата журнала ${journalFormat} новее версии читателя ${readerFormat}`,
        journalFormat,
        readerFormat,
      },
    };
  }

  return { data: parsed.data };
}

/**
 * Подлежащее сообщения об отказе вместе с формами, которые с ним согласуются.
 * Род задаётся здесь, а не выводится из строки: «Манифест прогона повреждён»
 * и «Состояние прогона повреждено» — оба текста видны в выводе команд.
 */
interface ProblemSubject {
  readonly subject: string;
  readonly missing: string;
  readonly written: string;
  readonly damaged: string;
}

const MANIFEST_SUBJECT: ProblemSubject = {
  subject: 'Манифест прогона',
  missing: 'не найден',
  written: 'записан',
  damaged: 'повреждён',
};

const STATUS_SUBJECT: ProblemSubject = {
  subject: 'Состояние прогона',
  missing: 'не найдено',
  written: 'записано',
  damaged: 'повреждено',
};

function problemMessage(forms: ProblemSubject, problem: JournalProblem): string {
  const { subject } = forms;
  switch (problem.kind) {
    case 'missing':
      return `${subject} ${forms.missing}`;
    case 'version-skew':
      return `${subject} ${forms.written} более новой версией журнала, чем знает читатель: ${problem.detail}`;
    case 'legacy-journal':
      return `${subject} ${forms.written} прежней формой журнала, которой читатель уже не знает: ${problem.detail}`;
    case 'malformed':
      return `${subject} ${forms.damaged}: ${problem.detail}`;
  }
}

/** Прогоны проекта, новейшие первыми. */
export function listRuns(runsRoot: string, projectRoot: string): string[] {
  const projectDir = join(runsRoot, projectKey(projectRoot));
  if (!existsSync(projectDir)) return [];
  return readdirSync(projectDir)
    .filter((name) => name !== 'latest' && statSync(join(projectDir, name)).isDirectory())
    .sort()
    .reverse();
}

export interface ProjectEntry {
  readonly key: string;
  /** Путь корня проекта из указателя. Отсутствует, если записи в нём нет. */
  readonly path?: string;
}

/**
 * Проекты, найденные в корне прогонов.
 *
 * Что существует, решают каталоги: ключ проекта необратим (sha256 пути), и по
 * каталогу нельзя восстановить путь. Как это назвать, решает `projects.json`.
 * Указатель может отстать или испортиться — писатель это допускает, — поэтому
 * каталог без записи отдаётся без пути, а не выбрасывается и не подписывается
 * догадкой.
 */
export function listProjects(runsRoot: string): ProjectEntry[] {
  if (!existsSync(runsRoot)) return [];

  let index: Record<string, { path?: string }> = {};
  try {
    index = JSON.parse(readFileSync(join(runsRoot, 'projects.json'), 'utf8')) as typeof index;
  } catch {
    // Указателя нет или он повреждён: имена неизвестны, но каталоги на месте.
    index = {};
  }

  return readdirSync(runsRoot)
    .filter((name) => {
      try {
        return statSync(join(runsRoot, name)).isDirectory();
      } catch {
        return false;
      }
    })
    .sort()
    .map((key) => {
      const path = index[key]?.path;
      return typeof path === 'string' ? { key, path } : { key };
    });
}

/** Прогоны проекта по его ключу, новейшие первыми. */
export function listRunsByKey(runsRoot: string, key: string): string[] {
  const projectDir = join(runsRoot, key);
  if (!existsSync(projectDir)) return [];
  return readdirSync(projectDir)
    .filter((name) => {
      if (name === 'latest') return false;
      try {
        return statSync(join(projectDir, name)).isDirectory();
      } catch {
        return false;
      }
    })
    .sort()
    .reverse();
}

/**
 * Найти прогон по идентификатору или его короткому хвосту. Пользователь видит
 * короткий идентификатор в выводе и им же адресует прогон.
 */
export function resolveRun(runsRoot: string, projectRoot: string, runId?: string): RunPaths {
  const key = projectKey(projectRoot);
  const runs = listRuns(runsRoot, projectRoot);

  // `latest` — имя ярлыка в каталоге проекта, и пользователь набирает его
  // раньше, чем идентификатор прогона.
  if (runId === undefined || runId === 'latest') {
    const latest = runs[0];
    if (latest === undefined) {
      throw new StepcastError('Прогонов ещё не было', {
        hint: 'Запустите пайплайн командой stepcast run',
      });
    }
    return runPaths(runsRoot, key, latest);
  }

  const exact = runs.find((name) => name === runId || name.endsWith(`-${runId}`));
  if (exact === undefined) {
    throw new StepcastError(`Прогон ${runId} не найден`, {
      hint:
        runs.length === 0
          ? 'Прогонов ещё не было'
          : `Последние: ${runs.slice(0, 5).join(', ')}`,
    });
  }
  return runPaths(runsRoot, key, exact);
}

export interface ManifestSoftResult {
  readonly manifest?: RunManifest;
  readonly problem?: JournalProblem;
}

/**
 * Манифест, который не бросает, а ставит диагноз: витрине и логу демона
 * отказ разбора нужен как данные, а не как повод остановиться.
 */
export function readManifestSoft(paths: RunPaths): ManifestSoftResult {
  const journalFormat = probeJournalFormat(paths.manifest);
  const { data, problem } = diagnoseDocument(paths.manifest, 'run.json', RunManifestSchema, journalFormat);
  return { ...(data === undefined ? {} : { manifest: data }), ...(problem === undefined ? {} : { problem }) };
}

export interface StatusSoftResult {
  readonly status?: RunStatus;
  readonly problem?: JournalProblem;
}

/**
 * Состояние, которое не бросает, а ставит диагноз. `status.json` версии
 * формата не несёт — она берётся из соседнего `run.json`: оба файла пишет
 * один процесс одной сборки.
 */
export function readStatusSoft(paths: RunPaths): StatusSoftResult {
  const journalFormat = probeJournalFormat(paths.manifest);
  const { data, problem } = diagnoseDocument(paths.status, 'status.json', RunStatusSchema, journalFormat);
  return { ...(data === undefined ? {} : { status: data }), ...(problem === undefined ? {} : { problem }) };
}

export function readStatus(paths: RunPaths): RunStatus {
  const { status, problem } = readStatusSoft(paths);
  if (status !== undefined) return status;
  throw new StepcastError(problemMessage(STATUS_SUBJECT, problem as JournalProblem), {
    file: paths.status,
    ...(problem?.at === undefined ? {} : { at: problem.at }),
  });
}

/** Манифест прогона: способ фиксации якоря, входы, происхождение. */
export function readManifest(paths: RunPaths): RunManifest {
  const { manifest, problem } = readManifestSoft(paths);
  if (manifest !== undefined) return manifest;
  throw new StepcastError(problemMessage(MANIFEST_SUBJECT, problem as JournalProblem), {
    file: paths.manifest,
    ...(problem?.at === undefined ? {} : { at: problem.at }),
  });
}

export function readUsage(paths: RunPaths): UsageReport {
  const parsed = UsageReportSchema.safeParse(readJson(paths.usage));
  if (!parsed.success) {
    throw new StepcastError('Сводка расхода повреждена', { file: paths.usage });
  }
  return parsed.data;
}

export type UsageSummaryUnavailable = 'missing' | 'unreadable';

export interface UsageSummaryResult {
  readonly summary?: UsageReport;
  /** Отсутствует — файла ещё нет (прогон идёт); непрочитана — не прошла схему. */
  readonly unavailable?: UsageSummaryUnavailable;
  /** Диагноз той же беды: файл, место, версии. Нет, когда сводка читается. */
  readonly problem?: JournalProblem;
}

/**
 * Сводка расхода, которая не бросает. Отчёт о расходе (команда и витрина)
 * обязан строиться и на идущем прогоне без `usage.json`, и на прогоне со
 * сводкой прежней формы — `readUsage` для этого слишком строг.
 *
 * `unavailable` остаётся ради команды `stepcast usage`, которой хватает
 * перечисления, а рядом идёт полный диагноз: `UsageReportSchema` так же
 * строга, как остальные, и так же отвалится от следующего добавленного поля —
 * молчать об этом на фоне вылеченных соседей значило бы оставить прежнюю
 * ячейку «не сообщено» ни о чём.
 */
export function readUsageSoft(paths: RunPaths): UsageSummaryResult {
  const journalFormat = probeJournalFormat(paths.manifest);
  const { data, problem } = diagnoseDocument(
    paths.usage,
    'usage.json',
    UsageReportSchema,
    journalFormat,
  );

  // Разобранная сводка остаётся сводкой, даже когда версия разошлась: данные
  // прочитаны, и `unavailable` о них соврал бы.
  if (data !== undefined) return { summary: data, ...(problem === undefined ? {} : { problem }) };
  return {
    unavailable: problem?.kind === 'missing' ? 'missing' : 'unreadable',
    ...(problem === undefined ? {} : { problem }),
  };
}

/**
 * Момент последней загрузки машины. `os.uptime()` округлён до секунд, поэтому
 * граница берётся с запасом в минуту: ошибиться в сторону «прогон жив»
 * безопаснее (планировщик пропустит момент), чем в сторону «мёртв» (два
 * прогона одного пайплайна разом).
 */
function bootTimeMs(now: number): number {
  return now - uptime() * 1000 - 60_000;
}

/**
 * Прогон жив, если его состояние `running`, процесс с идентификатором из
 * манифеста существует и сам прогон начат после последней загрузки машины.
 * Манифест без `pid` (прежняя форма) считается неживым: сигнал 0 ничего не
 * убивает, только проверяет существование процесса — `ESRCH` означает «нет
 * такого процесса», а `EPERM` означает, что процесс есть, но принадлежит
 * другому пользователю, то есть жив.
 *
 * Сверка с загрузкой нужна против переиспользования идентификатора: прогон,
 * убитый вместе с машиной, навсегда остаётся в состоянии `running`, а его pid
 * после перезагрузки достаётся постороннему процессу — и планировщик молча
 * пропускал бы моменты, ссылаясь на прогон, которого нет. Внутри одной
 * загрузки переиспользование остаётся возможным, но требует, чтобы счётчик
 * pid успел обойти круг, и приводит лишь к пропуску моментов, а не к порче
 * журнала.
 */
export function isRunAlive(paths: RunPaths, now: number = Date.now()): boolean {
  let status: RunStatus;
  try {
    status = readStatus(paths);
  } catch {
    return false;
  }
  if (status.status !== 'running') return false;

  let manifest: RunManifest;
  try {
    manifest = readManifest(paths);
  } catch {
    return false;
  }
  if (manifest.pid === undefined) return false;

  const startedAt = Date.parse(manifest.started_at);
  if (!Number.isNaN(startedAt) && startedAt < bootTimeMs(now)) return false;

  try {
    process.kill(manifest.pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Живой прогон пайплайна проекта, если он есть. `listRuns` отдаёт прогоны
 * новейшими первыми, поэтому первый живой найденный — он же единственный,
 * которого стоит искать: планировщик проверяет единственность в пределах
 * одного пайплайна, а не всего проекта.
 */
export function findAliveRun(
  runsRoot: string,
  projectRoot: string,
  pipelineFile: string,
  now: number = Date.now(),
): RunPaths | undefined {
  const key = projectKey(projectRoot);
  for (const runId of listRuns(runsRoot, projectRoot)) {
    const candidate = runPaths(runsRoot, key, runId);
    let manifest: RunManifest;
    try {
      manifest = readManifest(candidate);
    } catch {
      continue;
    }
    if (manifest.pipeline_file !== pipelineFile) continue;
    if (isRunAlive(candidate, now)) return candidate;
  }
  return undefined;
}

export interface ResetHint {
  readonly resetsAt: number;
}

/**
 * Момент сброса окна лимита из последнего завершённого прогона пайплайна.
 *
 * Смотрит только на `backend.refused` и `budget.waiting` — оба несут
 * `resets_at`, а `budget.exceeded` (потолки `tokens`/`cost`/`wallclock`) его не
 * несёт и не должен откладывать следующее срабатывание: эти потолки не
 * сбрасываются по времени и относятся к прогону, а не к внешнему окну.
 * Подсказка даётся только тем прогоном, который упёрся в окно и на этом
 * остановился: если после отказа прогон продолжил работу — дождался сброса
 * (`budget.resumed`), успешно закончил шаг или завершился успехом — окно его
 * не остановило, и откладывать следующее срабатывание нечем. Поэтому
 * `resets_at` последнего отказа сбрасывается любым признаком продолжения.
 */
export function readResetHint(
  runsRoot: string,
  projectRoot: string,
  pipelineFile: string,
): ResetHint | undefined {
  const key = projectKey(projectRoot);
  for (const runId of listRuns(runsRoot, projectRoot)) {
    const candidate = runPaths(runsRoot, key, runId);
    let manifest: RunManifest;
    try {
      manifest = readManifest(candidate);
    } catch {
      continue;
    }
    if (manifest.pipeline_file !== pipelineFile) continue;
    if (manifest.finished_at === undefined) continue;

    // Подсказка считается по всем событиям прогона, и усечённый список даёт
    // неверный ответ в обе стороны: потерянный `budget.resumed` отложит
    // следующее срабатывание зря, потерянный `backend.refused` не отложит
    // его вовсе. Прочитать список целиком не удалось — значит сказать
    // нечего; планировщик сработает по своему расписанию, а не по догадке.
    const { events, problem } = readEventsSoft(candidate);
    if (problem !== undefined) return undefined;

    let resetsAt: number | undefined;
    for (const event of events) {
      if (event.kind === 'backend.refused' && event.resets_at !== undefined) {
        resetsAt = event.resets_at;
      } else if (event.kind === 'budget.waiting') {
        resetsAt = event.resets_at;
      } else if (
        event.kind === 'budget.resumed' ||
        (event.kind === 'step.finished' && event.status === 'success') ||
        (event.kind === 'run.finished' && event.status === 'success')
      ) {
        resetsAt = undefined;
      }
    }
    return resetsAt === undefined ? undefined : { resetsAt };
  }
  return undefined;
}

export interface EventsSoftResult {
  /** Строки, прошедшие схему. Отказавшая строка сюда не попадает. */
  readonly events: readonly Event[];
  /** Диагноз первой отказавшей строки. Нет, когда прочитаны все строки. */
  readonly problem?: JournalProblem;
}

/**
 * События вместе с диагнозом: строка, не прошедшую схему, читатель теряет — и
 * обязан об этом сказать. Потеря записи опаснее отказа манифеста: усечённый
 * список событий выглядит полным, и решение по нему (`readResetHint`)
 * принимается молча и неверно.
 *
 * Диагноз ставится по первой отказавшей строке: беда у всех строк одна —
 * схема разошлась с записанным, — и перечислять её построчно значило бы
 * повторять один и тот же ответ сотни раз.
 */
export function readEventsSoft(paths: RunPaths): EventsSoftResult {
  if (!existsSync(paths.events)) return { events: [] };

  const readerFormat = JOURNAL_FORMAT;
  const journalFormat = probeJournalFormat(paths.manifest);
  const events: Event[] = [];
  let problem: JournalProblem | undefined;
  let lineNumber = 0;

  for (const line of readFileSync(paths.events, 'utf8').split('\n')) {
    lineNumber += 1;
    if (line.trim() === '') continue;

    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch (error) {
      problem ??= {
        kind: 'malformed',
        file: 'events.jsonl',
        at: `строка ${lineNumber}`,
        detail: `строка не разбирается как JSON: ${(error as Error).message}`,
        ...(journalFormat === undefined ? {} : { journalFormat }),
        readerFormat,
      };
      continue;
    }

    const parsed = EventSchema.safeParse(raw);
    if (parsed.success) {
      events.push(parsed.data);
      continue;
    }

    const failure = describeSchemaFailure(parsed.error);
    const unknownKey = parsed.error.issues.some((issue) => issue.code === 'unrecognized_keys');
    problem ??= {
      kind: unknownKey ? unknownKeyKind(journalFormat, readerFormat) : 'malformed',
      file: 'events.jsonl',
      at: failure.at === undefined ? `строка ${lineNumber}` : `строка ${lineNumber}, ${failure.at}`,
      detail: failure.message,
      ...(journalFormat === undefined ? {} : { journalFormat }),
      readerFormat,
    };
  }

  return { events, ...(problem === undefined ? {} : { problem }) };
}

/**
 * События прогона. Строки, не прошедшие схему, пропускаются: движок читает
 * события ради признаков, и одна незнакомая запись не повод отказать в
 * остальных. Кому важна полнота списка — `readEventsSoft`.
 */
export function readEvents(paths: RunPaths): Event[] {
  return [...readEventsSoft(paths).events];
}

/** Найти каталог шага по идентификаторам, без знания его номера. */
/**
 * Результаты предикатов шага по попыткам. Пустой список означает, что отчёта
 * нет, — например, шаг не дошёл до проверок.
 */
export function readExpectReports(
  paths: RunPaths,
  jobId: string,
  stepId: string,
): ExpectReport[] {
  const dir = findStepDir(paths, jobId, stepId);
  if (dir === undefined) return [];
  const file = join(dir, 'expect.json');
  if (!existsSync(file)) return [];

  const raw = readJson(file);
  const many = z.array(ExpectReportSchema).safeParse(raw);
  if (many.success) return many.data;
  const one = ExpectReportSchema.safeParse(raw);
  return one.success ? [one.data] : [];
}

/**
 * Каталог шага. Итерацию можно не указывать — тогда берётся последняя
 * выполненная: чаще всего спрашивают именно про неё.
 */
export function findStepDir(
  paths: RunPaths,
  jobId: string,
  stepId: string,
  iteration?: number,
): string | undefined {
  const stepsDir = join(paths.jobs, jobId, 'steps');
  if (!existsSync(stepsDir)) return undefined;

  const iterations = readdirSync(stepsDir)
    .map(parseIterationDirName)
    .filter((value): value is number => value !== undefined)
    .sort((a, b) => a - b);

  if (iterations.length > 0) {
    const target = iteration ?? iterations.at(-1);
    if (target === undefined || !iterations.includes(target)) return undefined;
    return within(paths, jobId, stepId, join(stepsDir, iterationDirName(target)), target);
  }

  return within(paths, jobId, stepId, stepsDir, undefined);
}

function within(
  paths: RunPaths,
  jobId: string,
  stepId: string,
  dir: string,
  iteration: number | undefined,
): string | undefined {
  if (!existsSync(dir)) return undefined;
  for (const name of readdirSync(dir)) {
    const parsed = parseStepDirName(name);
    if (parsed?.stepId === stepId) {
      return stepDir(paths, jobId, parsed.index, parsed.stepId, iteration);
    }
  }
  return undefined;
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new StepcastError(`Не удалось прочитать ${path}: ${(error as Error).message}`, {
      file: path,
      cause: error,
    });
  }
}

export interface FollowOptions {
  readonly intervalMs?: number;
  readonly signal?: AbortSignal;
}

/**
 * Читать файл и продолжать отдавать дописанное.
 *
 * Опрос по таймеру, а не слежение средствами платформы: девяностоминутный
 * прогон должен показывать вывод одинаково на любой файловой системе, включая
 * сетевые, где уведомления об изменениях приходят не всегда.
 */
export async function* follow(
  path: string,
  options: FollowOptions = {},
): AsyncGenerator<string> {
  const interval = options.intervalMs ?? 200;
  let offset = 0;
  let carry = '';

  for (;;) {
    if (options.signal?.aborted === true) return;

    if (existsSync(path)) {
      const handle = await open(path, 'r');
      try {
        const { size } = await handle.stat();
        if (size > offset) {
          const length = size - offset;
          const buffer = Buffer.alloc(length);
          await handle.read(buffer, 0, length, offset);
          offset = size;
          carry += buffer.toString('utf8');

          const lines = carry.split('\n');
          carry = lines.pop() ?? '';
          for (const line of lines) yield line;
        } else if (size < offset) {
          // Файл усечён или заменён — начинаем сначала, чтобы не выдавать мусор.
          offset = 0;
          carry = '';
        }
      } finally {
        await handle.close();
      }
    }

    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}
