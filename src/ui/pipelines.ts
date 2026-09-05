import { existsSync } from 'node:fs';
import { relative } from 'node:path';

import { listPipelineFiles } from '../core/project/pipelines.js';
import { listProjects } from '../core/journal/reader.js';
import { expandPipeline } from '../core/pipeline/expand.js';
import { isStepcastError, StepcastError } from '../core/errors.js';
import { describeSource } from '../core/config/merge.js';
import { resolveConfig, type Config } from '../core/config/resolve.js';
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
 * Слой, из которого пришла модель шага, — то же пятизвенное деление, что и
 * `ModelOrigin` раскрытия, но с именем файла на месте слоя `config`: витрина
 * уже держит на руках разрешение конфигурации показываемого проекта
 * (`provenance.get('defaults.model')`), и подписывать слой обязана она, а не
 * раскрытие — так провенанс не приходится тащить через `ExpandOptions`
 * (design.md, Решение 1).
 */
export type PipelineModelOrigin =
  | { readonly layer: 'step' }
  | { readonly layer: 'pipeline' }
  | { readonly layer: 'config'; readonly file: string }
  | { readonly layer: 'backend'; readonly backend: string }
  | { readonly layer: 'none' };

export interface PipelineStepView {
  readonly id: string;
  readonly kind: 'agent' | 'run';
  /** Агент шага: он и есть ответ на вопрос «чем это будет исполняться». */
  readonly agent?: string;
  /** Модель, которой шаг исполнится. Отсутствует у шага без модели ни на одном слое. */
  readonly model?: string;
  /** Слой, давший `model`, — только у агентских шагов. */
  readonly modelOrigin?: PipelineModelOrigin;
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
 * Место ошибки и подсказка доезжают до экрана наравне с текстом: CLI печатает
 * их отдельными строками, и витрина, показывая один только `message`,
 * оставляла бы пользователя без ответа на вопрос «где именно».
 */
function toFailure(error: unknown, projectPath: string): Failure {
  if (!isStepcastError(error)) return { error: (error as Error).message };
  // Путь файла — в том же виде, что `PipelineView.file`: абсолютный путь
  // машины демона на экране проекта ничего не добавляет.
  const file =
    error.file === undefined ? undefined : relative(projectPath, error.file).replace(/\\/g, '/');
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
  modelConfigFile: string | undefined,
): PipelineView {
  const file = relative(projectPath, absolute).replace(/\\/g, '/');
  try {
    const { pipeline, modelOrigins } = expandPipeline({ pipelinePath: absolute, config });
    return toView(projectKey, projectPath, file, pipeline, modelOrigins, modelConfigFile);
  } catch (error) {
    return errorView(projectKey, projectPath, file, toFailure(error, projectPath));
  }
}

/** `project`, `defaults` и `backends` того репозитория, чей пайплайн раскрывается. */
interface ProjectOverrides {
  readonly project: Config['project'];
  readonly defaults: Config['defaults'];
  readonly backends: Config['backends'];
  /** Файл, победивший в `defaults.model` этого проекта — для слоя `config` на карточке шага. */
  readonly modelConfigFile: string | undefined;
}

/**
 * `project`, `defaults` и `backends` того репозитория, чей пайплайн раскрывается.
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
 */
function projectSection(projectPath: string, home: string | undefined): ProjectOverrides {
  const resolved = resolveConfig({ cwd: projectPath, ...(home === undefined ? {} : { home }) });
  const source = resolved.provenance.get('defaults.model');
  return {
    project: resolved.config.project,
    defaults: resolved.config.defaults,
    backends: resolved.config.backends,
    modelConfigFile: source === undefined ? undefined : describeSource(source),
  };
}

export interface BuildPipelinesOptions {
  /** Домашний каталог: из него читается глобальный слой конфигурации проекта. */
  readonly home?: string;
  readonly now?: Date;
}

export function buildPipelines(
  runsRoot: string,
  config: Config,
  options: BuildPipelinesOptions = {},
): PipelinesOverview {
  const pipelines: PipelineView[] = [];

  for (const project of listProjects(runsRoot)) {
    // Проект, чей путь неизвестен, обходить негде: в указателе его нет.
    if (project.path === undefined || !existsSync(project.path)) continue;
    const files = listPipelineFiles(project.path);
    if (files.length === 0) continue;

    // Нечитаемая конфигурация проекта показывается так же, как неразбираемый
    // пайплайн: с объяснением. Молча раскрыть его чужой конфигурацией значило
    // бы показать устройство, которого у прогона в этом проекте не будет.
    let forProject: Config | undefined;
    let modelConfigFile: string | undefined;
    let failure: Failure | undefined;
    try {
      const overrides = projectSection(project.path, options.home);
      forProject = {
        ...config,
        project: overrides.project,
        defaults: overrides.defaults,
        backends: overrides.backends,
      };
      modelConfigFile = overrides.modelConfigFile;
    } catch (error) {
      failure = toFailure(error, project.path);
    }

    for (const file of files) {
      pipelines.push(
        failure !== undefined || forProject === undefined
          ? errorView(
              project.key,
              project.path,
              relative(project.path, file).replace(/\\/g, '/'),
              failure ?? { error: 'Конфигурация проекта не читается' },
            )
          : readPipeline(project.key, project.path, file, forProject, modelConfigFile),
      );
    }
  }

  return { pipelines, generatedAt: (options.now ?? new Date()).toISOString() };
}
