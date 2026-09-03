/**
 * Договор витрины с демоном.
 *
 * Типы описаны здесь заново, а не импортированы из `src/ui`: между браузером и
 * демоном лежит JSON, и общий тип создавал бы впечатление общей памяти —
 * браузер собирается бандлером, демон компилируется `tsc`, и модулями они не
 * делятся. Расхождение с сервером типизация здесь не поймает; его ловят тесты
 * сервера, проверяющие ответы. Зато вся граница видна в одном файле.
 *
 * Поля сверены построчно с `src/ui/overview.ts`, `src/ui/snapshot.ts`,
 * `src/ui/pipelines.ts`, `src/ui/graph.ts` и `src/ui/settings.ts`, а формы
 * ответов на отбор и удаление — с обработчиками `src/ui/server.ts`.
 */

export type StatusValue =
  | 'pending'
  | 'running'
  | 'success'
  | 'failed'
  | 'skipped'
  | 'canceled'
  | 'budget_exceeded';

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
  readonly costUsd: number | null;
  readonly aggregated: boolean;
  readonly unreported: readonly string[];
}

/**
 * `version-skew` — журнал новее читателя: лечится перезапуском демона.
 * `legacy-journal` — журнал старше читателя и написан формой, которой
 * действующие схемы уже не знают: лекарства нет. `malformed` — файл
 * пострадал, `missing` — файла нет.
 */
export type JournalProblemKind = 'version-skew' | 'legacy-journal' | 'malformed' | 'missing';

/** Беда чтения файла журнала — данные, а не только текст исключения. */
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

export interface RunOverview {
  readonly runId: string;
  readonly shortId: string;
  readonly pipeline: string;
  /**
   * Файл, которым запущен прогон, — относительно корня проекта, тем же видом,
   * что `PipelineView.file`: по нему прогон и находит свой пайплайн. Пусто,
   * если манифест прогона не прочитался.
   */
  readonly pipelineFile?: string;
  readonly status?: StatusValue;
  readonly running: boolean;
  /** Состояние осталось `running`, но процесс мёртв. Ложно вне `running`. */
  readonly abandoned: boolean;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly wakeAt?: string;
  readonly swept: boolean;
  readonly durationMs?: number;
  readonly unreadable: boolean;
  /** Диагноз беды чтения: файл, место, версии. Отсутствует, когда читаются штатно. */
  readonly problem?: JournalProblem;
  readonly usage?: RunUsageOverview;
}

export interface ProjectOverview {
  readonly key: string;
  readonly path?: string;
  readonly runs: readonly RunOverview[];
}

export interface Overview {
  readonly projects: readonly ProjectOverview[];
  readonly generatedAt: string;
}

export interface GraphNode {
  readonly id: string;
  readonly column: number;
  readonly row: number;
  readonly needs: readonly string[];
  readonly on: 'success' | 'failure' | 'always';
  readonly if?: string;
  readonly conditional: boolean;
  readonly status?: StatusValue;
  /** Раскрытая подпись работы: ключ `title` показывается строкой в узле. */
  readonly display?: Readonly<Record<string, string>>;
  readonly blockedBy: readonly string[];
}

export interface GraphEdge {
  readonly from: string;
  readonly to: string;
  readonly blocking: boolean;
}

export interface JobGraph {
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
  readonly columns: number;
}

export interface JournalFileRef {
  readonly name: string;
  readonly path: string;
  readonly bytes: number;
}

export interface UsageSnapshot {
  readonly billableTokens: number | null;
  readonly wallclockMs: number | null;
  readonly costUsd: number | null;
}

export interface ContextBreakdown {
  readonly levels: Readonly<Record<'upstream' | 'pipeline' | 'job' | 'step', number>>;
  readonly total: number;
}

