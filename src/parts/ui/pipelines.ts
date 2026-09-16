import { existsSync } from 'node:fs';
import { relative } from 'node:path';

import { listPipelineFiles } from '../pipeline/domain/project/pipelines.js';
import { listProjects } from '../pipeline/run/journal/reader.js';
import { expandPipeline } from '../pipeline/document/expand.js';
import { isStepcastError, StepcastError } from '../../kernel/errors.js';
import { describeSource } from '../pipeline/config/merge.js';
import { resolveConfig, type Config, type ResolveOptions } from '../pipeline/config/resolve.js';
import { resolveWithPlugins, type ResolvedWithPlugins } from '../resolve.js';
import type { BuiltinRow, LoadOptions } from '../../kernel/load.js';
import type { Kernel } from '../../kernel/kernel.js';
import { kernelFromRegistry, registryFromKernel, type Registry } from '../../kernel/registry.js';
import type { TreeRow } from '../../kernel/tree/tree.js';
import type { Job, ModelOrigin, Pipeline } from '../pipeline/document/model.js';
import { hasStepExecutor } from '../pipeline/contract.js';
import { layoutJobs, type JobGraph } from './graph.js';
import { paramViews, type StepParamView } from './steps.js';

/**
 * Пайплайны проектов, известных корню прогонов.
 *
 * «Загруженных» пайплайнов у демона нет и быть не может: пайплайн — это файл,
 * который передают команде `run`, а не запись в реестре. Поэтому список
 * собирается обходом корней проектов из `projects.json` — тех самых, чьи
 * прогоны витрина и показывает.
 *
 * Сам обход файлов живёт в `src/parts/pipeline/domain/project/pipelines.ts`: планировщик
 * расписания ищет те же файлы тем же правилом, и держать это правило в двух
 * местах значило бы дать им разойтись.
 */

/**
 * Слой, из которого пришла модель шага, — то же деление, что и
 * `ModelOrigin` раскрытия, но с именем файла на месте слоя `config`: витрина
 * уже держит на руках разрешение конфигурации показываемого проекта
 * (`provenance.get('defaults.model')`), и подписывать слой обязана она, а не
 * раскрытие — так провенанс не приходится тащить через `ExpandOptions`
 * (design.md, Решение 1).
 */
export type PipelineModelOrigin =
  | { readonly layer: 'step' }
  | { readonly layer: 'job' }
  | { readonly layer: 'tier'; readonly backend: string; readonly tier: string; readonly tierLayer: 'pipeline' | 'job' | 'step'; readonly fallback?: true }
  | { readonly layer: 'pipeline' }
  | { readonly layer: 'config'; readonly file: string }
  | { readonly layer: 'backend'; readonly backend: string }
  | { readonly layer: 'none' };

