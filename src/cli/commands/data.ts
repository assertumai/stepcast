import {
  assertDataKey,
  mergeJobData,
  readJobData,
  type JobData,
} from '../../core/journal/data.js';
import { ExitCode, StepcastError, type ExitCodeValue } from '../../core/errors.js';
import type { ParsedArgs } from '../args.js';

/**
 * `stepcast data set|merge|get` — публикация произвольных данных работой по
 * ходу её исполнения. Их показывает витрина подписью узла (`display`) и
 * читают работы ниже по графу подстановкой `${jobs.<работа>.data.<ключ>}`.
 *
 * Целевая работа выводится из `STEPCAST_JOB_DIR`, а не принимается
 * аргументом, и путей команда не принимает вовсе. Причин три, и все три —
 * свойства устройства, а не соглашения:
 *
 * - единственный писатель на файл: шаг пишет данные своей работы и ничьи
 *   больше, поэтому не может заставить граф врать о чужой;
 * - команда не может записать в рабочее дерево. Это важно: файл внутри
 *   рабочего дерева попал бы в `git add -A` при снятии якоря и вышел бы за
 *   границы `changed_only` — на этом умер реальный заход;
 * - вызов вне шага прогона отказывает внятно, вместо того чтобы завести
 *   каталог данных неизвестно где.
 *
 * `set` принимает два позиционных аргумента, а не пару `ключ:значение`:
 * значения содержат двоеточия штатно (заголовок пункта очереди — «Витрина:
 * расход деньгами и токенами…»), и разбор пары либо потерял бы хвост, либо
 * требовал экранирования на каждом вызове.
 */

const ACTIONS = ['set', 'merge', 'get'] as const;

function stringFlag(flags: ParsedArgs['flags'], name: string): string | undefined {
  const value = flags[name];
  return typeof value === 'string' ? value : undefined;
}

/** Каталог работы из окружения шага. Вне шага прогона команда не работает. */
function jobDirFromEnv(env: Readonly<Record<string, string | undefined>>): string {
  const dir = env.STEPCAST_JOB_DIR;
  if (dir === undefined || dir.trim() === '') {
    throw new StepcastError('Команда data работает только внутри шага прогона', {
      hint: 'Целевая работа берётся из переменной STEPCAST_JOB_DIR, которую движок инжектирует в каждый шаг; вне прогона писать некуда',
    });
  }
  return dir;
}

export function runDataCommand(
  args: ParsedArgs,
  write: (line: string) => void,
  env: Readonly<Record<string, string | undefined>> = process.env,
): ExitCodeValue {
  const [action, key, value] = args.positional;
  const dir = jobDirFromEnv(env);

  switch (action) {
    case 'set':
      return runSet(dir, key, value, write);
    case 'merge':
      return runMerge(args, dir, write);
    case 'get':
      return runGet(dir, key, write);
    default:
      throw new StepcastError(
        `неизвестное действие «${action ?? ''}» у команды data, ожидалось одно из ${ACTIONS.join(', ')}`,
      );
  }
}

function runSet(
  dir: string,
  key: string | undefined,
  value: string | undefined,
  write: (line: string) => void,
): ExitCodeValue {
  if (key === undefined) throw new StepcastError('set требует ключ первым позиционным аргументом');
  if (value === undefined) {
    throw new StepcastError('set требует значение вторым позиционным аргументом', {
      hint: 'Пустое значение объявляется явно: stepcast data set ключ ""',
    });
  }
  assertDataKey(key);
  mergeJobData(dir, { [key]: value });
  write(`${key}: ${value}`);
  return ExitCode.ok;
}

function runMerge(args: ParsedArgs, dir: string, write: (line: string) => void): ExitCodeValue {
  const raw = stringFlag(args.flags, 'json');
  if (raw === undefined) throw new StepcastError('merge требует ключа --json с объектом значений');

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new StepcastError(`ключ --json не разбирается как JSON: ${(error as Error).message}`, {
      cause: error,
    });
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new StepcastError('ключ --json требует объекта вида {"ключ": "значение"}');
  }

  const patch: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    assertDataKey(key);
    // Скаляр приводится к строке: карта плоская и строковая, а число из JSON
    // здесь встречается чаще, чем ошибка автора. Составное значение
    // отклоняется — вложенности в этом пространстве нет.
    if (typeof value === 'string') patch[key] = value;
    else if (typeof value === 'number' || typeof value === 'boolean') patch[key] = String(value);
    else {
      throw new StepcastError(`значение ключа «${key}» непредставимо строкой`, {
        hint: 'Данные работы — плоская карта строк: вложенный объект или список здесь не хранится',
      });
    }
  }

  const merged = mergeJobData(dir, patch);
  write(JSON.stringify(merged, null, 2));
  return ExitCode.ok;
}

function runGet(
  dir: string,
  key: string | undefined,
  write: (line: string) => void,
): ExitCodeValue {
  const data: JobData = readJobData(dir);
  if (key === undefined) {
    write(JSON.stringify(data, null, 2));
    return ExitCode.ok;
  }

  assertDataKey(key);
  const value = data[key];
  if (value === undefined) {
    throw new StepcastError(`Работа не публиковала данных по ключу «${key}»`, {
      hint:
        Object.keys(data).length === 0
          ? 'Работа не публиковала данных вовсе'
          : `Опубликованы: ${Object.keys(data).sort().join(', ')}`,
    });
  }
  write(value);
  return ExitCode.ok;
}
