import { createHash } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { StepcastError } from '../errors.js';
import type { LiveFile } from '../pipeline/model.js';

export interface LiveFileSnapshot {
  readonly fingerprints: Readonly<Record<string, string>>;
}

function fingerprint(path: string): string {
  if (!existsSync(path)) return 'missing';
  const stat = lstatSync(path);
  const hash = createHash('sha256');
  hash.update(`${stat.mode & 0o7777}\0`);
  if (stat.isSymbolicLink()) {
    hash.update('link\0');
    hash.update(readlinkSync(path));
  } else if (stat.isDirectory()) {
    hash.update('dir\0');
    for (const name of readdirSync(path).sort()) {
      hash.update(name);
      hash.update('\0');
      hash.update(fingerprint(join(path, name)));
      hash.update('\0');
    }
  } else {
    hash.update('file\0');
    hash.update(readFileSync(path));
  }
  return hash.digest('hex');
}

function copyPath(from: string, to: string): void {
  rmSync(to, { recursive: true, force: true });
  if (!existsSync(from)) return;
  mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
  cpSync(from, to, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
}

export function snapshotLiveFiles(root: string, liveFiles: readonly LiveFile[]): LiveFileSnapshot {
  return {
    fingerprints: Object.fromEntries(liveFiles.map((live) => [live.path, fingerprint(join(root, live.path))])),
  };
}

/** Кладёт только явно объявленные live-пути поверх commit-backed дерева. */
export function syncLiveFiles(
  sourceRoot: string,
  workspaceRoot: string,
  liveFiles: readonly LiveFile[],
): LiveFileSnapshot {
  const snapshot = snapshotLiveFiles(sourceRoot, liveFiles);
  if (sourceRoot === workspaceRoot) return snapshot;
  for (const live of liveFiles) copyPath(join(sourceRoot, live.path), join(workspaceRoot, live.path));
  return snapshot;
}

export function assertLiveFilesUnchanged(
  sourceRoot: string,
  liveFiles: readonly LiveFile[],
  snapshot: LiveFileSnapshot,
): void {
  for (const live of liveFiles) {
    if (fingerprint(join(sourceRoot, live.path)) === snapshot.fingerprints[live.path]) continue;
    throw new StepcastError(`Живой файл изменился параллельно: ${live.path}`, {
      file: join(sourceRoot, live.path),
      hint: 'Повторите операцию с актуальным содержимым; чужая правка не была перезаписана',
    });
  }
}

/**
 * Возвращает изменённые job-ом live-файлы в checkout. Не тронутые job-ом
 * пути не записываются и потому не конфликтуют с более свежей версией.
 */
export function writebackLiveFiles(options: {
  readonly sourceRoot: string;
  readonly workspaceRoot: string;
  readonly liveFiles: readonly LiveFile[];
  readonly snapshot: LiveFileSnapshot;
}): void {
  const { sourceRoot, workspaceRoot, liveFiles, snapshot } = options;
  if (sourceRoot === workspaceRoot) return;
  const changed = liveFiles.filter(
    (live) => fingerprint(join(workspaceRoot, live.path)) !== snapshot.fingerprints[live.path],
  );
  if (changed.length === 0) return;
  assertLiveFilesUnchanged(sourceRoot, changed, snapshot);
  for (const live of changed) copyPath(join(workspaceRoot, live.path), join(sourceRoot, live.path));
}

