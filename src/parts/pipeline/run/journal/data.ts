import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { StepcastError } from '../../../../kernel/errors.js';
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

/**
 * Раскрытое определение работы — `resolved.json`, которое движок кладёт в
 * каталог работы до первого шага (см. `run/runner.ts`). Разбор здесь
 * структурный, а не через модель пайплайна: импорт модели завёл бы кольцо
 * зависимостей (`pipeline/expand.ts` уже опирается на этот модуль ради
 * `assertDataKey`), а нужен от документа один-единственный список строк.
 */
const RESOLVED_FILE = 'resolved.json';

/**
 * Объявление, прочитанное из `resolved.json`: имя работы и её состав данных.
 *
 * `found: false` — определения нет или оно не читается. Обе беды ведут к
 * отказу записи, но объясняются по-разному: «работа честно ничего не
 * объявляет» — это её определение, а «определения не нашлось» — дефект
 * каталога прогона, и советовать по нему правку пайплайна не за что.
 */
interface JobDeclaration {
  readonly found: boolean;
  readonly jobId: string | undefined;
  readonly data: readonly string[];
}

/**
 * Объявление работы — из `resolved.json` рядом с файлом данных. Отсутствующий,
 * нечитаемый или не несущий списка строк документ даёт пустое объявление:
 * fail closed здесь того же происхождения, что и в `mergeJobData` —
 * молчаливо расширять права записи не на чем.
 */
function readJobDeclaration(jobDirPath: string): JobDeclaration {
  const missing: JobDeclaration = { found: false, jobId: undefined, data: [] };

  let raw: string;
  try {
    raw = readFileSync(join(jobDirPath, RESOLVED_FILE), 'utf8');
  } catch {
    return missing;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return missing;
  }

  if (typeof parsed !== 'object' || parsed === null) return missing;
  const record = parsed as Record<string, unknown>;
  const jobId = typeof record.id === 'string' ? record.id : undefined;
  const data = Array.isArray(record.data)
    ? record.data.filter((item): item is string => typeof item === 'string')
    : [];
  return { found: true, jobId, data };
}

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
 * Записать данные работы целиком, минуя объявление. Запись атомарна:
 * параллельные подпроцессы одного шага иначе прочитали бы половину документа.
 *
 * Имя говорит, что делает: это низкоуровневый писатель движка, и объявление
 * работы он не сверяет. Публикация от имени шага идёт только через
 * `mergeJobData` — единственный путь, которым пишут команды (`stepcast data`,
 * `backlog pick`); прямой вызов отсюда законен лишь там, где состав уже
 * отобран по объявлению самим движком (перенос данных при возобновлении).
 * Отдельное имя здесь и есть защита: новый писатель не возьмёт эту функцию по
 * невнимательности, а взяв — объявляет обход в самом вызове.
 */
export function writeJobDataUnchecked(jobDirPath: string, data: JobData): void {
  atomicWrite(jobDataPath(jobDirPath), `${JSON.stringify(data, null, 2)}\n`);
}

/**
 * Дописать значения поверх уже опубликованных. Последняя запись по ключу
 * побеждает; файл живёт на всю работу — все её шаги и все итерации цикла.
 *
 * Запись ограничена объявлением работы (design.md, решение 3): необъявленный
 * ключ отказывает раньше, чем коснулся файла, — публикация мимо объявления
 * ничем не отличима от случайного вызова агента на пробу, а отличать их и
 * есть весь смысл объявления.
 */
export function mergeJobData(jobDirPath: string, patch: JobData): JobData {
  for (const key of Object.keys(patch)) assertDataKey(key);

  const { found, jobId, data: declared } = readJobDeclaration(jobDirPath);
  const declaredSet = new Set(declared);
  const subject = jobId === undefined ? 'Работа' : `Работа ${jobId}`;
  for (const key of Object.keys(patch)) {
    if (declaredSet.has(key)) continue;

    // Определения не нашлось — это другая поломка, и говорить о ней надо
    // по-другому: объявления здесь не «пустое», а неизвестное, и правка
    // пайплайна ничего не исправит, пока движок не кладёт файл на место.
    if (!found) {
      throw new StepcastError(
        `Раскрытого определения работы нет — записать ключ данных «${key}» не с чем`,
        {
          hint: `Ожидался ${join(jobDirPath, RESOLVED_FILE)}: его кладёт движок перед первым шагом работы, и по нему сверяется объявленный состав данных`,
        },
      );
    }

    throw new StepcastError(`${subject} не объявляла ключ данных «${key}»`, {
      hint:
        declared.length === 0
          ? `${subject} не объявляет ни одного ключа данных — добавьте data: [...] в её определение`
          : `Объявлены: ${declared.join(', ')}`,
    });
  }

  const next = { ...readJobData(jobDirPath), ...patch };
  writeJobDataUnchecked(jobDirPath, next);
  return next;
}
