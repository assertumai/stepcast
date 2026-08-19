import { randomBytes } from 'node:crypto';
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { StepcastError } from '../errors.js';
import {
  jobDir,
  makeRunId,
  projectKey,
  runPaths,
  stepDir,
  type RunPaths,
} from './paths.js';
import type {
  ContextReport,
  Event,
  EventInput,
  ExpectReport,
  RunManifest,
  RunStatus,
  UsageReport,
} from './schema.js';

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

/**
 * Запись журнала.
 *
 * События дописываются построчно, состояние заменяется целиком через
 * временный файл и переименование: читатель с сопровождением никогда не должен
 * увидеть половину JSON-документа, а переименование в пределах файловой
 * системы атомарно.
 */
export class RunJournal {
  readonly paths: RunPaths;
  readonly projectRoot: string;
  private sequence = 0;

  private constructor(paths: RunPaths, projectRoot: string) {
    this.paths = paths;
    this.projectRoot = projectRoot;
  }

  static create(options: {
    readonly runsRoot: string;
    readonly projectRoot: string;
    readonly now?: Date;
    readonly runId?: string;
  }): RunJournal {
    const key = projectKey(options.projectRoot);
    const runId =
      options.runId ?? makeRunId(options.now ?? new Date(), randomBytes(3).toString('hex'));
    const paths = runPaths(options.runsRoot, key, runId);

    mkdirSync(paths.dir, { recursive: true, mode: DIR_MODE });
    mkdirSync(paths.artifacts, { recursive: true, mode: DIR_MODE });
    mkdirSync(paths.jobs, { recursive: true, mode: DIR_MODE });
    mkdirSync(paths.anchors, { recursive: true, mode: DIR_MODE });

    const journal = new RunJournal(paths, options.projectRoot);
    journal.updateProjectIndex(options.runsRoot, key);
    journal.linkLatest();
    return journal;
  }

  /** Соответствие ключа и пути: без него по каталогу прогонов не сориентироваться. */
  private updateProjectIndex(runsRoot: string, key: string): void {
    const indexPath = join(runsRoot, 'projects.json');
    let index: Record<string, { path: string; last_run: string }> = {};
    try {
      index = JSON.parse(readFileIfExists(indexPath) ?? '{}') as typeof index;
    } catch {
      // Повреждённый указатель не повод ронять прогон — он перезапишется.
      index = {};
    }
    index[key] = { path: this.projectRoot, last_run: new Date().toISOString() };
    atomicWrite(indexPath, `${JSON.stringify(index, null, 2)}\n`);
  }

  private linkLatest(): void {
    const link = join(this.paths.projectDir, 'latest');
    try {
      rmSync(link, { force: true });
      symlinkSync(this.paths.runId, link);
    } catch {
      // На платформах без символических ссылок отсутствие ярлыка не мешает
      // работе: прогон адресуется идентификатором.
    }
  }

  event(input: EventInput): void {
    const event = { ts: new Date().toISOString(), seq: this.sequence++, ...input } as Event;
    appendFileSync(this.paths.events, `${JSON.stringify(event)}\n`, { mode: FILE_MODE });
  }

  writeManifest(manifest: RunManifest): void {
    atomicWrite(this.paths.manifest, `${JSON.stringify(manifest, null, 2)}\n`);
  }

  writeStatus(status: RunStatus): void {
    atomicWrite(this.paths.status, `${JSON.stringify(status, null, 2)}\n`);
  }

  writeUsage(usage: UsageReport): void {
    atomicWrite(this.paths.usage, `${JSON.stringify(usage, null, 2)}\n`);
  }

  writeLock(content: string): void {
    atomicWrite(this.paths.lock, content);
  }

  /** Создать каталог работы и вернуть его путь. */
  prepareJob(jobId: string): string {
    const dir = jobDir(this.paths, jobId);
    mkdirSync(dir, { recursive: true, mode: DIR_MODE });
    return dir;
  }

  /** Создать каталог шага и вернуть его путь. */
  prepareStep(jobId: string, index: number, stepId: string, iteration?: number): string {
    const dir = stepDir(this.paths, jobId, index, stepId, iteration);
    mkdirSync(dir, { recursive: true, mode: DIR_MODE });
    return dir;
  }

  writeStepFile(dir: string, name: string, content: string): string {
    const path = join(dir, name);
    atomicWrite(path, content);
    return path;
  }

  writeStepJson(dir: string, name: string, value: unknown): string {
    return this.writeStepFile(dir, name, `${JSON.stringify(value, null, 2)}\n`);
  }

  writeContextReport(dir: string, report: ContextReport): string {
    return this.writeStepJson(dir, 'context.json', report);
  }

  writeExpectReport(dir: string, report: ExpectReport): string {
    return this.writeStepJson(dir, 'expect.json', report);
  }

  /** Опубликовать структурированный выход работы. */
  writeArtifact(jobId: string, value: unknown): string {
    const path = join(this.paths.artifacts, `${jobId}.json`);
    atomicWrite(path, `${JSON.stringify(value, null, 2)}\n`);
    return path;
  }
}

/** Замена файла целиком: сначала временный, затем переименование. */
export function atomicWrite(path: string, content: string): void {
  const temporary = `${path}.tmp-${process.pid}`;
  try {
    writeFileSync(temporary, content, { mode: FILE_MODE });
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw new StepcastError(`Не удалось записать ${path}: ${(error as Error).message}`, {
      file: path,
      cause: error,
    });
  }
}

function readFileIfExists(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}