export interface PipelineStepView {
  readonly id: string;
  readonly kind: 'agent' | 'run' | 'script' | 'plugin';
  /** Агент шага: он и есть ответ на вопрос «чем это будет исполняться». */
  readonly agent?: string;
  /** Модель, которой шаг исполнится. Отсутствует у шага без модели ни на одном слое. */
  readonly model?: string;
  /** Слой, давший `model`, — только у агентских шагов. */
  readonly modelOrigin?: PipelineModelOrigin;
  readonly command?: string;
  /** Путь скрипта, объявленный в документе, — у шага script. */
  readonly scriptPath?: string;
  /** Имя раннера, которым скрипт исполнится, — только у разрешённого шага. */
  readonly scriptRunner?: string;
  /** Объявлен ли вход контракта (`input`) — сам вход в карточку не идёт: он может быть велик. */
  readonly hasScriptInput?: boolean;
  /** Путь объявленной схемы выхода — тем же полем, что и у `run`/`agent`, но у script означает проверку файла, а не разбор stdout. */
  readonly scriptOutputSchemaPath?: string;
  /**
   * Имя переиспользуемого шага и слой, из которого разрешён его манифест, —
   * у script, собранного из `uses`. Имя занимает место пути на карточке: путь
   * в чужой `node_modules` не говорит читателю ничего (design.md изменения
   * reusable-steps, решение 13).
   */
  readonly usesName?: string;
  readonly usesLayer?: 'project' | 'home' | 'builtin';
  /** Переданные параметры вызова — со сведёнными умолчаниями. */
  readonly usesParams?: Readonly<Record<string, unknown>>;
  /** Имя вида шага плагинного вида — оно же ключ шага в документе. */
  readonly pluginKindName?: string;
  /** Название вклада для витрины — из реестра, когда вид известен. */
  readonly pluginKindTitle?: string;
  /** Поля с подписями из схемы вклада (design.md, решение 11). */
  readonly pluginFields?: readonly StepParamView[];
  /** Вклад объявляет схему `output` — структурированный выход у шага есть. */
  readonly pluginHasOutput?: boolean;
  /**
   * Действующий реестр не знает этого вида (плагин снят, прогон читается без
   * него): поля берутся из замка как есть, а не из схемы, и причина названа —
   * не пустая карточка и не «неизвестно» (design.md, решение 11).
   */
  readonly pluginUnknownReason?: string;
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
  /** Путь файла относительно корня проекта: он же адрес для `stepcast run`. */
  readonly file: string;
  readonly name: string;
  readonly concurrency?: number;
  readonly failFast?: boolean;
  readonly jobs: readonly PipelineJobView[];
  /**
   * Имена объявленных входов пайплайна (`inputs`), в порядке объявления.
   *
   * Нужны доске: она запускает пайплайн «для этой работы» и обязана знать, кому
   * слаг пункта вообще есть куда передать. Пайплайн без входа `item` в диалоге
   * выбора не предлагается — запуск, который молча потерял бы выбранный пункт,
   * хуже отсутствия кнопки.
   *
   * Значения не публикуются намеренно: умолчание входа — часть документа
   * пайплайна, а не состояние, за которым витрине стоит следить.
   */
  readonly inputs: readonly string[];
  readonly graph?: JobGraph;
  /**
   * Пайплайн не разбирается. Как и нечитаемый прогон в обзоре, он остаётся
   * видимым с объяснением: молча пропущенный файл выглядел бы как его
   * отсутствие, а это разные вещи.
   *
   * Место ошибки и подсказка идут соседними полями, а не приклеены к тексту:
   * склеенную строку экран не может ни выделить, ни показать иначе, чем
   * прочий текст, — а карточка заводится именно ради объяснения. Поля
   * плоские, потому что `error` склейка прогонов (`src/parts/ui/grouping.ts`)
   * читает как признак «файл не разбирается».
   */
  readonly error?: string;
  /**
   * Файл, к которому относится ошибка, относительно корня проекта. Он не
   * всегда совпадает с файлом пайплайна: ошибка приходит и из файла работы,
   * подключённой по `uses`.
   *
   * Файл вне корня проекта — глобальный `~/.stepcast/config.yml`, объявивший
   * плагин, — назван абсолютным путём: он и не принадлежит проекту, а цепочка
   * `../../..` от его корня не отвечает на вопрос «какой файл править».
   * Абсолютным именем тот же экран уже называет файл слоя `config` на
   * карточке шага.
   */
  readonly errorFile?: string;
  /** Место ошибки внутри документа, например `jobs.propose-a`. */
  readonly errorAt?: string;
  /** Что делать пользователю — та же подсказка, что печатает CLI. */
  readonly errorHint?: string;
}

export interface PipelinesOverview {
  readonly pipelines: readonly PipelineView[];
  readonly generatedAt: string;
}

/**
 * Слой раскрытия в форму витрины: слой `config` получает файл, победивший в
 * этом проекте.
 *
 * Оба отсутствия здесь — не граничный случай показа, а расхождение внутри
 * демона: раскрытие заводит запись каждому агентскому шагу, а слой `config`
 * означает, что `defaults.model` кем-то задан, — значит, у провенанса есть
 * источник. Подставить на этом месте «модель не задана» значило бы показать
 * противоречивую пару: значение модели рядом со словами о её отсутствии.
 * Поэтому пайплайн уходит в карточку с объяснением — тем же путём, каким
 * показывается любой неразобранный.
 */
function toModelOriginView(
  origin: ModelOrigin | undefined,
  modelConfigFile: string | undefined,
  at: string,
): PipelineModelOrigin {
  const hint = 'Это расхождение внутри демона: перезапустите `stepcast up` и сообщите о нём';
  if (origin === undefined) {
    throw new StepcastError('Раскрытие не назвало слой, давший модель шага', { at, hint });
  }
  if (origin.layer !== 'config') return origin;
  if (modelConfigFile === undefined) {
    throw new StepcastError('Модель шага пришла из настроек, но файл, задавший её, не известен', {
      at,
      hint,
    });
  }
  return { layer: 'config', file: modelConfigFile };
}

