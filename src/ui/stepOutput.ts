import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { findStepDir, isRunAlive } from '../core/journal/reader.js';
import type { RunPaths } from '../core/journal/paths.js';
import { MAX_FILE_BYTES, trimPartialUtf8 } from './file.js';

/**
 * Вывод шага по логическому адресу: прогон, работа, шаг, попытка, смещение.
 *
 * Путь файла разрешается здесь на каждый запрос, а не берётся из снимка
 * прогона (design.md, Решение 1): пока шаг идёт, снимок не пересобирается, и
 * у шага, начавшего писать после последнего события `run`, пути в витрине
 * иначе не было бы вовсе — до самого конца шага. Чтение остаётся чтением:
 * модуль ничего не пишет на диск.
 */

export interface StepOutputQuery {
  /** Номер попытки; без него берётся наибольшая существующая. */
  readonly attempt?: number;
  /** Присутствие поля — сама просьба прочитать поток; смещение — 0 для первого чтения. */
  readonly stdoutOffset?: number;
  readonly stderrOffset?: number;
}

export interface StreamChunk {
  readonly exists: boolean;
  readonly content: string;
  /** Размер файла на момент чтения. */
  readonly bytes: number;
  /** Новое смещение: столько байт уже прочитано и учтено вызывающей стороной. */
  readonly offset: number;
  /** Кусок отдан с конца — запрос с нулевого смещения упёрся в потолок. */
  readonly truncated: boolean;
  readonly truncatedFrom?: number;
  /** Файл усечён или заменён — запрошенное смещение больше текущего размера. */
  readonly restarted: boolean;
}

export interface StepOutputResult {
  /** Попытки, чьи файлы вывода есть на диске, по возрастанию. Пусто — каталога шага нет. */
  readonly attempts: readonly number[];
  readonly attempt?: number;
  /**
   * Дописывать больше нечего: шаг уже не пишет — его запись легла в каталог
   * шага, запрошена не последняя попытка либо прогон не жив (design.md,
   * Решение 5), — и всё написанное уже отдано. Непрочитанный остаток
   * признака не даёт: витрина прекращает опрос по нему, и хвост вывода,
   * оставшийся за потолком ответа, иначе не дошёл бы до читателя вовсе.
   */
  readonly done: boolean;
  readonly stdout?: StreamChunk;
  readonly stderr?: StreamChunk;
}

/**
 * Файл попытки — любая сторона вывода. Только `stdout*.log` мало: у шага,
 * чей процесс не запустился, на диске может остаться один `stderr.log`, и
 * перечень попыток по одному `stdout` объявил бы такой шаг ничего не
 * написавшим, спрятав ровно то, что объясняет отказ.
 */
const ATTEMPT_FILE = /^(?:stdout|stderr)(?:\.(\d+))?\.log$/;

/** Суффикс имени файла попытки — тот же приём, что в `agentStep.ts`/`runStep.ts`. */
function attemptSuffix(attempt: number): string {
  return attempt === 1 ? '' : `.${attempt}`;
}

function listAttempts(dir: string): number[] {
  // Множество, а не список: у попытки два файла, и оба называют её номер.
  const attempts = new Set<number>();
  for (const name of readdirSync(dir)) {
    const match = ATTEMPT_FILE.exec(name);
    if (match === null) continue;
    attempts.add(match[1] === undefined ? 1 : Number(match[1]));
  }
  return [...attempts].sort((a, b) => a - b);
}

/**
 * Шаг дописал своё: его запись легла в каталог шага.
 *
 * Именно в каталог, а не в `status.json`: запись работы в состоянии прогона
 * знает шаг только по идентификатору и не различает итераций цикла, а
 * `runJobSteps` набирает список шагов заново на каждой итерации. У работы с
 * `until` во время первого шага второй итерации в `status.json` лежит
 * одноимённый шаг первой — и вывод идущего шага объявлялся бы завершённым, а
 * витрина показывала бы его обрезок как окончательный. Каталог шага у каждой
 * итерации свой, и `step.json` пишется в него по завершении шага
 * (`runner.ts`), то есть отвечает ровно на заданный вопрос.
 */
function isStepFinished(dir: string): boolean {
  return existsSync(join(dir, 'step.json'));
}

