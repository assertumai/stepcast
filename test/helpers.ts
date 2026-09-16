import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import assert from 'node:assert/strict';

import { resolveConfig, type Config } from '../src/core/config/resolve.js';
import { RunJournal } from '../src/core/journal/writer.js';
import type { RunManifest, RunStatus, StatusValue, UsageReport } from '../src/core/journal/schema.js';
import type { AgentStep, RunStep, ScriptStep, Step } from '../src/core/pipeline/model.js';
import { createKernel, type Kernel } from '../src/core/plugins/kernel.js';
import { row as pipelineRow } from '../src/parts/pipeline/row.js';
import { tempDir } from './tmp.js';

/**
 * Ядро с применённой строкой `pipeline` на корневой области (design.md
 * изменения `pipeline-owns-services`): голый `createKernel()` после переезда
 * служебных сервисов в строку заводит только `commands` — тестам, которым
 * нужны `ctx.backends`/`ctx.predicates`/`ctx.steps` без полного встроенного
 * дерева (`createBuiltinKernel`), нужен этот помощник вместо голого
 * `createKernel()`. `register` зовётся напрямую на корне, а не `apply`
 * (форма дерева): тем же синхронным приёмом, каким пользуется
 * `createBuiltinKernel`, — без него тест не смог бы обойтись без `await`, а
 * владелец вкладов, внесённых прямо на `kernel.ctx`, остался бы именем
 * строки, а не «встроенным».
 */
export function createPipelineKernel(): Kernel {
  const kernel = createKernel();
  pipelineRow.register(kernel.ctx);
  return kernel;
}

export interface Project {
  readonly root: string;
  readonly home: string;
  readonly config: Config;
  /** Записать файл по пути относительно корня проекта, вернуть абсолютный путь. */
  write(relativePath: string, content: string): string;
  path(relativePath: string): string;
}

/** Временный проект на диске: общий каркас для тестов раскрытия и линта. */
export function makeProject(files: Readonly<Record<string, string>> = {}): Project {
  const base = tempDir('project-');
  const root = join(base, 'work');
  const home = join(base, 'home');
  mkdirSync(root, { recursive: true });
  mkdirSync(join(home, '.stepcast'), { recursive: true });

  const project: Project = {
    root,
    home,
    config: resolveConfig({
      cwd: root,
      home,
      globalPath: join(home, '.stepcast', 'config.yml'),
      projectPath: join(root, '.stepcast', 'config.yml'),
    }).config,
    write(relativePath, content) {
      const full = join(root, relativePath);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content);
      return full;
    },
    path(relativePath) {
      return join(root, relativePath);
    },
  };

  for (const [name, content] of Object.entries(files)) project.write(name, content);
  return project;
}

/**
 * Репозиторий git во временном каталоге: одна копия на все тесты, которым
 * нужны настоящие якоря, наложение или сведение дорожек. Имя и почта задаются
 * прямо в репозитории — глобальной настройки git у гоняющего тесты может не
 * быть вовсе.
 */
