import { chmodSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';

import {
  DEFAULT_STALE_HOURS,
  parse,
  selectItems,
  toRecord,
  withFields,
  type BacklogEntry,
  type BacklogRecord,
} from '../../core/backlog/index.js';
import { atomicWrite } from '../../core/journal/writer.js';
import { ExitCode, StepcastError, isStepcastError, type ExitCodeValue } from '../../core/errors.js';
import type { ParsedArgs } from '../args.js';

/**
 * `stepcast backlog list|pick|finish` — очередь улучшений, не зависящая от
 * устройства проекта: ни конфигурация, ни `.stepcast/`, ни каталог прогона ей
 * не нужны, только путь к файлу очереди. Подкоманда разбирается первым
 * позиционным аргументом самой командой: `parseArgs` вложенных команд не
 * заводит.
 */

const KEBAB_CASE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ACTIONS = ['list', 'pick', 'finish'] as const;

/**
 * Длина причины отказа, после которой она урезается.
 *
 * Причина приходит целым куском чужого вывода — `finalize.mjs` собирает её из
 * `stderr` красной проверки, — и в очередь, которую читает человек, такой
 * кусок целиком не нужен: полный текст остаётся в логе шага и в
 * `merge-<дорожка>.json` того же прогона.
 */
const REASON_LIMIT = 500;

function stringFlag(flags: ParsedArgs['flags'], name: string): string | undefined {
  const value = flags[name];
  return typeof value === 'string' ? value : undefined;
}

function numberFlag(flags: ParsedArgs['flags'], name: string): number | undefined {
  const value = flags[name];
  return typeof value === 'number' ? value : undefined;
}

function readBacklogFile(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new StepcastError(
      code === 'ENOENT'
        ? `Файл очереди не найден: ${path}`
        : `Не удалось прочитать файл очереди: ${(error as Error).message}`,
      { file: path, cause: error },
    );
  }
}

/** Разбор с приложенным путём: ядро само о файле ничего не знает. */
function parseBacklogFile(path: string, text: string): readonly BacklogEntry[] {
  try {
    return parse(text);
  } catch (error) {
    if (!isStepcastError(error)) throw error;
    throw new StepcastError(error.message, {
      file: path,
      ...(error.at === undefined ? {} : { at: error.at }),
      ...(error.hint === undefined ? {} : { hint: error.hint }),
      cause: error,
    });
  }
}

/**
 * Записать файл очереди, сохранив его исходный режим доступа.
 *
 * `atomicWrite` подменяет файл переименованием временного — временный
 * создаётся заново с режимом `0o600`, и без восстановления первый же `pick`
 * сузил бы права `backlog.md` вопреки тому, что было в рабочем дереве.
 */
function writeBacklogFile(path: string, content: string): void {
  let mode: number | undefined;
  try {
    mode = statSync(path).mode;
  } catch {
    mode = undefined;
  }
  atomicWrite(path, content);
  if (mode !== undefined) chmodSync(path, mode & 0o777);
}

/**
 * Свести чужой текст к одной строке: поле очереди однострочно, и ядро
 * значение с переводом строки отвергает (`withFields`). Сведение делается
 * здесь, на границе команды, а не в ядре: без него бухгалтерия петли
 * отказывала бы ровно в том случае, ради которого заведена, — причина
 * `check_failed` собирается из многострочного `stderr` красной проверки.
 */
function oneLine(value: string): string {
  const flat = value.replace(/\s+/gu, ' ').trim();
  return flat.length <= REASON_LIMIT ? flat : `${flat.slice(0, REASON_LIMIT - 1)}…`;
}

/**
 * Каталог дорожек готовится до правки очереди.
 *
 * Порядок здесь существенный: помеченный `in_progress` пункт, чей
 * `item-<дорожка>.json` не записался, сведение не найдёт и исход ему никто не
 * проставит — он провисит до порога давности. Отказ обязан случиться раньше,
 * чем очередь тронута.
 */
function prepareRunDir(path: string): void {
  try {
    mkdirSync(path, { recursive: true });
  } catch (error) {
    throw new StepcastError(
      `Не удалось подготовить каталог дорожек ${path}: ${(error as Error).message}`,
      { file: path, cause: error },
    );
  }
}

function parseLanes(raw: string): readonly string[] {
  const lanes = raw.split(',').map((entry) => entry.trim());
  if (lanes.length === 0 || lanes.some((lane) => lane === '')) {
    throw new StepcastError('ключ --lanes требует непустого перечня имён через запятую');
  }
  for (const lane of lanes) {
    if (!KEBAB_CASE.test(lane)) {
      throw new StepcastError(`имя дорожки «${lane}» не является слагом в kebab-case`);
    }
  }
  if (new Set(lanes).size !== lanes.length) {
    throw new StepcastError('имена дорожек должны быть попарно различны');
  }
  return lanes;
}

export function runBacklogCommand(
  args: ParsedArgs,
  write: (line: string) => void,
  cwd: string,
): ExitCodeValue {
  const [action, slug] = args.positional;
  const file = resolvePath(cwd, stringFlag(args.flags, 'file') ?? 'backlog.md');

  switch (action) {
    case 'list':
      return runList(file, write);
    case 'pick':
      return runPick(args, file, cwd, write);
    case 'finish':
      return runFinish(args, slug, file);
    default:
      throw new StepcastError(
        `неизвестное действие «${action ?? ''}» у команды backlog, ожидалось одно из ${ACTIONS.join(', ')}`,
      );
  }
}

