import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync, rmSync } from 'node:fs';
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
  /**
   * Репозиторий, чьей базой объектов пользоваться, если `dir` сам рабочим
   * деревом git не является.
   *
   * Так фиксируется состояние рабочей копии в режиме `copy`: копия делается
   * из рабочего дерева, но `.git` в неё не переносится, и без этого `git add`
   * в ней отказал бы «not a git repository» — а вместе с ним молча пропали бы
   * и якоря, и наследование дерева зависимой работой. Объекты пишутся в базу
   * проекта — ровно как в режиме `worktree`, который делит её по устройству
   * самого git.
   */
  readonly repoDir?: string;
}

function git(
  dir: string,
  args: readonly string[],
  indexFile?: string,
  external?: ExternalRepo,
): string {
  // `core.quotePath=false`: иначе git экранирует не-ASCII пути в выводе
  // C-последовательностями, и предикат границ, объяснение инвалидации и
  // сравнение прогонов начинают показывать «\321\201...» вместо имени файла.
  return execFileSync('git', ['-C', dir, '-c', 'core.quotePath=false', ...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    // Диагностика git попадает в исключение, а не в вывод процесса: ожидаемые
    // отказы (проба на репозиторий, недоступный объект) не должны шуметь.
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      ...(indexFile === undefined ? {} : { GIT_INDEX_FILE: indexFile }),
      ...(external === undefined ? {} : { GIT_DIR: external.gitDir, GIT_WORK_TREE: dir }),
    },
  });
}

/** База объектов чужого репозитория, взятая напрокат для каталога вне git. */
interface ExternalRepo {
  readonly gitDir: string;
}

/**
 * Патч между двумя состояниями каталога с приписанным префиксом путей —
 * `--src-prefix=a/<prefix>/ --dst-prefix=b/<prefix>/`.
 *
 * Используется составным якорем (`anchor/composite.ts`) для патчей частей:
 * так пути внутри `diff.patch` совпадают с путями, которые вернул
 * `changedPaths` (`<каталог части>/<путь>`), и файл читается как один
 * документ. Часть не нуждается в индексном файле — сравниваются готовые
 * объекты дерева, а не рабочая копия.
 */
export function diffWithPrefix(dir: string, from: string, to: string, prefix: string): string | undefined {
  if (from === to) return undefined;
  const patch = git(dir, ['diff', '--binary', `--src-prefix=a/${prefix}/`, `--dst-prefix=b/${prefix}/`, from, to]);
  return patch === '' ? undefined : patch;
}

/** Является ли каталог рабочим деревом git. */
export function isGitWorktree(dir: string): boolean {
  try {
    return git(dir, ['rev-parse', '--is-inside-work-tree']).trim() === 'true';
  } catch {
    return false;
  }
}

/**
 * Является ли каталог **вершиной** рабочего дерева собственного репозитория —
 * не просто каталогом внутри чужого. `isGitWorktree` этого не различает:
 * подкаталог без своего `.git`, лежащий внутри чужого рабочего дерева
 * (например, часть, чей worktree снесён мимо якоря), отвечает на него так же
 * утвердительно, как настоящая часть, — потому что физически он и правда
 * лежит внутри чьего-то дерева. Составному якорю (`anchor/composite.ts`)
 * нужен именно этот, более узкий вопрос: у каталога есть собственная база
 * объектов, или нет.
 */
export function isOwnWorktreeRoot(dir: string): boolean {
  if (!isGitWorktree(dir)) return false;
  try {
    const toplevel = git(dir, ['rev-parse', '--show-toplevel']).trim();
    return realpathSync(toplevel) === realpathSync(dir);
  } catch {
    return false;
  }
}

/**
 * База объектов для каталога, который сам рабочим деревом git не является.
 *
 * Отказ здесь громкий и немедленный: тихо снятый якорь «ни на чём» хуже
 * отсутствующего — по нему нельзя ни восстановить дерево, ни объяснить, куда
 * делся результат предшественника.
 */