export interface StepSnapshot {
  readonly id: string;
  readonly kind: 'agent' | 'run';
  readonly agent?: string;
  readonly model?: string;
  readonly status?: StatusValue;
  readonly reason?: string;
  readonly attempts: number;
  /** Отрезок исполнения шага: начало первой попытки и конец последней. */
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly prompt?: string;
  readonly command?: string;
  readonly context: readonly string[];
  readonly contextBreakdown?: ContextBreakdown;
  readonly files: readonly JournalFileRef[];
  readonly usage: UsageSnapshot;
}

export interface JobSnapshot {
  readonly id: string;
  readonly description?: string;
  readonly status?: StatusValue;
  readonly reason?: string;
  /** Отрезок исполнения работы: у идущей конца ещё нет. */
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly needs: readonly string[];
  readonly if?: string;
  readonly on: 'success' | 'failure' | 'always';
  readonly context: readonly string[];
  readonly inputs: readonly JournalFileRef[];
  readonly output?: JournalFileRef;
  readonly outputDeclared: boolean;
  /** Подпись работы, раскрытая демоном против данных прогона. */
  readonly display?: Readonly<Record<string, string>>;
  /** Данные, опубликованные самой работой командой `stepcast data`. */
  readonly data?: Readonly<Record<string, string>>;
  readonly steps: readonly StepSnapshot[];
  readonly usage: UsageSnapshot;
}

export interface RunSnapshot {
  readonly runId: string;
  readonly projectKey: string;
  readonly pipeline: string;
  readonly status?: StatusValue;
  readonly jobs: readonly JobSnapshot[];
  readonly graph: JobGraph;
  readonly swept: boolean;
  /** Диагноз беды чтения журнала: манифест, состояние, сводка расхода — в этом порядке. */
  readonly problem?: JournalProblem;
}

export interface PipelineStepView {
  readonly id: string;
  readonly kind: 'agent' | 'run';
  readonly agent?: string;
  readonly model?: string;
  readonly command?: string;
}

export interface PipelineJobView {
  readonly id: string;
  readonly description?: string;
  readonly needs: readonly string[];
  readonly on: 'success' | 'failure' | 'always';
  readonly if?: string;
  readonly publishesOutput: boolean;
  readonly steps: readonly PipelineStepView[];
}

export interface PipelineView {
  readonly projectKey: string;
  readonly projectPath: string;
  readonly file: string;
  readonly name: string;
  readonly concurrency?: number;
  readonly failFast?: boolean;
  readonly jobs: readonly PipelineJobView[];
  readonly graph?: JobGraph;
  /** Файл не разбирается: текст, место и подсказка — тем же составом, что печатает CLI. */
  readonly error?: string;
  /** Файл ошибки относительно корня проекта: у `uses` это файл работы, а не пайплайна. */
  readonly errorFile?: string;
  /** Место ошибки внутри документа, например `jobs.propose-a`. */
  readonly errorAt?: string;
  readonly errorHint?: string;
}

export interface PipelinesOverview {
  readonly pipelines: readonly PipelineView[];
  readonly generatedAt: string;
}

/** Сверено построчно с `UsageMeasure` (`src/ui/usage.ts`). */
export interface UsageMeasure {
  readonly billableTokens: number;
  readonly costUsd: number;
}

export interface UsageModelSlice extends UsageMeasure {
  readonly model: string;
}

export interface UsageDaySlice {
  readonly day: string;
  readonly models: readonly UsageModelSlice[];
}

export interface UsagePipelineRun {
  readonly runId: string;
  readonly shortId: string;
  readonly startedAt?: string;
  /** Календарный день захода в поясе демона — тот же, что у записи в `days`. */
  readonly day: string;
  readonly status?: StatusValue;
  readonly billableTokens: number;
  /** `null` — цена прогона ни разу не сообщена, а не «потрачено ноль». */
  readonly costUsd: number | null;
  readonly costUnreportedAttempts: number;
  readonly breakdownAvailable: boolean;
}

