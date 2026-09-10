import { existsSync } from 'node:fs';
import { relative } from 'node:path';

import { listPipelineFiles } from '../core/project/pipelines.js';
import { listProjects } from '../core/journal/reader.js';
import { expandPipeline } from '../core/pipeline/expand.js';
import { isStepcastError, StepcastError } from '../core/errors.js';
import { describeSource } from '../core/config/merge.js';
import { resolveConfig, type Config } from '../core/config/resolve.js';
import { pluginDeclarations, type PluginDeclaration } from '../core/plugins/load.js';
import { resolveWithPlugins } from '../core/plugins/resolve.js';
import type { Registry } from '../core/plugins/registry.js';
import type { Job, ModelOrigin, Pipeline } from '../core/pipeline/model.js';
import { layoutJobs, type JobGraph } from './graph.js';

/**
 * Пайплайны проектов, известных корню прогонов.
 *
 * «Загруженных» пайплайнов у демона нет и быть не может: пайплайн — это файл,
 * который передают команде `run`, а не запись в реестре. Поэтому список
 * собирается обходом корней проектов из `projects.json` — тех самых, чьи
 * прогоны витрина и показывает.
 *
 * Сам обход файлов живёт в `src/core/project/pipelines.ts`: планировщик
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
  readonly kind: 'agent' | 'run' | 'script';
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
  readonly graph?: JobGraph;
  /**
   * Пайплайн не разбирается. Как и нечитаемый прогон в обзоре, он остаётся
   * видимым с объяснением: молча пропущенный файл выглядел бы как его
   * отсутствие, а это разные вещи.
   *
   * Место ошибки и подсказка идут соседними полями, а не приклеены к тексту:
   * склеенную строку экран не может ни выделить, ни показать иначе, чем
   * прочий текст, — а карточка заводится именно ради объяснения. Поля
   * плоские, потому что `error` склейка прогонов (`src/ui/grouping.ts`)
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
    })),
  };
}

function toView(
  projectKey: string,
  projectPath: string,
  file: string,
  pipeline: Pipeline,
  modelOrigins: ReadonlyMap<string, ModelOrigin>,
  modelConfigFile: string | undefined,
): PipelineView {
  const jobs = pipeline.jobs.map((job) => toJobView(job, modelOrigins, modelConfigFile));
  return {
    projectKey,
    projectPath,
    file,
    name: pipeline.name,
    concurrency: pipeline.concurrency,
    failFast: pipeline.failFast,
    jobs,
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
  return { projectKey, projectPath, file, name: file, jobs: [], ...failure };
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
    return toView(projectKey, projectPath, file, pipeline, modelOrigins, modelConfigFile);
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

/** Список объявлений плагинов совпал: тот же спецификатор и тот же файл, в том же порядке. */
function declarationsEqual(a: readonly PluginDeclaration[], b: readonly PluginDeclaration[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((item, i) => item.spec === b[i]?.spec && item.declaredIn === b[i]?.declaredIn);
}

interface RegistryCacheEntry {
  readonly declarations: readonly PluginDeclaration[];
  readonly registry: Registry;
}

/**
 * Реестры вкладов, собранные по корню проекта, — переживают отдельный запрос
 * (design.md, Решение 3). Ключ — сам корень проекта; совпадение записи
 * проверяется списком объявлений плагинов проекта (спецификатор и файл
 * объявления, в порядке объявления), а не временем правки файлов
 * конфигурации: правка соседнего ключа не обязана сбрасывать реестр, а два
 * разных содержимого с одной меткой времени неразличимы.
 *
 * Не модульный синглтон: тесты поднимают несколько демонов в одном процессе,
 * и общий кеш связал бы их между собой. Экземпляр создаёт `createUiServer` и
 * передаёт `buildPipelines` опцией; он умирает вместе с демоном.
 */
export type RegistryCache = Map<string, RegistryCacheEntry>;

export function createRegistryCache(): RegistryCache {
  return new Map();
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
  registryCache: RegistryCache | undefined,
): Promise<ProjectOverrides> {
  const options = { cwd: projectPath, ...(home === undefined ? {} : { home }) };

  // Отдельное разрешение нужно ровно для одного: сверить ключ кеша с записью,
  // которая уже есть. Записи нет — сверять не с чем, и лишнего чтения слоёв
  // не делается: промах всё равно ведёт к полной сборке, а объявления для
  // записи в кеш видны и во втором проходе (слой умолчаний плагинов вносит
  // `backends`, а не `plugins`).
  const cached = registryCache?.get(projectPath);
  const declared = cached === undefined ? undefined : pluginDeclarations(resolveConfig(options));
  const cachedRegistry =
    cached !== undefined && declared !== undefined && declarationsEqual(cached.declarations, declared)
      ? cached.registry
      : undefined;

  const { resolved, registry } = await resolveWithPlugins(
    options,
    cachedRegistry === undefined
      ? { projectRoot: projectPath }
      : { projectRoot: projectPath, registry: cachedRegistry },
  );

  // Кешируется только успешно собранный реестр: если строка выше не бросила,
  // отказа загрузки не было. Совпавшая запись не перезаписывается — иначе
  // объект реестра на каждый запрос был бы новым, хотя и с тем же содержимым.
  if (cachedRegistry === undefined) {
    registryCache?.set(projectPath, {
      declarations: declared ?? pluginDeclarations(resolved),
      registry,
    });
  }

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
   * Реестры вкладов по корню проекта, живущие дольше одного вызова. Без
   * него — например, в прямых вызовах тестов — каждый обход собирает реестр
   * заново, как и раньше.
   */
  readonly registryCache?: RegistryCache;
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
      const overrides = await projectSection(project.path, options.home, options.registryCache);
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