function toJobView(
  job: Job,
  modelOrigins: ReadonlyMap<string, ModelOrigin>,
  modelConfigFile: string | undefined,
  registry: Registry,
): PipelineJobView {
  return {
    id: job.id,
    ...(job.description === undefined ? {} : { description: job.description }),
    needs: job.needs === 'all' ? ['all'] : job.needs,
    on: job.on,
    ...(job.if === undefined ? {} : { if: job.if }),
    publishesOutput: job.output !== undefined,
    steps: job.steps.map((step) => ({
      id: step.id,
      kind: step.kind,
      ...(step.kind === 'agent' ? { agent: step.agent } : {}),
      ...(step.kind === 'agent' && step.model !== undefined ? { model: step.model } : {}),
      ...(step.kind === 'agent'
        ? {
            modelOrigin: toModelOriginView(
              modelOrigins.get(`${job.id}/${step.id}`),
              modelConfigFile,
              `jobs.${job.id}.steps.${step.id}`,
            ),
          }
        : {}),
      ...(step.kind === 'run'
        ? { command: Array.isArray(step.command) ? step.command.join(' ') : String(step.command) }
        : {}),
      ...(step.kind === 'script' ? { scriptPath: step.path } : {}),
      ...(step.kind === 'script' && step.resolved !== undefined
        ? { scriptRunner: step.resolved.runner }
        : {}),
      ...(step.kind === 'script' ? { hasScriptInput: step.input !== undefined } : {}),
      ...(step.kind === 'script' && step.outputSchemaPath !== undefined
        ? { scriptOutputSchemaPath: step.outputSchemaPath }
        : {}),
      ...(step.kind === 'script' && step.uses !== undefined ? { usesName: step.uses.name } : {}),
      ...(step.kind === 'script' && step.uses?.layer !== undefined ? { usesLayer: step.uses.layer } : {}),
      ...(step.kind === 'script' && step.uses?.params !== undefined ? { usesParams: step.uses.params } : {}),
      ...(step.kind === 'plugin' ? pluginStepView(step, registry) : {}),
    })),
  };
}

/**
 * Карточка шага плагинного вида — из действующего реестра (design.md, решение
 * 11): название вклада, поля с подписями из схемы (`ui/steps.ts:paramViews`,
 * тот же вывод, каким строятся параметры манифеста переиспользуемого шага),
 * признак структурированного выхода. Вид, которого реестр не знает (плагин
 * снят), показывается именем вида и полями из замка — с названной причиной, а
 * не пустой карточкой.
 */
function pluginStepView(
  step: Extract<Job['steps'][number], { kind: 'plugin' }>,
  registry: Registry,
): Pick<
  PipelineStepView,
  'pluginKindName' | 'pluginKindTitle' | 'pluginFields' | 'pluginHasOutput' | 'pluginUnknownReason'
> {
  const contribution = registry.steps.get(step.name);
  if (contribution === undefined || !hasStepExecutor(contribution)) {
    return {
      pluginKindName: step.name,
      pluginUnknownReason: `вид шага ${step.name} действующему реестру неизвестен`,
    };
  }
  return {
    pluginKindName: step.name,
    pluginKindTitle: contribution.title,
    pluginFields: paramViews(contribution.fields as Record<string, unknown>),
    pluginHasOutput: contribution.output !== undefined,
  };
}

function toView(
  projectKey: string,
  projectPath: string,
  file: string,
  pipeline: Pipeline,
  modelOrigins: ReadonlyMap<string, ModelOrigin>,
  modelConfigFile: string | undefined,
  registry: Registry,
): PipelineView {
  const jobs = pipeline.jobs.map((job) => toJobView(job, modelOrigins, modelConfigFile, registry));
  return {
    projectKey,
    projectPath,
    file,
    name: pipeline.name,
    concurrency: pipeline.concurrency,
    failFast: pipeline.failFast,
    jobs,
    // Ключи раскрытых входов — это и есть объявленные имена: раскрытие
    // подставляет умолчания объявленным и ничего не добавляет от себя.
    inputs: Object.keys(pipeline.inputs),
    graph: layoutJobs(
      jobs.map((job) => ({
        id: job.id,
        needs: job.needs,
        on: job.on,
        ...(job.if === undefined ? {} : { if: job.if }),
      })),
    ),
  };
}