export interface UsagePipelineSlice extends UsageMeasure {
  readonly projectKey: string;
  readonly projectPath?: string;
  readonly pipeline: string;
  readonly pipelineFile?: string;
  readonly costUnreportedAttempts: number;
  readonly runs: readonly UsagePipelineRun[];
}

export interface UsageTotal extends UsageMeasure {
  readonly costUnreportedAttempts: number;
  readonly runs: number;
}

export interface UsageResult {
  readonly from: string;
  readonly to: string;
  readonly generatedAt: string;
  readonly total: UsageTotal;
  readonly models: readonly UsageModelSlice[];
  readonly days: readonly UsageDaySlice[];
  readonly pipelines: readonly UsagePipelineSlice[];
  readonly runsWithoutBreakdown: number;
  readonly undated: number;
}

/**
 * Доля расхода, чью модель назвать нечем (`src/ui/usage.ts`).
 *
 * Строка продублирована, а не импортирована: `usage.ts` читает диск через
 * `reader.js` и живёт только в демоне (см. заголовок этого файла), а значение
 * сверяется тестами сервера.
 */
export const UNKNOWN_MODEL = 'модель не сообщена';

/** Какой конец крупного файла запрошен и показан. */
export type FileSide = 'head' | 'tail';

export interface FileContent {
  readonly content: string;
  readonly bytes: number;
  readonly truncated: boolean;
  readonly side: FileSide;
}

/**
 * Вывод шага по логическому адресу — сверено построчно с
 * `src/ui/stepOutput.ts` и обработчиком `/api/step-output` в `src/ui/server.ts`.
 */
export interface StepOutputStream {
  readonly exists: boolean;
  readonly content: string;
  readonly bytes: number;
  readonly offset: number;
  readonly truncated: boolean;
  readonly truncatedFrom?: number;
  readonly restarted: boolean;
}

export interface StepOutputResult {
  readonly attempts: readonly number[];
  readonly attempt?: number;
  readonly done: boolean;
  readonly stdout?: StepOutputStream;
  readonly stderr?: StepOutputStream;
}

export interface SettingsValue {
  readonly value?: string;
  /** Откуда взято значение: встроенное умолчание или путь файла. */
  readonly source: string;
}

export interface BackendView {
  readonly name: string;
  readonly command: string;
  readonly enabled: boolean;
  readonly defaultModel?: string;
}

export interface Settings {
  readonly agent: SettingsValue;
  readonly model: SettingsValue;
  readonly backends: readonly BackendView[];
  /** Файл, в который витрина пишет. Пользователь должен знать, что правит. */
  readonly file: string;
}

export interface SettingsPatch {
  readonly agent?: string;
  /** `null` — снять значение и вернуться к модели бэкенда. */
  readonly model?: string | null;
}

/** Признак отбора прогонов к уборке. Имена — те же, что принимает демон. */
export type CleanupTrait = 'abandoned' | 'failed';

export interface RunCandidate {
  readonly address: string;
  readonly sizeBytes: number;
  readonly ageMs: number;
  readonly endedAt?: string;
  /** Журнал не прочитался: возраст взят по каталогу, статуса нет. */
  readonly unreadable: boolean;
}

export interface RunSelection {
  readonly runs: readonly RunCandidate[];
  readonly count: number;
  readonly totalBytes: number;
}

export type RemovalOutcomeKind = 'removed' | 'skipped_missing' | 'skipped_alive' | 'failed';

export interface RemovalOutcome {
  readonly address: string;
  readonly outcome: RemovalOutcomeKind;
  readonly sizeBytes?: number;
  readonly reason?: string;
}

export interface RemovalSummary {
  readonly outcomes: readonly RemovalOutcome[];
  readonly freedBytes: number;
}

/** Ответ демона с внятной ошибкой: её текст показывается как есть. */
async function json<T>(response: Response): Promise<T> {
  const data = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(data.error ?? `Демон ответил ${response.status}`);
  return data;
}

