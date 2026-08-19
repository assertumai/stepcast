import { execFileSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { StepcastError } from '../errors.js';
import type { Anchor, AnchorComparison, TreeAnchorer } from './types.js';

/**
 * Фиксация состояния средствами git.
 *
 * Работа идёт через отдельный индексный файл (`GIT_INDEX_FILE`), а не через
 * индекс репозитория: прогон не имеет права затоптать то, что пользователь
 * подготовил к коммиту. История, ветки и `HEAD` не затрагиваются вовсе —
 * `write-tree` создаёт объект дерева, но не коммит.
 *
 * Альтернатива `git stash create` отвергнута: она трогает индекс репозитория,
 * оставляет след в reflog и даёт коммит вместо дерева.
 *
 * Индексный файл переиспользуется между шагами одной работы: `add -A` по
 * существующему индексу платит только за изменившиеся файлы.
 */
export interface GitAnchorerOptions {
  /** Каталог, состояние которого фиксируется. */
  readonly dir: string;
  /** Путь к индексному файлу. Живёт в директории прогона, не в репозитории. */
  readonly indexFile: string;
}

function git(dir: string, args: readonly string[], indexFile?: string): string {
  // `core.quotePath=false`: иначе git экранирует не-ASCII пути в выводе
  // C-последовательностями, и предикат границ, объяснение инвалидации и
  // сравнение прогонов начинают показывать «\321\201...» вместо имени файла.
  return execFileSync('git', ['-C', dir, '-c', 'core.quotePath=false', ...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    // Диагностика git попадает в исключение, а не в вывод процесса: ожидаемые
    // отказы (проба на репозиторий, недоступный объект) не должны шуметь.
    stdio: ['ignore', 'pipe', 'pipe'],
    env:
      indexFile === undefined
        ? { ...process.env }
        : { ...process.env, GIT_INDEX_FILE: indexFile },
  });
}

/** Является ли каталог рабочим деревом git. */
export function isGitWorktree(dir: string): boolean {
  try {
    return git(dir, ['rev-parse', '--is-inside-work-tree']).trim() === 'true';
  } catch {
    return false;
  }
}

export function createGitAnchorer(options: GitAnchorerOptions): TreeAnchorer {
  const { dir, indexFile } = options;

  return {
    kind: 'git',

    capture(): Anchor {
      git(dir, ['add', '-A'], indexFile);
      const id = git(dir, ['write-tree'], indexFile).trim();
      return { kind: 'git', id };
    },

    restore(anchor: Anchor): void {
      if (anchor.kind !== 'git') {
        throw new StepcastError('Состояние снято не средствами git и восстановлению не подлежит', {
          hint: 'Якорь на хеш-манифесте отвечает, изменилось ли дерево, но не хранит его содержимого',
        });
      }

      // Объекты проверяются до записи: восстановление не имеет права оставить
      // дерево наполовину приведённым к чужому состоянию.
      try {
        git(dir, ['cat-file', '-e', `${anchor.id}^{tree}`]);
      } catch (error) {
        throw new StepcastError(`Объекты состояния ${anchor.id} недоступны в этом репозитории`, {
          hint: 'Прогон мог быть снят в другом репозитории или объекты удалены уборкой git',
          cause: error,
        });
      }

      // Индекс приводится к текущему рабочему дереву, и только потом дерево
      // переводится в целевое состояние: иначе `read-tree -u` не знает, какие
      // лишние файлы удалять.
      git(dir, ['add', '-A'], indexFile);
      git(dir, ['read-tree', '-u', '--reset', anchor.id], indexFile);
    },

    restorePaths(anchor: Anchor, paths: readonly string[]): void {
      if (paths.length === 0) return;
      if (anchor.kind !== 'git') {
        throw new StepcastError('Состояние снято не средствами git и восстановлению не подлежит');
      }

      // Пути, которых в целевом состоянии нет, надо убрать, а не «восстановить»:
      // `checkout` о несуществующем файле сообщает ошибкой.
      const present = new Set(
        git(dir, ['ls-tree', '-r', '--name-only', anchor.id])
          .split('\n')
          .filter((line) => line !== ''),
      );

      const restore = paths.filter((path) => present.has(path));
      const remove = paths.filter((path) => !present.has(path));

      if (restore.length > 0) git(dir, ['checkout', anchor.id, '--', ...restore]);
      for (const path of remove) rmSync(join(dir, path), { force: true });
    },

    changedPaths(from: Anchor, to: Anchor): AnchorComparison {
      if (from.kind !== to.kind) {
        return {
          comparable: false,
          reason: `состояния сняты разными способами: ${from.kind} и ${to.kind}`,
        };
      }
      if (from.id === to.id) return { comparable: true, paths: [] };

      const output = git(dir, ['diff-tree', '-r', '--name-only', '--no-commit-id', from.id, to.id]);
      return {
        comparable: true,
        paths: output.split('\n').filter((line) => line !== ''),
      };
    },

    diff(from: Anchor, to: Anchor): string | undefined {
      if (from.kind !== to.kind || from.id === to.id) return undefined;
      const patch = git(dir, ['diff', '--binary', from.id, to.id]);
      return patch === '' ? undefined : patch;
    },

    dispose(): void {
      if (existsSync(indexFile)) rmSync(indexFile, { force: true });
    },
  };
}
