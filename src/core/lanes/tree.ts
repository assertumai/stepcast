import { execFileSync } from 'node:child_process';

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

/**
 * Дерево запуска обязано быть репозиторием git без незакоммиченных и
 * неотслеживаемых изменений — откат красной проверки стирает и то, и другое,
 * и команда не вправе полагаться на то, что чистоту проверил кто-то до неё.
 */
export function assertCleanTree(dir: string): void {
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
  if (status.trim() !== '') {
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
