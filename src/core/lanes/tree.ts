import { execFileSync } from 'node:child_process';
import { relative, resolve as resolvePath } from 'node:path';

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
 * Дерево запуска обязано быть репозиторием git без незакоммиченных и
 * неотслеживаемых изменений — откат красной проверки стирает и то, и другое,
 * и команда не вправе полагаться на то, что чистоту проверил кто-то до неё.
 *
 * Исключение — перечисленные в `allow` учётные файлы петли: их правки не
 * работа агента, а бухгалтерия прогона, и сведение их бережёт само.
 */
export function assertCleanTree(dir: string, options: CleanTreeOptions = {}): void {
  let status: string;
  try {
    status = git(dir, ['status', '--porcelain']);
  } catch (error) {
    throw new StepcastError(`Дерево запуска не является репозиторием git: ${dir}`, {
      file: dir,
      hint: 'Сведение дорожек опирается на git — откатывать красную проверку больше нечем',
      cause: error,
    });
  }

  const allowed = new Set((options.allow ?? []).map((path) => treePath(dir, path)));
  const dirty = status
    .split('\n')
    .filter((line) => line.trim() !== '')
    .filter((line) => porcelainPaths(line).some((path) => !allowed.has(path)));

  if (dirty.length > 0) {
    throw new StepcastError('Дерево запуска не чисто: есть незакоммиченные либо неотслеживаемые изменения', {
      file: dir,
      hint: 'Закоммитьте или отложите правки и повторите — откат красной проверки стирает их безвозвратно',
    });
  }
}

/** Коммит, на который дерево вернётся при откате красной проверки этой дорожки. */
export function currentCommit(dir: string): string {
  return git(dir, ['rev-parse', 'HEAD']).trim();
}

/**
 * Откатить дерево к коммиту, записанному до наложения дорожки.
 *
 * `clean -fd` без `-x`: игнорируемые пути (`node_modules`, `dist`) не
 * трогаются — восстанавливать их после каждой красной проверки стоило бы
 * дороже самого сведения.
 */
export function resetToCommit(dir: string, sha: string): void {
  git(dir, ['reset', '--hard', sha]);
  git(dir, ['clean', '-fd']);
}

/** Закоммитить наложенную дорожку вместе с правкой очереди одним коммитом. */
export function commitAll(dir: string, message: string): void {
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-m', message]);
}