function runList(file: string, write: (line: string) => void): ExitCodeValue {
  const entries = parseBacklogFile(file, readBacklogFile(file));
  write(JSON.stringify(entries.map(toRecord), null, 2));
  return ExitCode.ok;
}

function runPick(
  args: ParsedArgs,
  file: string,
  cwd: string,
  write: (line: string) => void,
): ExitCodeValue {
  const staleHours = numberFlag(args.flags, 'stale-hours') ?? DEFAULT_STALE_HOURS;
  if (!Number.isFinite(staleHours) || staleHours <= 0) {
    throw new StepcastError('ключ --stale-hours требует положительного числа');
  }
  const staleMs = staleHours * 3600_000;

  const now = new Date().toISOString();
  const nowMs = Date.parse(now);

  const text = readBacklogFile(file);
  const entries = parseBacklogFile(file, text);

  const lanesOption = stringFlag(args.flags, 'lanes');
  if (lanesOption !== undefined) {
    // Формы выдачи не смешиваются: у `--lanes` число пунктов задаёт перечень
    // дорожек, и молча выбранная за вызывающего форма скрыла бы от него, что
    // одно из двух названных чисел не сработало.
    if (args.flags['slots'] !== undefined) {
      throw new StepcastError('ключи --lanes и --slots взаимно исключают друг друга: форма выдачи одна');
    }
    runPickLanes(args, file, cwd, text, entries, now, nowMs, staleMs, lanesOption, write);
    return ExitCode.ok;
  }

  const slots = numberFlag(args.flags, 'slots') ?? 1;
  if (!Number.isInteger(slots) || slots <= 0) {
    throw new StepcastError('ключ --slots требует целого положительного числа');
  }

  const chosen = selectItems(entries, slots, nowMs, staleMs);
  if (chosen.length > 0) writeBacklogFile(file, applyPick(text, chosen, now));

  write(JSON.stringify(chosen.map(toRecord), null, 2));
  return ExitCode.ok;
}

function runPickLanes(
  args: ParsedArgs,
  file: string,
  cwd: string,
  text: string,
  entries: readonly BacklogEntry[],
  now: string,
  nowMs: number,
  staleMs: number,
  lanesOption: string,
  write: (line: string) => void,
): void {
  const lanes = parseLanes(lanesOption);
  // Относительный путь разрешается от того же рабочего каталога, что и
  // `--file`: команда обязана понимать все свои пути одинаково, а не брать
  // часть из них у процесса.
  const declaredRunDir = stringFlag(args.flags, 'run-dir');
  const runDir = declaredRunDir === undefined ? undefined : resolvePath(cwd, declaredRunDir);
  if (runDir !== undefined) prepareRunDir(runDir);

  const chosen = selectItems(entries, lanes.length, nowMs, staleMs);
  if (chosen.length > 0) writeBacklogFile(file, applyPick(text, chosen, now));

  const result: Record<string, unknown> = {};

  lanes.forEach((lane, index) => {
    const entry = chosen[index];
    if (entry === undefined) {
      result[lane] = { filled: false, slug: '', title: '', group: '', item: null };
      return;
    }
    const record: BacklogRecord = toRecord(entry);
    result[lane] = { filled: true, slug: record.slug, title: record.title, group: record.group, item: record };
    if (runDir !== undefined) {
      atomicWrite(join(runDir, `item-${lane}.json`), `${JSON.stringify(record, null, 2)}\n`);
    }
  });

  write(JSON.stringify({ lanes: result }, null, 2));
}

/** Проставить `status: in_progress` и общую метку `started_at` выбранным пунктам. */
function applyPick(text: string, chosen: readonly BacklogEntry[], now: string): string {
  let result = text;
  for (const entry of chosen) {
    result = withFields(result, entry.slug, { status: 'in_progress', started_at: now });
  }
  return result;
}

function runFinish(args: ParsedArgs, slug: string | undefined, file: string): ExitCodeValue {
  if (slug === undefined) {
    throw new StepcastError('finish требует слаг пункта первым позиционным аргументом');
  }

  const status = stringFlag(args.flags, 'status');
  if (status !== 'done' && status !== 'failed') {
    throw new StepcastError('ключ --status требует значения done либо failed');
  }

  const reason = stringFlag(args.flags, 'reason');
  if (status === 'failed' && (reason === undefined || reason.trim() === '')) {
    throw new StepcastError('исход failed требует ключа --reason с причиной');
  }

  const text = readBacklogFile(file);
  const entries = parseBacklogFile(file, text);
  const entry = entries.find((candidate) => candidate.slug === slug);
  if (entry === undefined) {
    throw new StepcastError(`пункт «${slug}» в очереди не найден`, { file, at: slug });
  }

  // Исход, уже проставленный, не переписывается: повторный finish (например,
  // после отказа сети) не должен состязаться за последнее слово — первый
  // проставленный исход и есть окончательный.
  if (entry.data.status === 'done' || entry.data.status === 'failed') return ExitCode.ok;

  const values = status === 'failed' ? { status, reason: oneLine(reason as string) } : { status };
  writeBacklogFile(file, withFields(text, slug, values));
  return ExitCode.ok;
}
