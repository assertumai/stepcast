import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import { listProjects } from '../core/journal/reader.js';
import { expandPipeline } from '../core/pipeline/expand.js';
import { isStepcastError } from '../core/errors.js';
import type { Config } from '../core/config/resolve.js';
import type { Job, Pipeline } from '../core/pipeline/model.js';
import { layoutJobs, type JobGraph } from './graph.js';

/**
 * Пайплайны проектов, известных корню прогонов.
 *
 * «Загруженных» пайплайнов у демона нет и быть не может: пайплайн — это файл,
 * который передают команде `run`, а не запись в реестре. Поэтому список
 * собирается обходом корней проектов из `projects.json` — тех самых, чьи
 * прогоны витрина и показывает.
 *
 * Обход намеренно мелкий: корневой `stepcast.yml` и `.stepcast/pipelines/*.yml`
 * — раскладка, которую заводит `stepcast init` и которой держится сам проект.
 * Полный обход дерева проекта стоил бы дорого и находил бы чужие YAML.
 */

/** Каталог пайплайнов проекта относительно его корня. */
const PIPELINE_DIR = join('.stepcast', 'pipelines');

export interface PipelineStepView {
  readonly id: string;
  readonly kind: 'agent' | 'run';
  /** Агент шага: он и есть ответ на вопрос «чем это будет исполняться». */
  readonly agent?: string;
  /** Модель шага. Пусто — действует модель бэкенда или дефолт конфигурации. */
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
   */
  readonly error?: string;
}

export interface PipelinesOverview {
  readonly pipelines: readonly PipelineView[];
  readonly generatedAt: string;
}

/** Файлы-кандидаты проекта, в порядке от корневого к каталогу пайплайнов. */
function candidates(projectPath: string): string[] {
  const out: string[] = [];
  const root = join(projectPath, 'stepcast.yml');
  if (existsSync(root)) out.push(root);

  const dir = join(projectPath, PIPELINE_DIR);
  try {
    for (const name of readdirSync(dir).sort()) {
      if (name.endsWith('.yml') || name.endsWith('.yaml')) out.push(join(dir, name));
    }
  } catch {
    // Каталога пайплайнов у проекта может не быть — это не ошибка.
  }
  return out;
}

/** Пайплайн ли это. Определение работы лежит в таком же `.yml` и им не является. */
function isPipelineFile(path: string): boolean {
  try {
    // Достаточно шапки: `kind` объявляется в первых строках документа.
    return /^kind:\s*pipeline\s*$/m.test(readFileSync(path, 'utf8').slice(0, 4096));
  } catch {
    return false;
  }
}

function toJobView(job: Job): PipelineJobView {
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
      ...(step.kind === 'run'
        ? { command: Array.isArray(step.command) ? step.command.join(' ') : String(step.command) }
        : {}),
    })),
  };
}

function toView(projectKey: string, projectPath: string, file: string, pipeline: Pipeline): PipelineView {
  const jobs = pipeline.jobs.map(toJobView);
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

function readPipeline(
  projectKey: string,
  projectPath: string,
  absolute: string,
  config: Config,
): PipelineView {
  const file = relative(projectPath, absolute).replace(/\\/g, '/');
  try {
    const { pipeline } = expandPipeline({ pipelinePath: absolute, config });
    return toView(projectKey, projectPath, file, pipeline);
  } catch (error) {
    const message = isStepcastError(error) ? error.message : (error as Error).message;
    return {
      projectKey,
      projectPath,
      file,
      // Имя берётся из файла: раскрытие до `name` не дошло.
      name: file,
      jobs: [],
      error: message,
    };
  }
}

export function buildPipelines(
  runsRoot: string,
  config: Config,
  now: Date = new Date(),
): PipelinesOverview {
  const pipelines: PipelineView[] = [];

  for (const project of listProjects(runsRoot)) {
    // Проект, чей путь неизвестен, обходить негде: в указателе его нет.
    if (project.path === undefined || !existsSync(project.path)) continue;
    for (const file of candidates(project.path)) {
      if (!isPipelineFile(file)) continue;
      pipelines.push(readPipeline(project.key, project.path, file, config));
    }
  }

  return { pipelines, generatedAt: now.toISOString() };
}