function readSlice(path: string, start: number, length: number): Buffer {
  const buffer = Buffer.alloc(length);
  const handle = openSync(path, 'r');
  try {
    const read = readSync(handle, buffer, 0, length, start);
    return read === length ? buffer : buffer.subarray(0, read);
  } finally {
    closeSync(handle);
  }
}

/**
 * Прочитать дописанное после смещения.
 *
 * Три случая, не считая обычного чтения. Смещение больше размера — файл
 * усечён или заменён, начинаем сначала (тот же приём, что `follow()` в
 * `journal/reader.ts`), помечая это признаком `restarted`, чтобы витрина
 * сбросила накопленное, а не показала его склеенным с новым содержимым.
 * Нулевое смещение на файле крупнее потолка — как в `readJournalFile`: отдаём
 * конец, называя, откуда он начат. Дописанное сверх потолка отдаётся не
 * целиком, а первым куском в потолок: смещение приходит параметром запроса, и
 * без этого предела `stdoutOffset=1` на многогигабайтном логе заставил бы
 * демона выделить весь остаток файла разом. Остаток дочитывается следующими
 * запросами от нового смещения, поэтому в выводе не появляется дыры.
 *
 * Оба края окна выравниваются по границе символа UTF-8. Край в начале — от
 * усечения, край в конце — от того, что файл пишут прямо сейчас: последний
 * символ может быть дописан не целиком, и прочитать его надо следующим
 * запросом, а не превратить в `�` и объявить прочитанным.
 */
function readAppended(path: string, requestedOffset: number): StreamChunk {
  if (!existsSync(path)) {
    return { exists: false, content: '', bytes: 0, offset: 0, truncated: false, restarted: false };
  }

  const bytes = statSync(path).size;

  if (requestedOffset > bytes) {
    return { ...readAppended(path, 0), restarted: true };
  }

  if (requestedOffset === 0 && bytes > MAX_FILE_BYTES) {
    const start = bytes - MAX_FILE_BYTES;
    const window = readSlice(path, start, MAX_FILE_BYTES);
    const fromStart = trimPartialUtf8(window, 'tail');
    const shown = trimPartialUtf8(fromStart, 'head');
    const begin = start + (window.length - fromStart.length);
    return {
      exists: true,
      content: shown.toString('utf8'),
      bytes,
      offset: begin + shown.length,
      truncated: true,
      truncatedFrom: begin,
      restarted: false,
    };
  }

  const length = Math.min(bytes - requestedOffset, MAX_FILE_BYTES);
  if (length <= 0) {
    return { exists: true, content: '', bytes, offset: requestedOffset, truncated: false, restarted: false };
  }

  const trimmed = trimPartialUtf8(readSlice(path, requestedOffset, length), 'head');
  return {
    exists: true,
    content: trimmed.toString('utf8'),
    bytes,
    offset: requestedOffset + trimmed.length,
    truncated: false,
    restarted: false,
  };
}

export function readStepOutput(
  paths: RunPaths,
  jobId: string,
  stepId: string,
  query: StepOutputQuery = {},
): StepOutputResult {
  const dir = findStepDir(paths, jobId, stepId);
  if (dir === undefined) return { attempts: [], done: !isRunAlive(paths) };

  const attempts = listAttempts(dir);
  if (attempts.length === 0) return { attempts: [], done: !isRunAlive(paths) };

  const lastAttempt = attempts.at(-1) as number;
  const attempt =
    query.attempt !== undefined && attempts.includes(query.attempt) ? query.attempt : lastAttempt;
  const suffix = attemptSuffix(attempt);

  const stdout =
    query.stdoutOffset === undefined
      ? undefined
      : readAppended(join(dir, `stdout${suffix}.log`), query.stdoutOffset);
  const stderr =
    query.stderrOffset === undefined
      ? undefined
      : readAppended(join(dir, `stderr${suffix}.log`), query.stderrOffset);

  const writing = !isStepFinished(dir) && attempt === lastAttempt && isRunAlive(paths);
  const unread = (chunk: StreamChunk | undefined): boolean =>
    chunk !== undefined && chunk.offset < chunk.bytes;

  return {
    attempts,
    attempt,
    done: !writing && !unread(stdout) && !unread(stderr),
    ...(stdout === undefined ? {} : { stdout }),
    ...(stderr === undefined ? {} : { stderr }),
  };
}
