import { existsSync, mkdirSync } from 'node:fs';
import { basename, join, relative, resolve as resolvePath } from 'node:path';

import {
  DEFAULT_STALE_HOURS,
  isFree,
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
import { resolveConfig } from '../../core/config/resolve.js';
import { mergeJobData } from '../../core/journal/data.js';
import { atomicWrite } from '../../core/journal/writer.js';
import { shortRunId } from '../../core/journal/paths.js';
import { ExitCode, StepcastError, type ExitCodeValue } from '../../core/errors.js';
import { readLaneItem, takenLanes } from '../../core/lanes/item.js';
import { commitPath, nestedRepoOf } from '../../core/lanes/tree.js';
import { commandRow, PIPELINE_SERVICES } from '../commandRow.js';
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
  writeErr: (line: string) => void,
): ExitCodeValue {
  const [action, slug] = args.positional;
  const file = resolvePath(cwd, stringFlag(args.flags, 'file') ?? 'backlog.md');

  switch (action) {
    case 'list':
      return runList(file, write);
    case 'pick':
      return runPick(args, file, cwd, write, writeErr);
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
  writeErr: (line: string) => void,
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

  // Названный пункт проверяется до отбора: «пункта нет» и «пункт занят» —
  // разные беды, и обе обязаны прозвучать словами. Молчаливая пустая выдача
  // на опечатку в слаге выглядела бы как «свободных пунктов нет».
  const only = stringFlag(args.flags, 'only');
  if (only !== undefined) {
    const named = entries.find((entry) => entry.slug === only);
    if (named === undefined) {
      throw new StepcastError(`пункт «${only}» в очереди не найден`, { file, at: only });
    }
    if (!isFree(named, nowMs, staleMs)) {
      throw new StepcastError(
        `пункт «${only}» не свободен: status ${named.data.status}`,
        { file, at: only, hint: 'свободны todo и зависший in_progress' },
      );
    }
  }

  const lanesOption = stringFlag(args.flags, 'lanes');
  if (lanesOption !== undefined) {
    // Формы выдачи не смешиваются: у `--lanes` число пунктов задаёт перечень
    // дорожек, и молча выбранная за вызывающего форма скрыла бы от него, что
    // одно из двух названных чисел не сработало.
    if (args.flags['slots'] !== undefined) {
      throw new StepcastError('ключи --lanes и --slots взаимно исключают друг друга: форма выдачи одна');
    }
    runPickLanes(args, file, cwd, text, entries, now, nowMs, staleMs, lanesOption, only, write, writeErr);
    return ExitCode.ok;
  }

  const slots = numberFlag(args.flags, 'slots') ?? 1;
  if (!Number.isInteger(slots) || slots <= 0) {
    throw new StepcastError('ключ --slots требует целого положительного числа');
  }

  const chosen = selectItems(entries, slots, nowMs, staleMs, only);
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
  only: string | undefined,
  write: (line: string) => void,
  writeErr: (line: string) => void,
): void {
  const lanes = parseLanes(lanesOption);
  // Относительный путь разрешается от того же рабочего каталога, что и
  // `--file`: команда обязана понимать все свои пути одинаково, а не брать
  // часть из них у процесса.
  const declaredRunDir = stringFlag(args.flags, 'run-dir');
  const runDir = declaredRunDir === undefined ? undefined : resolvePath(cwd, declaredRunDir);
  if (runDir !== undefined) prepareRunDir(runDir);

  const chosen = selectItems(entries, lanes.length, nowMs, staleMs, only);
  if (chosen.length > 0) writeBacklogFile(file, applyPick(text, chosen, now));

  const result: Record<string, unknown> = {};

  lanes.forEach((lane, index) => {
    const entry = chosen[index];
    if (entry === undefined) {
      result[lane] = { filled: false, slug: '', title: '', group: '', track: '', item: null };
      return;
    }
    const record: BacklogRecord = toRecord(entry);
    result[lane] = {
      filled: true,
      slug: record.slug,
      title: record.title,
      group: record.group,
      track: record.track,
      item: record,
    };
    if (runDir !== undefined) {
      atomicWrite(join(runDir, `item-${lane}.json`), `${JSON.stringify(record, null, 2)}\n`);
    }
  });

  publishPickedTitles(lanes, chosen, writeErr);
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
 *
 * Работа, не объявившая эти ключи, их не получит: `mergeJobData` отказывает,
 * и отказ не отменяет уже состоявшийся выбор — пункты в очереди уже помечены.
 * Молчание здесь, однако, не заведено: агент, вызвавший `backlog pick` внутри
 * чужой работы на пробу, — главный адресат объяснения, почему подписи нет.
 */
function publishPickedTitles(
  lanes: readonly string[],
  chosen: readonly BacklogEntry[],
  writeErr: (line: string) => void,
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
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    writeErr(`backlog pick: подпись выбора не опубликована: ${detail}`);
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

  if (settled === 0) {
    write('все взятые пункты уже свели свой исход — проставлять нечего');
    return ExitCode.ok;
  }

  // Коммит адресован файлу очереди в том репозитории, где он лежит — не
  // индексу целиком: settle отвечает за очередь и не подметает в коммит чужие
  // правки дерева (design.md, решение 8). Отметка исхода дорожки обязана
  // пережить восстановление дерева — незакоммиченной она пропадает при первом
  // же resume.
  const { config } = resolveConfig({ cwd });
  const relDir = nestedRepoOf(cwd, config.project.nestedRepos ?? [], file);
  const repoDir = relDir === undefined ? cwd : join(cwd, relDir);
  const relPath = relative(repoDir, file);
  const message = `backlog: исходы дорожек прогона ${shortRunId(basename(runDir))}`;
  const committed = commitPath(repoDir, relPath, message);
  write(
    committed
      ? `правка очереди закоммичена в ${relDir ?? '.'}`
      : 'правка очереди не закоммичена: файл не отслеживается репозиторием или лежит вне его',
  );

  return ExitCode.ok;
}

export const row = commandRow(
  {
    name: 'backlog',
    spec: {
      description: 'вести очередь улучшений backlog.md: list|pick|finish|settle, см. docs/backlog.md',
      positional: ['action', 'slug'],
      flags: {
        file: { kind: 'string', description: 'путь к файлу очереди, по умолчанию backlog.md в рабочем каталоге' },
        slots: { kind: 'number', description: 'pick: сколько пунктов взять за раз, по умолчанию 1' },
        lanes: { kind: 'string', description: 'pick: раздать по дорожкам, имена через запятую — a,b' },
        only: {
          kind: 'string',
          description: 'pick: взять именно этот пункт по слагу, а не первый свободный по очерёдности',
        },
        'stale-hours': {
          kind: 'number',
          description: 'pick: порог давности зависшего in_progress в часах, по умолчанию 6',
        },
        'run-dir': {
          kind: 'string',
          description:
            'pick --lanes: каталог для файлов item-<дорожка>.json на каждую заполненную дорожку; settle: тот же каталог, обязателен',
        },
        status: { kind: 'string', description: 'finish: исход done либо failed' },
        reason: { kind: 'string', description: 'finish --status failed: причина отказа' },
      },
    },
    run: (args, io, env) => runBacklogCommand(args, io.out, env.cwd, io.err),
  },
  { inject: PIPELINE_SERVICES },
);