function resolveExternalRepo(options: GitAnchorerOptions): ExternalRepo | undefined {
  const { dir, repoDir } = options;
  if (isGitWorktree(dir)) return undefined;
  if (repoDir === undefined) {
    throw new StepcastError(`Каталог ${dir} не является рабочим деревом git`, {
      hint: 'Состояние такого каталога фиксируется хеш-манифестом, а не git',
    });
  }
  try {
    return { gitDir: git(repoDir, ['rev-parse', '--absolute-git-dir']).trim() };
  } catch (error) {
    throw new StepcastError(`Репозиторий git не найден рядом с ${repoDir}`, { cause: error });
  }
}

export function createGitAnchorer(options: GitAnchorerOptions): TreeAnchorer {
  const { dir, indexFile } = options;
  const external = resolveExternalRepo(options);

  return {
    kind: 'git',

    capture(): Anchor {
      git(dir, ['add', '-A'], indexFile, external);
      const id = git(dir, ['write-tree'], indexFile, external).trim();
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
        git(dir, ['cat-file', '-e', `${anchor.id}^{tree}`], undefined, external);
      } catch (error) {
        throw new StepcastError(`Объекты состояния ${anchor.id} недоступны в этом репозитории`, {
          hint: 'Прогон мог быть снят в другом репозитории или объекты удалены уборкой git',
          cause: error,
        });
      }

      // Индекс приводится к текущему рабочему дереву, и только потом дерево
      // переводится в целевое состояние: иначе `read-tree -u` не знает, какие
      // лишние файлы удалять.
      git(dir, ['add', '-A'], indexFile, external);
      git(dir, ['read-tree', '-u', '--reset', anchor.id], indexFile, external);
    },

    restorePaths(anchor: Anchor, paths: readonly string[]): void {
      if (paths.length === 0) return;
      if (anchor.kind !== 'git') {
        throw new StepcastError('Состояние снято не средствами git и восстановлению не подлежит');
      }

      // Пути, которых в целевом состоянии нет, надо убрать, а не «восстановить»:
      // `checkout` о несуществующем файле сообщает ошибкой.
      const present = new Set(
        git(dir, ['ls-tree', '-r', '--name-only', anchor.id], undefined, external)
          .split('\n')
          .filter((line) => line !== ''),
      );

      const restore = paths.filter((path) => present.has(path));
      const remove = paths.filter((path) => !present.has(path));

      if (restore.length > 0) {
        git(dir, ['checkout', anchor.id, '--', ...restore], indexFile, external);
      }
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
      // Способы совпали между собой, но не с нашим: так бывает, когда сегодня
      // состав вложенных репозиториев не объявлен, а сравниваемые записи
      // сняты составным способом. Идентификатор чужого способа — не oid, и
      // отдать его `diff-tree` значило бы получить сырое «fatal: bad object»
      // вместо объявленной несравнимости.
      // Способы совпали между собой, но не с нашим: так бывает, когда сегодня
      // состав вложенных репозиториев не объявлен, а сравниваемые записи
      // сняты составным способом. Идентификатор чужого способа — не oid, и
      // отдать его `diff-tree` значило бы получить сырое «fatal: bad object»
      // вместо объявленной несравнимости.
      if (from.kind !== 'git') {
        return {
          comparable: false,
          reason: `состояния сняты способом ${from.kind}, а действующий якорь — git`,
        };
      }

      const output = git(
        dir,
        ['diff-tree', '-r', '--name-only', '--no-commit-id', from.id, to.id],
        undefined,
        external,
      );
      return {
        comparable: true,
        paths: output.split('\n').filter((line) => line !== ''),
      };
    },

    diff(from: Anchor, to: Anchor): string | undefined {
      if (from.kind !== to.kind || from.id === to.id) return undefined;
      if (from.kind !== 'git') return undefined;
      const patch = git(dir, ['diff', '--binary', from.id, to.id], undefined, external);
      return patch === '' ? undefined : patch;
    },

    dispose(): void {
      if (existsSync(indexFile)) rmSync(indexFile, { force: true });
    },
  };
}