export function gitInit(dir: string): void {
  const git = (...args: string[]): void => {
    execFileSync('git', ['-C', dir, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  };
  git('init', '--quiet', '--initial-branch=main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Тест');
}

/**
 * Дайджест закрепления для фикстур: та же формула, какой считает его источник
 * `fs` (`contentHash` в `src/core/knowledge/fs.ts`) — sha256 по байтам файла,
 * первые 16 шестнадцатеричных символов. Дублируется здесь намеренно, а не
 * импортируется: тест обязан вычислить ожидаемое значение независимо от
 * реализации, а не переиспользовать её же код как оракул.
 */
export function anchorHash(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 16);
}

/** Закоммитить всё дерево репозитория одним коммитом. */
export function gitCommit(dir: string, message: string): void {
  execFileSync('git', ['-C', dir, 'add', '-A'], { stdio: ['ignore', 'pipe', 'pipe'] });
  execFileSync('git', ['-C', dir, 'commit', '--quiet', '-m', message], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/**
 * Окружение процесса без `STEPCAST_*`. Тесты, гоняемые самим stepcast (петля
 * саморазвития), наследуют эти переменные от внешнего прогона — без очистки
 * они просачиваются в проверяемый пайплайн, будто это настоящие шаг или
 * работа.
 */
export function testBaseEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (name.startsWith('STEPCAST_')) continue;
    env[name] = value;
  }
  return env;
}

/** Минимальный пайплайн с одним шагом командной строки. */
export const MINIMAL_PIPELINE = `
version: 1
kind: pipeline
name: minimal
jobs:
  build:
    steps:
      - id: compile
        run: [echo, ok]
        expect: [{ exit_code: 0 }]
`;

export interface JournalBed {
  readonly runsRoot: string;
  readonly projectRoot: string;
  readonly home: string;
}

/** Временный корень прогонов и проект к нему: каркас тестов журнала и UI. */
export function makeJournalBed(): JournalBed {
  const base = tempDir('bed-');
  const runsRoot = join(base, 'runs');
  const projectRoot = join(base, 'project');
  const home = join(base, 'home');
  mkdirSync(runsRoot, { recursive: true });
  mkdirSync(projectRoot, { recursive: true });
  mkdirSync(join(home, '.stepcast'), { recursive: true });
  writeFileSync(join(home, '.stepcast', 'config.yml'), `runs:\n  root: ${runsRoot}\n`);
  return { runsRoot, projectRoot, home };
}

export interface SeedRunOptions {
  readonly runId?: string;
  readonly status?: StatusValue;
  readonly jobs?: RunStatus['jobs'];
  readonly wakeAt?: string;
  readonly manifest?: Partial<RunManifest>;
  /** Работы, публикующие выход: каждой пишется `artifacts/<id>.json`. */
  readonly artifacts?: Readonly<Record<string, unknown>>;
  readonly lock?: string;
  /** Пустая сводка по умолчанию — тесты расхода задают её содержимое явно. */
  readonly usage?: UsageReport;
  /**
   * Не писать `usage.json` вовсе. Идущий прогон сводку уже пишет, так что это
   * не «прогон в разгаре», а два других случая: окно между созданием каталога
   * и первой записью и прогон прежней формы, писавший сводку только в конце и
   * до конца не доживший.
   */
  readonly skipUsage?: boolean;
  /** Переопределение `status.budget` — по умолчанию только токены и время. */
  readonly budget?: RunStatus['budget'];
  /** Ожидания решения (`user-decision-steps`) — по умолчанию прогон ничего не ждёт. */
  readonly awaiting?: RunStatus['awaiting'];
}

/**
 * Записать прогон на диск так, как это делает движок: манифест, состояние,
 * сводка расхода, лок и артефакты. Тесты витрины и уборки читают именно их.
 */
export function seedRun(
  runsRoot: string,
  projectRoot: string,
  options: SeedRunOptions = {},
): RunJournal {
  const journal = RunJournal.create({
    runsRoot,
    projectRoot,
    ...(options.runId === undefined ? {} : { runId: options.runId }),
  });
  const runId = journal.paths.runId;
  const status = options.status ?? 'success';

  journal.writeManifest({
    run_id: runId,
    pipeline: 'demo',
    pipeline_file: join(projectRoot, 'stepcast.yml'),
    lock_hash: 'abc',
    project_root: projectRoot,
    workspace: { mode: 'cwd' },
    inputs: {},
    git: {},
    backends: {},
    started_at: '2026-08-01T00:00:00.000Z',
    finished_at: '2026-08-01T00:05:00.000Z',
    ...options.manifest,
  });

  journal.writeStatus({
    run_id: runId,
    pipeline: 'demo',
    lock_hash: 'abc',
    status,
    workspace: { mode: 'cwd' },
    inputs: {},
    jobs: options.jobs ?? [],
    budget: options.budget ?? { tokens_used: 0, wallclock_ms: 0 },
    ...(options.wakeAt === undefined ? {} : { wake_at: options.wakeAt }),
    ...(options.awaiting === undefined ? {} : { awaiting: options.awaiting }),
    updated_at: '2026-08-01T00:05:00.000Z',
  });

  if (options.skipUsage !== true) {
    journal.writeUsage(
      options.usage ?? {
        run_id: runId,
        total: {
          tokens_in: 0,
          tokens_out: 0,
          cache_read: 0,
          cache_write: 0,
          billable_tokens: 0,
          wallclock_ms: 0,
        },
        unreported: [],
        jobs: {},
      },
    );
  }

  if (options.lock !== undefined) journal.writeLock(options.lock);
  for (const [job, value] of Object.entries(options.artifacts ?? {})) {
    journal.writeArtifact(job, value);
  }

  return journal;
}

/** Подменить HOME на время вызова: конфигурация читается из него. */
export function withHome<T>(home: string, fn: () => T): T {
  const original = process.env.HOME;
  process.env.HOME = home;
  const restore = (): void => {
    if (original === undefined) delete process.env.HOME;
    else process.env.HOME = original;
  };

  let result: T;
  try {
    result = fn();
  } catch (error) {
    restore();
    throw error;
  }

  // Подмена обязана держаться всё время асинхронного вызова, а не до первого
  // `await` внутри него: команда CLI читает конфигурацию не обязательно в
  // первом тике, и снятая раньше времени переменная уводит её в настоящий
  // домашний каталог.
  if (result instanceof Promise) return result.finally(restore) as T;
  restore();
  return result;
}

/** Сузить шаг до командного, заодно проверив тип. */
export function asRun(step: Step): RunStep {
  assert.equal(step.kind, 'run', `шаг ${step.id} ожидался командным`);
  return step as RunStep;
}

/** Сузить шаг до агентского, заодно проверив тип. */
export function asAgent(step: Step): AgentStep {
  assert.equal(step.kind, 'agent', `шаг ${step.id} ожидался агентским`);
  return step as AgentStep;
}

/** Сузить шаг до script, заодно проверив тип. */
export function asScript(step: Step): ScriptStep {
  assert.equal(step.kind, 'script', `шаг ${step.id} ожидался script`);
  return step as ScriptStep;
}
