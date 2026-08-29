import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';

import {
  DEFAULT_STALE_HOURS,
  finishItem,
  parseBacklogFile,
  readBacklogFile,
  selectItems,
  toRecord,
  withFields,
  writeBacklogFile,
  type BacklogEntry,
  type BacklogRecord,
} from '../../core/backlog/index.js';
import { mergeJobData } from '../../core/journal/data.js';
import { atomicWrite } from '../../core/journal/writer.js';
import { ExitCode, StepcastError, type ExitCodeValue } from '../../core/errors.js';
import { readLaneItem, takenLanes } from '../../core/lanes/item.js';
import type { ParsedArgs } from '../args.js';

/**
 * `stepcast backlog list|pick|finish` — очередь улучшений, не зависящая от
 * устройства проекта: ни конфигурация, ни `.stepcast/`, ни каталог прогона ей
 * не нужны, только путь к файлу очереди. Подкоманда разбирается первым
 * позиционным аргументом самой командой: `parseArgs` вложенных команд не
 * заводит.
 */

const KEBAB_CASE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ACTIONS = ['list', 'pick', 'finish', 'settle'] as const;

/** Единая причина `settle`: различимые причины несведения проставляет само сведение дорожек. */
const SETTLE_REASON = 'заход до сведения дорожки не дошёл';

function stringFlag(flags: ParsedArgs['flags'], name: string): string | undefined {
  const value = flags[name];
  return typeof value === 'string' ? value : undefined;
}

function numberFlag(flags: ParsedArgs['flags'], name: string): number | undefined {
  const value = flags[name];
  return typeof value === 'number' ? value : undefined;
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
    case 'settle':
      return runSettle(args, file, cwd, write);
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

  publishPickedTitles(lanes, chosen);
  write(JSON.stringify({ lanes: result }, null, 2));
}

/**
 * Опубликовать выбранные пункты данными работы — тем же вызовом, что и выбор.
 *
 * Отдельного шага для этого не заводится: `pick` уже знает выбранный пункт, и
 * выковыривать значение из JSON в командной строке ради того же результата
 * значило бы платить вторым процессом за то, что здесь уже в руках.
 *
 * Пишется, только когда команда исполняется внутри шага прогона: вне его
 * `STEPCAST_JOB_DIR` нет, и публиковать некуда — но и отказывать не за что,
 * `backlog pick` остаётся командой, работающей без прогона.
 *
 * Для нескольких дорожек заголовок и слаг пишутся по ключу на дорожку
 * (`title-a`, `slug-a`), а `title` без суффикса склеивается из заполненных
 * дорожек. Склейка — потому что подпись узла одна: узел `slots` в графе один
 * на все дорожки, и выбрать «какую из двух дорожек показать» нечем. Ключи с
 * суффиксом — потому что склеенная строка не разбирается обратно, а
 * потребителю, которому нужна одна дорожка, нужна именно она.
 */
function publishPickedTitles(
  lanes: readonly string[],
  chosen: readonly BacklogEntry[],
): void {
  const jobDir = process.env.STEPCAST_JOB_DIR;
  if (jobDir === undefined || jobDir.trim() === '') return;

  const patch: Record<string, string> = {};
  const titles: string[] = [];

  lanes.forEach((lane, index) => {
    const entry = chosen[index];
    if (entry === undefined) return;
    const record = toRecord(entry);
    patch[`slug-${lane}`] = record.slug;
    patch[`title-${lane}`] = record.title;
    titles.push(record.title);
  });

  patch['title'] = titles.length === 0 ? 'свободных пунктов нет' : `Выбрано: ${titles.join('; ')}`;

  // Отказ публикации не отменяет выбор: пункты уже помечены в очереди, и
  // уронить команду из-за подписи значило бы потерять сделанную работу.
  try {
    mergeJobData(jobDir, patch);
  } catch {
    // Данные — необязательная публикация; молчание здесь намеренное.
  }
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

  // Чтение, сведение причины к одной строке и неприкосновенность уже
  // проставленного исхода — забота `core/backlog/file.ts`: тем же кодом
  // проставляет исход и сведение дорожек.
  finishItem(file, slug, status, reason);
  return ExitCode.ok;
}

/**
 * `backlog settle` — закрытие захода: каждому пункту, взятому в прогон
 * (файлы `item-<дорожка>.json` каталога прогона, см. `core/lanes/item.ts`) и
 * оставшемуся без исхода, проставляется `failed` с единой причиной.
 * Различимые причины несведения — забота `stepcast merge-lanes`; `settle`
 * закрывает ровно тот случай, когда до неё дело не дошло вовсе.
 */
function runSettle(
  args: ParsedArgs,
  file: string,
  cwd: string,
  write: (line: string) => void,
): ExitCodeValue {
  const runDirFlag = stringFlag(args.flags, 'run-dir');
  if (runDirFlag === undefined) {
    throw new StepcastError('ключ --run-dir обязателен для settle');
  }
  const runDir = resolvePath(cwd, runDirFlag);
  if (!existsSync(runDir)) {
    throw new StepcastError(`каталог прогона не найден: ${runDir}`, { file: runDir });
  }

  const lanes = takenLanes(runDir);
  if (lanes.length === 0) {
    write('пункты очереди не брались — проставлять нечего');
    return ExitCode.ok;
  }

  let settled = 0;

  for (const lane of lanes) {
    const item = readLaneItem(runDir, lane);
    // Пункт с уже проставленным исходом `finishItem` не трогает: settle
    // закрывает заход, а не переписывает его результат.
    if (finishItem(file, item.slug, 'failed', SETTLE_REASON) === 'already-final') continue;
    settled += 1;
    write(`пункт «${item.slug}» (дорожка ${lane}) помечен failed: ${SETTLE_REASON}`);
  }

  if (settled === 0) write('все взятые пункты уже свели свой исход — проставлять нечего');
  return ExitCode.ok;
}
