import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { basename, dirname, join, relative, resolve as resolvePath } from 'node:path';

import { StepcastError } from '../errors.js';

/**
 * Заведение и адресное снятие рабочих деревьев git.
 *
 * Единственное место, где движок зовёт `git worktree`: подготовка дерева
 * (корень и объявленные части, `run/workspace.ts`) и уборка прогона
 * (`run/cleanup.ts`) пользуются им одинаково, вместо того чтобы каждая сторона
 * заново решала, как снимать учётную запись.
 */

function git(dir: string, args: readonly string[]): string {
  // `core.quotePath=false`: тот же смысл, что и у одноимённого помощника в
  // `run/workspace.ts` — не плодим комментарий по каждой копии.
  return execFileSync('git', ['-C', dir, '-c', 'core.quotePath=false', ...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

export interface AddWorktreeOptions {
  /** Репозиторий, в чьей базе объектов заводится дерево. */
  readonly repoDir: string;
  /** Путь, по которому дерево будет выложено. */
  readonly path: string;
}

/**
 * Завести рабочее дерево из `HEAD` репозитория.
 *
 * Ошибка git не оборачивается: причину формулирует вызывающий, у которого
 * есть контекст (корень это дерева или объявленная часть) — здесь его нет.
 */
export function addWorktree(options: AddWorktreeOptions): void {
  const { repoDir, path } = options;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  // Отделённый worktree от текущего HEAD: незакоммиченные изменения в него не
  // попадают, а ветка репозитория остаётся свободной.
  git(repoDir, ['worktree', 'add', '--detach', '--quiet', path, 'HEAD']);
}

export interface RemoveWorktreeOptions {
  /** Репозиторий, которому принадлежит снимаемое дерево. */
  readonly repoDir: string;
  /** Путь снимаемого дерева. */
  readonly path: string;
  /** Директория прогона: снятие отказывает на пути вне неё (см. ниже). */
  readonly runDir: string;
}

export type RemoveWorktreeOutcome =
  | { readonly kind: 'removed' }
  /**
   * Каталог снят средствами файловой системы, а об учётной записи сказать
   * нечего: репозиторий, которому она принадлежит, не ответил. Называется
   * причина — молчать о возможной утечке нельзя.
   */
  | { readonly kind: 'record_kept'; readonly reason: string };

/**
 * Путь с разрешёнными символическими ссылками — по ближайшему существующему
 * предку.
 *
 * git хранит пути рабочих деревьев разрешёнными (`/private/var/…` там, где
 * вызывающий сказал `/var/…`), а сравнивать их приходится в том числе с
 * путём, которого на диске уже нет: каталог снесён на предыдущей строке.
 * Поэтому ссылки разрешаются у той части пути, которая ещё существует, а
 * остаток приклеивается как есть.
 */
function canonicalPath(path: string): string {
  const absolute = resolvePath(path);
  const tail: string[] = [];
  let head = absolute;
  for (;;) {
    try {
      return join(realpathSync(head), ...tail);
    } catch {
      const parent = dirname(head);
      if (parent === head) return absolute;
      tail.unshift(basename(head));
      head = parent;
    }
  }
}

type RecordLocation =
  /** Записи по этому пути в репозитории нет — снимать нечего. */
  | { readonly kind: 'absent' }
  | { readonly kind: 'found'; readonly dir: string }
  /** Репозиторий не отвечает: есть запись или нет — неизвестно. */
  | { readonly kind: 'unknown'; readonly reason: string };

/**
 * Найти в репозитории учётную запись рабочего дерева по пути этого дерева.
 *
 * Имя записи выбирает git (последний сегмент пути, число при занятости), и
 * опираться на него нельзя — опора здесь та же, что и у всего учёта: путь.
 * Каждая запись `<общий git-каталог>/worktrees/<имя>` называет своё дерево
 * файлом `gitdir`, и совпадение ищется по нему.
 *
 * Ответ «записи нет» отличается от «репозиторий не ответил» намеренно:
 * первое — не утечка (запись снял прежний заход уборки), и называть её
 * неснятой значило бы забивать ложью канал, ради настоящих утечек и
 * заведённый (design.md, решение 7).
 */
function locateRecord(repoDir: string, path: string): RecordLocation {
  let commonDir: string;
  try {
    commonDir = git(repoDir, ['rev-parse', '--git-common-dir']).trim();
  } catch {
    return { kind: 'unknown', reason: `репозиторий ${repoDir} не отвечает, запись могла остаться` };
  }

  const worktreesDir = resolvePath(repoDir, commonDir, 'worktrees');
  let entries: readonly string[];
  try {
    entries = readdirSync(worktreesDir);
  } catch {
    // Каталога `worktrees` нет вовсе: в репозитории не заведено ни одного
    // отделённого дерева, и снимать нечего.
    return { kind: 'absent' };
  }

  const wanted = canonicalPath(path);
  for (const entry of entries) {
    let gitdir: string;
    try {
      gitdir = readFileSync(join(worktreesDir, entry, 'gitdir'), 'utf8').trim();
    } catch {
      continue;
    }
    // `gitdir` записи указывает на файл `.git` самого рабочего дерева.
    if (canonicalPath(dirname(gitdir)) === wanted) return { kind: 'found', dir: join(worktreesDir, entry) };
  }
  return { kind: 'absent' };
}

/**
 * Снять рабочее дерево адресно: и каталог, и учётную запись репозитория,
 * которому оно принадлежит.
 *
 * Основной путь — `git worktree remove --force`, снимающий оба разом. Он
 * отказывает и когда снимать уже нечего (повторная уборка того же прогона:
 * `is not a working tree`), и когда запись жива, но дерево ему не даётся
 * (git занят, запись заблокирована, каталог снесён мимо движка вместе с
 * родительским). Поэтому после отказа каталог сносится средствами файловой
 * системы, а репозиторий спрашивается прямо: есть ли у него запись по этому
 * пути. Есть — снимается она одна; нет — снимать нечего, и это не утечка;
 * репозиторий не ответил — запись названа неснятой.
 *
 * Слепой `git worktree prune` не зовётся нигде: он снял бы всякую
 * осиротевшую запись репозитория, а не только эту (design.md, решение 5).
 */
export function removeWorktree(options: RemoveWorktreeOptions): RemoveWorktreeOutcome {
  const { repoDir, path, runDir } = options;

  // Каталоги дерева проекта (корень и части) лежат вне директории прогона по
  // устройству — она обязана лежать вне рабочего дерева. Инвариант превращает
  // ошибку в вычислении пути в отказ, а не в снесённое чужое дерево.
  const relativeToRun = relative(resolvePath(runDir), resolvePath(path));
  if (relativeToRun === '' || relativeToRun.startsWith('..') || relativeToRun.startsWith(`..${'/'}`)) {
    throw new StepcastError(`Путь рабочего дерева лежит вне директории прогона: ${path}`, {
      hint: `Директория прогона: ${runDir}`,
    });
  }

  try {
    git(repoDir, ['worktree', 'remove', '--force', path]);
    return { kind: 'removed' };
  } catch {
    // Ниже — резервный путь.
  }

  rmSync(path, { recursive: true, force: true });

  const located = locateRecord(repoDir, path);
  if (located.kind === 'unknown') return { kind: 'record_kept', reason: located.reason };
  if (located.kind === 'found') rmSync(located.dir, { recursive: true, force: true });
  return { kind: 'removed' };
}
