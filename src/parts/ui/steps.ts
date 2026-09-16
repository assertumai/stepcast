import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

import { listProjects } from '../pipeline/run/journal/reader.js';
import { findPackageRoot } from '../pipeline/domain/package-schema.js';
import { StepManifestSchema } from '../pipeline/document/schema.js';
import { describeSchemaFailure } from '../../kernel/schema-failure.js';

/**
 * Каталог переиспособных шагов для экрана «Шаги» (design.md изменения
 * reusable-steps, решение 13).
 *
 * Собирается теми же тремя слоями, какими имя `uses` разрешает раскрытие
 * (`src/parts/pipeline/document/steps.ts`), но не через них: раскрытию нужно одно имя,
 * витрине — весь список каталогов слоя, включая те, что перекрыты. Дублирует
 * само перечисление директорий, а не разбор одного манифеста — та часть,
 * которая приводит манифест к модели шага (`StepManifestSchema`,
 * `describeSchemaFailure`), общая с движком.
 */

export type StepLayerName = 'project' | 'home' | 'builtin';

export interface StepParamView {
  readonly name: string;
  readonly type?: string;
  readonly required: boolean;
  readonly default?: unknown;
  readonly description?: string;
}

export interface StepCatalogEntry {
  readonly name: string;
  readonly layer: StepLayerName;
  readonly manifestPath: string;
  readonly description?: string;
  readonly params: readonly StepParamView[];
  readonly hasOutputSchema: boolean;
  /** Шаг того же имени уже нашёлся в слое с более высоким приоритетом. */
  readonly overridden: boolean;
  /** Манифест не читается либо не проходит схему — причина, а не молчаливый пропуск. */
  readonly error?: string;
}

export interface ProjectStepsView {
  readonly projectKey: string;
  readonly projectPath: string;
  readonly steps: readonly StepCatalogEntry[];
}

export interface StepsOverview {
  readonly projects: readonly ProjectStepsView[];
  readonly generatedAt: string;
}

const LAYERS: readonly StepLayerName[] = ['project', 'home', 'builtin'];

function layerDir(layer: StepLayerName, projectPath: string, home: string): string {
  if (layer === 'project') return join(projectPath, '.stepcast', 'steps');
  if (layer === 'home') return join(home, '.stepcast', 'steps');
  return join(findPackageRoot(fileURLToPath(new URL('.', import.meta.url))), 'src', 'builtin', 'steps');
}

/** Каталоги слоя, несущие манифест. Каталог без `step.yml` — не каталог шага (design.md, решение 3). */
function listStepDirNames(dir: string): readonly string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(dir, entry.name, 'step.yml')))
    .map((entry) => entry.name)
    .sort();
}

/**
 * Подписи полей из JSON Schema свойств — общий вывод для каталога
 * переиспользуемых шагов и для карточки шага плагинного вида (`ui/pipelines.ts`,
 * design.md изменения `step-kinds-registry`, решение 11): второй копии
 * этого разбора в репозитории нет.
 */
export function paramViews(paramsSchema: Record<string, unknown> | undefined): readonly StepParamView[] {
  if (paramsSchema === undefined) return [];
  const properties = (paramsSchema.properties as Record<string, Record<string, unknown>> | undefined) ?? {};
  const required = (paramsSchema.required as readonly string[] | undefined) ?? [];
  return Object.entries(properties).map(([name, schema]) => ({
    name,
    ...(typeof schema.type === 'string' ? { type: schema.type } : {}),
    required: required.includes(name),
    ...('default' in schema ? { default: schema.default } : {}),
    ...(typeof schema.description === 'string' ? { description: schema.description } : {}),
  }));
}

function readManifestEntry(
  name: string,
  layer: StepLayerName,
  dir: string,
  overridden: boolean,
): StepCatalogEntry {
  const manifestPath = join(dir, name, 'step.yml');
  const base = { name, layer, manifestPath, params: [], hasOutputSchema: false, overridden };

  let text: string;
  try {
    text = readFileSync(manifestPath, 'utf8');
  } catch (error) {
    return { ...base, error: `не удалось прочитать файл: ${(error as Error).message}` };
  }

  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (error) {
    return { ...base, error: `документ не разбирается как YAML: ${(error as Error).message}` };
  }

  const parsed = StepManifestSchema.safeParse(raw);
  if (!parsed.success) {
    const failure = describeSchemaFailure(parsed.error);
    return { ...base, error: failure.at === undefined ? failure.message : `${failure.at}: ${failure.message}` };
  }

  const doc = parsed.data;
  if (doc.name !== name) {
    return { ...base, error: `манифест объявляет name: ${doc.name}, а каталог называется ${name}` };
  }

  return {
    ...base,
    description: doc.description,
    params: paramViews(doc.params as Record<string, unknown> | undefined),
    hasOutputSchema: doc.output_schema !== undefined,
  };
}

/** Каталог шагов одного проекта: три слоя, перекрытые не пропущены (design.md, решение 13). */
export function buildProjectSteps(projectPath: string, home: string): readonly StepCatalogEntry[] {
  const seen = new Set<string>();
  const entries: StepCatalogEntry[] = [];
  for (const layer of LAYERS) {
    const dir = layerDir(layer, projectPath, home);
    for (const name of listStepDirNames(dir)) {
      entries.push(readManifestEntry(name, layer, dir, seen.has(name)));
      seen.add(name);
    }
  }
  return entries;
}

export interface BuildStepsOptions {
  readonly home?: string;
}

/** Каталоги шагов всех проектов, известных корню прогонов, — тем же обходом, что и `buildPipelines`. */
export function buildSteps(runsRoot: string, options: BuildStepsOptions = {}): StepsOverview {
  const home = options.home ?? homedir();
  const projects: ProjectStepsView[] = [];
  for (const project of listProjects(runsRoot)) {
    if (project.path === undefined || !existsSync(project.path)) continue;
    projects.push({
      projectKey: project.key,
      projectPath: project.path,
      steps: buildProjectSteps(project.path, home),
    });
  }
  return { projects, generatedAt: new Date().toISOString() };
}