/** Прямой запрос обзора: живой поток (`live.ts`) присылает его же событием `overview`. */
export async function fetchOverview(): Promise<Overview> {
  return json<Overview>(await fetch('/api/overview'));
}

export async function fetchRun(address: string): Promise<RunSnapshot> {
  return json<RunSnapshot>(await fetch(`/api/run?run=${encodeURIComponent(address)}`));
}

/**
 * Содержимое файла журнала. `side` — какой конец показать, если файл крупнее
 * потолка демона; на файле меньше потолка параметр ничего не меняет.
 */
export async function fetchFile(
  address: string,
  path: string,
  side: FileSide = 'tail',
): Promise<FileContent> {
  const query = `run=${encodeURIComponent(address)}&path=${encodeURIComponent(path)}&side=${side}`;
  return json<FileContent>(await fetch(`/api/file?${query}`));
}

/**
 * Дописанное с вывода шага. Присутствие `stdoutOffset`/`stderrOffset` в
 * параметрах — сама просьба прочитать поток (см. `StepOutputQuery` в
 * `src/ui/stepOutput.ts`): не запрошенный поток демон не читает и не отдаёт.
 */
export async function fetchStepOutput(options: {
  readonly address: string;
  readonly jobId: string;
  readonly stepId: string;
  readonly attempt?: number;
  readonly stdoutOffset?: number;
  readonly stderrOffset?: number;
}): Promise<StepOutputResult> {
  const query = new URLSearchParams({
    run: options.address,
    job: options.jobId,
    step: options.stepId,
  });
  if (options.attempt !== undefined) query.set('attempt', String(options.attempt));
  if (options.stdoutOffset !== undefined) query.set('stdoutOffset', String(options.stdoutOffset));
  if (options.stderrOffset !== undefined) query.set('stderrOffset', String(options.stderrOffset));
  return json<StepOutputResult>(await fetch(`/api/step-output?${query.toString()}`));
}

export async function fetchPipelines(): Promise<PipelinesOverview> {
  return json<PipelinesOverview>(await fetch('/api/pipelines'));
}

/** Без `days` — весь период наблюдений. */
export async function fetchUsage(days?: number): Promise<UsageResult> {
  const query = days === undefined ? '' : `?days=${days}`;
  return json<UsageResult>(await fetch(`/api/usage${query}`));
}

export async function fetchSettings(): Promise<Settings> {
  return json<Settings>(await fetch('/api/settings'));
}

/**
 * Записать дефолты. Ответ — уже перечитанные настройки, а не эхо правки:
 * значение могло лечь не так, как выглядела правка (снятая модель уходит к
 * умолчанию бэкенда), и показывать надо то, что теперь в файле.
 */
export async function saveSettings(patch: SettingsPatch): Promise<Settings> {
  return json<Settings>(
    await fetch('/api/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    }),
  );
}

/**
 * Отбор прогонов к уборке. Ничего не удаляет: показывает, что удалится и
 * сколько места освободится, — удаление идёт отдельным запросом по списку
 * адресов, которые пользователь увидел здесь.
 */
export async function selectRuns(options: {
  readonly traits: readonly CleanupTrait[];
  readonly olderThan?: string;
  readonly project?: string;
}): Promise<RunSelection> {
  const query = new URLSearchParams();
  for (const trait of options.traits) query.append('trait', trait);
  if (options.olderThan !== undefined && options.olderThan !== '') {
    query.set('older-than', options.olderThan);
  }
  if (options.project !== undefined) query.set('project', options.project);
  return json<RunSelection>(await fetch(`/api/runs?${query.toString()}`));
}

export async function deleteRun(address: string): Promise<{ readonly removed: string }> {
  return json(await fetch(`/api/run?run=${encodeURIComponent(address)}`, { method: 'DELETE' }));
}

export async function deleteRuns(addresses: readonly string[]): Promise<RemovalSummary> {
  return json<RemovalSummary>(
    await fetch('/api/runs', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runs: addresses }),
    }),
  );
}
