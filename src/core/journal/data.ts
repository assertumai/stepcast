import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { StepcastError } from '../errors.js';
import { atomicWrite } from './writer.js';

/**
 * Данные работы — `jobs/<работа>/data.json` рядом с `resolved.json`.
 *
 * Работа публикует их по ходу исполнения командой `stepcast data`, а витрина
 * показывает подписью узла (`display`). Это не выход работы: выход
 * публикуется один раз, схемой и целиком, и его читают работы ниже по графу;
 * данные накапливаются по ходу, ключ за ключом, и их основной читатель —
 * человек, смотрящий на идущий прогон.
 *
 * Карта плоская, `Record<string, string>`. Вложенность здесь была бы
 * двусмысленной: в `${jobs.x.data.a.b}` не различить вложенный объект и ключ
 * с точкой, а пространство подстановки обязано быть одноуровневым. Поэтому же
 * и ключ ограничен: точка в имени ключа дала бы ту же неразличимость с
 * другой стороны.
 */

export const JOB_DATA_FILE = 'data.json';

/** Плоская карта опубликованных работой значений. */
export type JobData = Readonly<Record<string, string>>;

/**
 * Допустимый ключ: буквы, цифры, подчёркивание и дефис. Точка исключена
 * намеренно — см. пояснение к формату выше.
 */
const KEY = /^[A-Za-z0-9_-]+$/;

export function jobDataPath(jobDirPath: string): string {
  return join(jobDirPath, JOB_DATA_FILE);
}

export function assertDataKey(key: string): void {
  if (KEY.test(key)) return;
  throw new StepcastError(`Недопустимый ключ данных «${key}»`, {
    hint: 'Ключ — латинские буквы, цифры, подчёркивание и дефис; точка сделала бы ${jobs.<работа>.data.<ключ>} двусмысленным',
  });
}

/**
 * Прочитать данные работы. Отсутствующий, повреждённый или не соответствующий
 * форме файл даёт пустоту, а не отказ: данные — необязательная публикация, и
 * ронять из-за них прогон, витрину или соседнюю команду не за что. Значения
 * не той формы отбрасываются поштучно, а не вместе со всей картой.
 */
export function readJobData(jobDirPath: string): JobData {
  let raw: string;
  try {
    raw = readFileSync(jobDataPath(jobDirPath), 'utf8');
  } catch {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};

  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value === 'string' && KEY.test(key)) out[key] = value;
  }
  return out;
}

/**
 * Записать данные работы целиком. Запись атомарна: параллельные подпроцессы
 * одного шага иначе прочитали бы половину документа.
 */
export function writeJobData(jobDirPath: string, data: JobData): void {
  atomicWrite(jobDataPath(jobDirPath), `${JSON.stringify(data, null, 2)}\n`);
}

/**
 * Дописать значения поверх уже опубликованных. Последняя запись по ключу
 * побеждает; файл живёт на всю работу — все её шаги и все итерации цикла.
 */
export function mergeJobData(jobDirPath: string, patch: JobData): JobData {
  for (const key of Object.keys(patch)) assertDataKey(key);
  const next = { ...readJobData(jobDirPath), ...patch };
  writeJobData(jobDirPath, next);
  return next;
}