/** Отказ разбора в полях карточки: место и подсказка — половина объяснения. */
interface Failure {
  readonly error: string;
  readonly errorFile?: string;
  readonly errorAt?: string;
  readonly errorHint?: string;
}

/**
 * Имя файла ошибки для карточки: внутри проекта — путь от его корня, в том же
 * виде, что `PipelineView.file` (абсолютный путь машины демона на экране
 * проекта ничего не добавляет); вне проекта — сам абсолютный путь.
 *
 * Вне корня проекта файл оказывается не по недосмотру: плагин вправе быть
 * объявлен глобальным `~/.stepcast/config.yml`, и его отказ показывается
 * карточками проекта. Относительное имя вышло бы цепочкой `../../..` до
 * домашнего каталога — путём, который ни на что не указывает и вдобавок врёт
 * про принадлежность файла проекту.
 */
function errorFileName(projectPath: string, file: string): string {
  const inside = relative(projectPath, file).replace(/\\/g, '/');
  return inside === '..' || inside.startsWith('../') ? file : inside;
}

/**
 * Место ошибки и подсказка доезжают до экрана наравне с текстом: CLI печатает
 * их отдельными строками, и витрина, показывая один только `message`,
 * оставляла бы пользователя без ответа на вопрос «где именно».
 */
function toFailure(error: unknown, projectPath: string): Failure {
  if (!isStepcastError(error)) return { error: (error as Error).message };
  const file = error.file === undefined ? undefined : errorFileName(projectPath, error.file);
  return {
    error: error.message,
    ...(file === undefined || file === '' ? {} : { errorFile: file }),
    ...(error.at === undefined ? {} : { errorAt: error.at }),
    ...(error.hint === undefined ? {} : { errorHint: error.hint }),
  };
}

/** Карточка с объяснением вместо устройства: имя берётся из файла, раскрытие до `name` не дошло. */
function errorView(
  projectKey: string,
  projectPath: string,
  file: string,
  failure: Failure,
): PipelineView {
  return { projectKey, projectPath, file, name: file, jobs: [], inputs: [], ...failure };
}

function readPipeline(
  projectKey: string,
  projectPath: string,
  absolute: string,
  config: Config,
  registry: Registry,
  modelConfigFile: string | undefined,
): PipelineView {
  const file = relative(projectPath, absolute).replace(/\\/g, '/');
  try {
    const { pipeline, modelOrigins } = expandPipeline({ pipelinePath: absolute, config, registry });
    return toView(projectKey, projectPath, file, pipeline, modelOrigins, modelConfigFile, registry);
  } catch (error) {
    return errorView(projectKey, projectPath, file, toFailure(error, projectPath));
  }
}

/** `project`, `defaults`, `backends` и реестр вкладов того репозитория, чей пайплайн раскрывается. */
interface ProjectOverrides {
  readonly project: Config['project'];
  readonly defaults: Config['defaults'];
  readonly backends: Config['backends'];
  /** Файл, победивший в `defaults.model` этого проекта — для слоя `config` на карточке шага. */
  readonly modelConfigFile: string | undefined;
  /**
   * Реестр вкладов этого проекта: без него плагинный предикат отклоняется
   * разбором как неизвестный ключ, а умолчание плагинного бэкенда не доезжает
   * до модели шага (design.md, Решение 2).
   */
  readonly registry: Registry;
}

/**
 * Слой-источник строки совпал: тот же вид, и для файла — тот же путь, для
 * каталога (`user-plugins`) — тот же каталог и тот же слой. Строка,
 * переехавшая между слоями (домашний каталог заменён проектным с тем же
 * `id`), несёт разный `layer` и потому строкой той же не считается.
 */
function sourceEqual(a: TreeRow['source'], b: TreeRow['source']): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'file') return b.kind === 'file' && a.path === b.path;
  if (a.kind === 'directory') return b.kind === 'directory' && a.dir === b.dir && a.layer === b.layer;
  return true;
}

