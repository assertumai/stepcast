import { execFileSync } from 'node:child_process';
import { realpathSync, statSync } from 'node:fs';
import { relative, resolve as resolvePath } from 'node:path';

import { isGitWorktree } from '../anchor/git.js';
import { StepcastError } from '../errors.js';

/**
 * Операции над деревом запуска, которые нужны сведению дорожек: проверка
 * чистоты, коммит до наложения и откат к нему, коммит наложенной дорожки.
 * Один помощник git на весь модуль — не россыпь `execFileSync` по функциям,
 * чтобы кодировка, буфер и `stdio` не расходились файл в файл.
 */

function git(dir: string, args: readonly string[]): string {
  return execFileSync('git', ['-C', dir, ...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

export interface CleanTreeOptions {
  /**
   * Пути, правки которых чистоту не нарушают: их вносит сама петля до
   * сведения (учётные файлы вроде очереди улучшений), и требовать от них
   * коммита значило бы требовать коммита посреди прогона. Абсолютные либо
   * относительно `dir`; путь вне дерева просто ни с чем не совпадёт.
   */
  readonly allow?: readonly string[];
  /**
   * Объявленный состав вложенных репозиториев дерева (`project.nested_repos`)
   * — каталоги, каждый из которых сам является рабочим деревом git. `git
   * status` корня туда не заглядывает, поэтому ядро принимает состав
   * параметром и снимает состояние в каждом отдельно, тем же приёмом, что и
   * составной якорь (`src/core/anchor/composite.ts`). Читает его вызывающий
   * код из конфигурации проекта — этот модуль конфигурации не знает.
   */
  readonly nested?: readonly string[];
}

/** Путь дерева, относительный и в разделителях git, — для сверки с `status --porcelain`. */
function treePath(dir: string, path: string): string {
  return relative(dir, resolvePath(dir, path)).split('\\').join('/');
}

/**
 * Пути одной строки `status --porcelain`: `XY путь` либо, для переименования,
 * `XY старый -> новый`. Путь с необычными знаками git выдаёт в кавычках и с
 * экранированием в духе C — `JSON.parse` разбирает такую запись достаточно
 * точно для сверки, а на своём разборе кавычек здесь экономить нечего.
 */
function porcelainPaths(line: string): readonly string[] {
  const rest = line.slice(3);
  const parts = rest.includes(' -> ') ? rest.split(' -> ') : [rest];
  return parts.map((part) => {
    if (!part.startsWith('"')) return part;
    try {
      return JSON.parse(part) as string;
    } catch {
      return part;
    }
  });
}

/**
 * Проверить, что объявленный вложенный каталог годен к снятию `status`: он
 * существует, является рабочим деревом git и — деревом **собственного**
 * репозитория, а не подкаталогом корневого (иначе его `status` был бы
 * status'ом корня под чужим именем). Правила и формулировки те же, что у
 * `checkWorkspaceAvailability` (`src/core/run/workspace.ts`), включая
 * отдельное сообщение об отсутствующем каталоге: человек, читающий отказ,
 * не должен гадать, опечатка это в составе или несклонированная часть.
 * Оттуда проверка не зовётся: там же живёт требование первого коммита,
 * нужное запуску пайплайна, а не этой проверке.
 */
function assertOwnWorktree(dir: string, relDir: string, full: string): void {
  let isDirectory: boolean;
  try {
    isDirectory = statSync(full).isDirectory();
  } catch (error) {
    throw new StepcastError(`Объявленный вложенный репозиторий не существует: ${relDir}`, {
      file: dir,
      hint: 'Проверьте путь в project.nested_repos — опечатку или несклонированный подмодуль',
      cause: error,
    });
  }
  if (!isDirectory || !isGitWorktree(full)) {
    throw new StepcastError(`Объявленный вложенный репозиторий не является рабочим деревом git: ${relDir}`, {
      file: dir,
      hint: 'project.nested_repos называет каталог, который сам является отдельным git-репозиторием',
    });
  }
  const toplevel = git(full, ['rev-parse', '--show-toplevel']).trim();
  if (realpathSync(toplevel) !== realpathSync(full)) {
    throw new StepcastError(
      `Объявленный вложенный репозиторий ${relDir} принадлежит репозиторию ${toplevel}, а не собственному`,
      {
        file: dir,
        hint: 'project.nested_repos называет каталог собственного репозитория, а не подкаталог корневого',
      },
    );
  }
}

/**
 * Достать путь (уже приведённый к корню дерева запуска, в разделителях git) к
 * репозиторию, которому он принадлежит, — по самому длинному совпавшему
 * объявленному префиксу. Правило то же, что у `routeOf` в
 * `src/core/anchor/composite.ts`: gitlink (путь равен самому объявленному
 * каталогу) маршрутизируется в корень — его двигает коммит внутри части, а не
 * правка рабочего дерева.
 */
function routeToOwnRepo(
  nestedByLengthDesc: readonly string[],
  rootRelativePath: string,
): { readonly relDir: string | undefined; readonly localPath: string } {
  for (const declared of nestedByLengthDesc) {
    if (rootRelativePath === declared) return { relDir: undefined, localPath: rootRelativePath };
    if (rootRelativePath.startsWith(`${declared}/`)) {
      return { relDir: declared, localPath: rootRelativePath.slice(declared.length + 1) };
    }
  }
  return { relDir: undefined, localPath: rootRelativePath };
}

/**
 * Объявленный каталог, в чьём рабочем дереве лежит путь, — либо `undefined`,
 * если путь принадлежит корню (в том числе когда состав не объявлен вовсе или
 * путь равен самому объявленному каталогу: такую запись двигает коммит внутри
 * части, и она принадлежит корню).
 *
 * Тем же правилом проверка чистоты раздаёт `allow` по деревьям. Наружу оно
 * вынесено для сведения дорожек: `merge-lanes` обязан узнать, что файл
 * очереди лежит внутри вложенного репозитория, **до** того как тронет дерево
 * (`src/core/lanes/merge.ts`).
 */
export function nestedRepoOf(
  dir: string,
  nested: readonly string[],
  path: string,
): string | undefined {
  const byLengthDesc = [...nested].sort((a, b) => b.length - a.length);
  return routeToOwnRepo(byLengthDesc, treePath(dir, path)).relDir;
}

/**
 * Дерево запуска обязано быть репозиторием git без незакоммиченных и
 * неотслеживаемых изменений — откат красной проверки стирает и то, и другое,
 * и команда не вправе полагаться на то, что чистоту проверил кто-то до неё.
 *
 * `git status` корня во вложенный репозиторий не заглядывает: игнорируемый
 * корнем не виден вовсе, отслеживаемый виден одной записью gitlink, которую
 * правка рабочего дерева не двигает. Поэтому при объявленном составе
 * (`options.nested`, `project.nested_repos`) проверка снимает состояние
 * отдельно в корне и в каждом объявленном каталоге — своим вызовом git на
 * своё дерево, тем же приёмом, что и составной якорь
 * (`src/core/anchor/composite.ts`).
 *
 * Исключение — перечисленные в `allow` учётные файлы петли: их правки не
 * работа агента, а бухгалтерия прогона, и сведение их бережёт само. Каждый
 * путь прощается тому дереву, где лежит, — не остальным: одноимённый файл в
 * соседнем дереве исключением не прощается.
 */
export function assertCleanTree(dir: string, options: CleanTreeOptions = {}): void {
  let rootStatus: string;
  try {
    rootStatus = git(dir, ['status', '--porcelain']);
  } catch (error) {
    throw new StepcastError(`Дерево запуска не является репозиторием git: ${dir}`, {
      file: dir,
      hint: 'Сведение дорожек опирается на git — откатывать красную проверку больше нечем',
      cause: error,
    });
  }

  const nested = options.nested ?? [];
  const nestedDirs = nested.map((relDir) => {
    const full = resolvePath(dir, relDir);
    assertOwnWorktree(dir, relDir, full);
    return { relDir, full };
  });

  // Каждый путь allow достаётся ровно одному дереву — по самому длинному
  // совпавшему объявленному префиксу, — и сверяется с его собственным
  // `status`, а не со status корня.
  const nestedByLengthDesc = [...nested].sort((a, b) => b.length - a.length);
  const allowByRepo = new Map<string | undefined, Set<string>>();
  for (const path of options.allow ?? []) {
    const { relDir, localPath } = routeToOwnRepo(nestedByLengthDesc, treePath(dir, path));
    const set = allowByRepo.get(relDir) ?? new Set<string>();
    set.add(localPath);
    allowByRepo.set(relDir, set);
  }

  const isDirty = (status: string, allowed: ReadonlySet<string>): boolean =>
    status
      .split('\n')
      .filter((line) => line.trim() !== '')
      .some((line) => porcelainPaths(line).some((path) => !allowed.has(path)));

  const dirtyLabels: string[] = [];
  if (isDirty(rootStatus, allowByRepo.get(undefined) ?? new Set())) dirtyLabels.push('корень');
  for (const { relDir, full } of nestedDirs) {
    let status: string;
    try {
      status = git(full, ['status', '--porcelain']);
    } catch (error) {
      // Годность каталога проверена выше, поэтому сюда доходит только отказ
      // самого git — битый индекс, гонка с чужим коммитом, снятая посреди
      // проверки блокировка. Отказ обязан остаться названным: «внутренняя
      // ошибка» со стеком в логе шага неотличима от дефекта движка.
      throw new StepcastError(`Состояние объявленного вложенного репозитория ${relDir} не снять`, {
        file: dir,
        hint: 'git отказал на status в этом каталоге — проверьте репозиторий вручную',
        cause: error,
      });
    }
    if (isDirty(status, allowByRepo.get(relDir) ?? new Set())) dirtyLabels.push(relDir);
  }

  if (dirtyLabels.length > 0) {
    // Дерево без объявленного состава отвечает прежним сообщением: слово
    // «корень» там объясняло бы состав, которого нет, а деревьев в отказе всё
    // равно ровно одно — оно названо полем `file`.
    const detail =
      nested.length === 0
        ? 'есть незакоммиченные либо неотслеживаемые изменения'
        : `незакоммиченные либо неотслеживаемые изменения есть в: ${dirtyLabels.join(', ')}`;
    throw new StepcastError(`Дерево запуска не чисто: ${detail}`, {
      file: dir,
      hint: 'Закоммитьте или отложите правки и повторите — откат красной проверки стирает их безвозвратно',
    });
  }
}

/**
 * Коммит, на который дерево вернётся при откате красной проверки этой
 * дорожки. Адресован каталогу `dir`: составное сведение (`merge-lanes-per-
 * repo`) зовёт этот же примитив по одному разу на каждый затронутый
 * репозиторий — своим `dir`, своим `sha`.
 */
export function currentCommit(dir: string): string {
  return git(dir, ['rev-parse', 'HEAD']).trim();
}

/**
 * Откатить дерево к коммиту, записанному до наложения дорожки. Адресован
 * каталогу `dir` — так же, как `currentCommit`: составное сведение зовёт его
 * по репозиторию, и откат одного не достаёт до соседних.
 *
 * `clean -fd` без `-x`: игнорируемые пути (`node_modules`, `dist`) не
 * трогаются — восстанавливать их после каждой красной проверки стоило бы
 * дороже самого сведения.
 */
export function resetToCommit(dir: string, sha: string): void {
  git(dir, ['reset', '--hard', sha]);
  git(dir, ['clean', '-fd']);
}

/**
 * Закоммитить наложенную дорожку — если есть что коммитить, и не иначе.
 *
 * Индекс после `git add -A` может оказаться пустым: у затронутого кодового
 * репозитория эта ветка недостижима (дифф заведомо непуст), а у репозитория
 * очереди она означает «отметку хранить негде» — файл очереди не отслеживается
 * этим репозиторием вовсе (лежит вне дерева или игнорируется). `git commit` на
 * пустом индексе отказывает, и такой отказ не является отказом сведения
 * (design.md, решение 8). Возвращает, был ли коммит сделан.
 */
export function commitAll(dir: string, message: string): boolean {
  git(dir, ['add', '-A']);
  if (git(dir, ['diff', '--cached', '--name-only']).trim() === '') return false;
  git(dir, ['commit', '-m', message]);
  return true;
}

/**
 * Ведёт ли репозиторий `dir` объявленный каталог `relDir` записью gitlink
 * (режим `160000` в индексе) — то есть является ли он надпроектом этой части.
 *
 * Гитлинк асимметричен: коммит **внутри** части двигает запись о ней в
 * надпроекте, и надпроект остаётся с незакоммиченной правкой, пока не
 * закоммитит её сам. Поэтому порядок коммитов сведения зависит от ответа:
 * корень, ведущий часть гитлинком, обязан коммититься после неё
 * (`src/core/lanes/merge.ts`). Ведёт ли корень часть — свойство самого
 * дерева, а не конфигурации: объявленный состав говорит лишь, что каталог
 * является отдельным репозиторием, но не говорит, отслеживает ли его корень
 * (часто он его игнорирует).
 */
export function tracksGitlink(dir: string, relDir: string): boolean {
  try {
    return git(dir, ['ls-files', '--stage', '--', relDir])
      .split('\n')
      .some((line) => line.startsWith('160000 '));
  } catch {
    // Каталог вне дерева, битый индекс — ответ «не ведёт»: порядок коммитов
    // тогда прежний, а настоящий отказ придёт от самих коммитов.
    return false;
  }
}

/**
 * Сообщение последнего коммита `HEAD` репозитория — `undefined`, если
 * репозиторий ещё не имеет ни одного коммита. Нужно предполётной диагностике
 * обрыва между коммитами (design.md, решение 9): она читает `HEAD` каждого
 * репозитория, которого сведение может коснуться, до первой правки дерева.
 */
export function headMessage(dir: string): string | undefined {
  try {
    return git(dir, ['log', '-1', '--format=%s']).trim();
  } catch {
    return undefined;
  }
}