/**
 * Дерево плагинов совпало: тот же `id`, тот же модуль, тот же признак
 * включённости, тот же слой-источник, в том же порядке (`plugin-tree`,
 * design.md, Решение 10).
 *
 * Слой-источник входит в сравнение наравне с модулем: относительный `use`
 * разрешается от файла, объявившего строку (`resolveModulePath`), и строка,
 * перекочевавшая с тем же `./x.mjs` из домашнего патча в проектный, называет
 * уже другой файл на диске. Ядро, удержанное по «равному» дереву, держало бы
 * модуль прежнего каталога (`ui-daemon`: правка любого файла, участвующего в
 * сборке дерева, действует со следующего запроса).
 */
export function treeEqual(a: readonly TreeRow[], b: readonly TreeRow[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((row, i) => {
    const other = b[i];
    return (
      other !== undefined &&
      row.id === other.id &&
      row.use === other.use &&
      row.enabled === other.enabled &&
      sourceEqual(row.source, other.source)
    );
  });
}

export interface KernelCacheEntry {
  readonly tree: readonly TreeRow[];
  readonly kernel: Kernel;
}

/**
 * Ядра, поднятые по корню проекта, — переживают отдельный запрос (design.md,
 * Решение 3 и 6). Ключ — сам корень проекта; совпадение записи проверяется
 * деревом плагинов проекта (`id`, модуль, включённость, порядок —
 * `plugin-tree`), а не временем правки файлов конфигурации: правка соседнего
 * ключа не обязана сбрасывать ядро, а два разных содержимого с одной меткой
 * времени неразличимы.
 *
 * Отдельный корневой контекст на проект, а не форк общего корня: сервис,
 * заведённый плагином одного проекта, не виден другому и не конфликтует с
 * одноимённым — хранилище сервисов cordis принадлежит корню, а не области
 * (design.md, Решение 6).
 *
 * Не модульный синглтон: тесты поднимают несколько демонов в одном процессе,
 * и общий кеш связал бы их между собой. Экземпляр создаёт `createUiServer` и
 * передаёт `buildPipelines` опцией.
 *
 * Владение считается не по кешу, а по ядру: `raised` — ядра, поднятые именно
 * этим доступом к кешу. Сервер, получивший кеш снаружи, берёт к нему
 * собственный доступ (`shareKernelCache`) и при закрытии снимает ровно то, что
 * поднял сам, — записи, положенные хозяином кеша, остаются действующими. Кеш,
 * общий на два сервера, иначе оставлял бы текущими контексты, которых уже никто
 * не спросит (design.md, Решение 6, ui-daemon spec).
 */
export interface KernelCache {
  /** Записи по ключу — общие у всех, кто делит этот кеш. */
  readonly entries: Map<string, KernelCacheEntry>;
  /** Ядра, поднятые через этот доступ, — их и снимает его владелец. */
  readonly raised: Set<Kernel>;
  /** Журнал демона: отказ снятия записывается, а не валит процесс. */
  readonly log?: ((line: string) => void) | undefined;
}

export function createKernelCache(log?: (line: string) => void): KernelCache {
  return { entries: new Map(), raised: new Set(), log };
}

/** Доступ к чужому кешу: те же записи, свой счёт поднятого. */
export function shareKernelCache(cache: KernelCache, log?: (line: string) => void): KernelCache {
  return { entries: cache.entries, raised: new Set(), log: log ?? cache.log };
}

/**
 * Снять ядра, поднятые через этот доступ. Снятое ядро выбывает и из перечня
 * поднятого: повторный вызов — не двойное снятие.
 */
export async function disposeRaisedKernels(cache: KernelCache): Promise<void> {
  const raised = [...cache.raised];
  cache.raised.clear();
  await Promise.all(raised.map((kernel) => disposeKernel(kernel, cache)));
}

/**
 * Снятие ядра в демоне: отказ disposer'а какого-нибудь плагина — строка в
 * журнале, а не необработанное отклонение промиса, валящее долгоживущий
 * процесс.
 */
async function disposeKernel(kernel: Kernel, cache: KernelCache): Promise<void> {
  try {
    await kernel.dispose();
  } catch (error) {
    cache.log?.(`не удалось снять контекст плагинов: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Разрешить конфигурацию с плагинами, взяв ядро из кеша либо подняв заново,
 * если дерево плагинов разошлось с закешированным, — общий приём для реестра
 * каждого проекта (`projectSection`) и для собственного ядра демона
 * (`src/parts/ui/settings.ts`, `src/parts/ui/models.ts`, design.md Решение 6): ключ кеша
 * там — не корень проекта, а домашний каталог, но правило то же самое. Правка
 * `plugins.patch.yml` действует тем же путём, что и правка `plugins:` раньше
 * (`plugin-tree`, ui-daemon): дерево строится заново на каждый обход,
 * расхождение с закешированным снимает прежнее ядро и поднимает новое.
 *
 * Отдельное разрешение перед основным нужно ровно для одного: сверить ключ
 * кеша с записью, которая уже есть. Записи нет — сверять не с чем, и лишнего
 * чтения слоёв не делается: промах всё равно ведёт к полной сборке.
 *
 * `builtinRows` — строки поставки витрины (`ui-shell` и по строке на экран,
 * `src/parts/ui/rows.ts`): доезжают до обоих проходов разрешения — их `id`
 * встают в семя встроенного слоя (`ResolveOptions.builtinRows`), их фабрики
 * ищет загрузчик (`LoadOptions.builtinRows`) — и входят в ключ пригодности
 * удержанного ядра наравне с деревом, потому что сам список строк поставки
 * определяет форму встроенного слоя дерева, которое сравнивает `treeEqual`
 * (design.md, Решение 2, 6). Собственное ядро демона (`src/parts/ui/daemon/kernel.ts`)
 * передаёт их; `projectSection` — нет: строки витрины не должны появиться в
 * дереве, по которому раскрывается пайплайн проекта.
 *
 * `onDirectoryRow` (`LoadOptions`, design.md изменения `hot-swap-preserves-data`,
 * Решение 1) доходит до `loadPlugins` только тогда, когда дерево разошлось с
 * закешированным и сборка идёт заново: попадание в кеш ядра (дерево совпало)
 * `loadPlugins` не зовёт вовсе, и вклад вызывающего в этом случае не звучит —
 * `currentDaemonKernel` переживает это тем же приёмом, что и `outcomes`
 * (держит прежний собранный состав, а не считает его пустым).
 */
export async function resolveWithCachedKernel(
  key: string,
  options: ResolveOptions,
  projectRoot: string,
  cache: KernelCache | undefined,
  builtinRows: readonly BuiltinRow[] = [],
  onDirectoryRow?: LoadOptions['onDirectoryRow'],
): Promise<ResolvedWithPlugins> {
  const resolveOptions: ResolveOptions =
    builtinRows.length === 0 ? options : { ...options, builtinRows: builtinRows.map((row) => row.id) };
  const cached = cache?.entries.get(key);
  const tree = cached === undefined ? undefined : resolveConfig(resolveOptions).pluginTree;
  const cachedRegistry =
    cached !== undefined && tree !== undefined && treeEqual(cached.tree, tree)
      ? registryFromKernel(cached.kernel)
      : undefined;

  const result = await resolveWithPlugins(
    resolveOptions,
    cachedRegistry === undefined
      ? { projectRoot, builtinRows, ...(onDirectoryRow === undefined ? {} : { onDirectoryRow }) }
      : { projectRoot, registry: cachedRegistry },
  );

  // Кешируется только успешно собранный реестр: если строка выше не бросила,
  // отказа загрузки не было. Совпавшая запись не перезаписывается — иначе
  // объект реестра на каждый запрос был бы новым, хотя и с тем же содержимым.
  if (cachedRegistry === undefined && cache !== undefined) {
    // Дерево разошлось — или записи не было вовсе. Прежнее ядро, если оно
    // было, осталось не у дел: снимаем его сразу, а не откладываем до
    // `close()`, иначе оно текло бы всё время жизни демона (design.md, Риск 4).
    // Снимается оно независимо от того, кто его поднял: из кеша запись ушла, и
    // дотянуться до неё больше некому.
    if (cached !== undefined) {
      cache.raised.delete(cached.kernel);
      void disposeKernel(cached.kernel, cache);
    }
    const kernel = kernelFromRegistry(result.registry);
    cache.raised.add(kernel);
    cache.entries.set(key, {
      tree: tree ?? result.resolved.pluginTree,
      kernel,
    });
  }

  return result;
}

/**
 * `project`, `defaults`, `backends` и реестр вкладов того репозитория, чей
 * пайплайн раскрывается.
 *
 * Витрина смотрит на все проекты корня прогонов сразу, а конфигурация у неё
 * одна — резолвнутая по каталогу, из которого подняли `stepcast up`. Раньше
 * подмена ограничивалась секцией `project`: `defaults.model` и `backends`
 * влияли только на то, чем шаг исполнится, а не на то, разбирается ли
 * документ, — и разбор оставался верным при чужих умолчаниях. Теперь карточка
 * шага показывает эффективную модель, и то же самое `defaults.model`
 * демонского каталога стало значением, которое видит пользователь: проект со
 * своим `.stepcast/config.yml` обязан быть раскрыт своими умолчаниями, а не
 * чужими. Подмена не расширяется до конфигурации целиком: `runs.root`,
 * `ui.port` и `limits` не влияют на показ пайплайна, а витрина уже работает в
 * корне прогонов и с потолками, выбранными при старте демона (design.md,
 * Решение 2).
 *
 * Реестр берётся из `resolveWithPlugins`, а не из `loadPlugins` поверх уже
 * разрешённой конфигурации: умолчания плагинных бэкендов приносит именно
 * второй проход разрешения, и без него карточка шага показала бы верный
 * разбор документа, но неверную модель (design.md, Решение 2).
 * `builtinCommands` не передаётся: вклады команд витрине не нужны, их
 * диспетчеризует CLI.
 */
async function projectSection(
  projectPath: string,
  home: string | undefined,
  kernelCache: KernelCache | undefined,
): Promise<ProjectOverrides> {
  const options = { cwd: projectPath, ...(home === undefined ? {} : { home }) };
  const { resolved, registry } = await resolveWithCachedKernel(projectPath, options, projectPath, kernelCache);

  const source = resolved.provenance.get('defaults.model');
  return {
    project: resolved.config.project,
    defaults: resolved.config.defaults,
    backends: resolved.config.backends,
    modelConfigFile: source === undefined ? undefined : describeSource(source),
    registry,
  };
}

export interface BuildPipelinesOptions {
  /** Домашний каталог: из него читается глобальный слой конфигурации проекта. */
  readonly home?: string;
  readonly now?: Date;
  /**
   * Ядра по корню проекта, живущие дольше одного вызова. Без него —
   * например, в прямых вызовах тестов — каждый обход поднимает ядро заново,
   * как и раньше.
   */
  readonly kernelCache?: KernelCache;
}

export async function buildPipelines(
  runsRoot: string,
  config: Config,
  options: BuildPipelinesOptions = {},
): Promise<PipelinesOverview> {
  const pipelines: PipelineView[] = [];

  // Проекты обходятся последовательно, а не `Promise.all`: параллельный
  // импорт чужого кода плагинов не выигрывает после первого запроса (реестр
  // кешируется) и стоит недетерминированного порядка карточек (design.md,
  // Решение 5). Событийный цикл при этом не блокируется — обработчик
  // `/api/pipelines` асинхронен.
  for (const project of listProjects(runsRoot)) {
    // Проект, чей путь неизвестен, обходить негде: в указателе его нет.
    if (project.path === undefined || !existsSync(project.path)) continue;
    const files = listPipelineFiles(project.path);
    if (files.length === 0) continue;

    // Нечитаемая конфигурация и отказ загрузки плагина показываются одной
    // веткой: с объяснением. Молча раскрыть проект чужой конфигурацией или
    // пропустить плагин значило бы показать устройство, которого у прогона в
    // этом проекте не будет.
    let forProject: Config | undefined;
    let registry: Registry | undefined;
    let modelConfigFile: string | undefined;
    let failure: Failure | undefined;
    try {
      const overrides = await projectSection(project.path, options.home, options.kernelCache);
      forProject = {
        ...config,
        project: overrides.project,
        defaults: overrides.defaults,
        backends: overrides.backends,
      };
      registry = overrides.registry;
      modelConfigFile = overrides.modelConfigFile;
    } catch (error) {
      failure = toFailure(error, project.path);
    }

    for (const file of files) {
      pipelines.push(
        failure !== undefined || forProject === undefined || registry === undefined
          ? errorView(
              project.key,
              project.path,
              relative(project.path, file).replace(/\\/g, '/'),
              failure ?? { error: 'Конфигурация проекта не читается' },
            )
          : readPipeline(project.key, project.path, file, forProject, registry, modelConfigFile),
      );
    }
  }

  return { pipelines, generatedAt: (options.now ?? new Date()).toISOString() };
}
