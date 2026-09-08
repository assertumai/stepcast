import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { existsSync } from 'node:fs';

import { runPaths } from '../core/journal/paths.js';
import { isRunAlive } from '../core/journal/reader.js';
import {
  removeRunWithStats,
  removeRuns,
  selectByAddresses,
  selectCandidates,
  type AddressedCandidate,
  type RunAddress,
  type SelectTraits,
  type StatsDisposition,
} from '../core/run/cleanup.js';
import {
  backfillUsageStore,
  catchUpUsageRecords,
  catchUpUsageStore,
  readUsageStore,
  removeUsageRecords,
  selectUsageRecords,
  type UsageRecordSelectTraits,
} from '../core/journal/usageStore.js';
import { isStepcastError } from '../core/errors.js';
import { parseDuration } from '../core/units.js';
import type { Config } from '../core/config/resolve.js';
import { dashboardHtml } from './assets.js';
import type { BacklogOverview } from './backlog.js';
import { readJournalFile } from './file.js';
import { buildPipelines, createRegistryCache, type RegistryCache } from './pipelines.js';
import { isApiPath, isSafeSegment } from './routes.js';
import { readSettings, writeSettings, type SettingsPatch } from './settings.js';
import { buildSnapshot, buildSnapshotFromRecord } from './snapshot.js';
import { readStepOutput } from './stepOutput.js';
import { MAX_USAGE_DAYS, buildUsage } from './usage.js';
import { createWatcher, type Watcher } from './watcher.js';

/**
 * HTTP-витрина журнала.
 *
 * Только петля: сервер, доступный всей сети, — грубый случай, которого здесь
 * быть не должно. Чтение журнала остаётся чтением: демон по-прежнему не пишет
 * в файлы прогонов. Записи ровно две, и обе — прямые действия пользователя,
 * а не наблюдение: удалить прогон из истории и записать дефолты в глобальную
 * конфигурацию. Всё остальное под запретом.
 */

/** Петлевой адрес: слушать `0.0.0.0` витрине незачем. */
export const LOOPBACK = '127.0.0.1';

/** Потолок тела запроса: витрина принимает настройки, а не файлы. */
const MAX_BODY_BYTES = 64 * 1024;

/** Потолок числа адресов в групповом удалении: список сверх него — ошибка, не частичная работа. */
const MAX_RUN_ADDRESSES = 500;

const KNOWN_TRAITS = new Set(['abandoned', 'failed']);

export interface UiServerOptions {
  readonly runsRoot: string;
  readonly port: number;
  readonly watcher?: Watcher;
  /**
   * Конфигурация для разбора пайплайнов. Без неё экран пайплайнов пуст:
   * раскрытие пайплайна опирается на умолчания конфигурации.
   */
  readonly config?: Config;
  /** Домашний каталог: определяет, какой глобальный конфиг правят настройки. */
  readonly home?: string;
  /**
   * Файл собранной витрины. По умолчанию — артефакт сборки рядом с кодом
   * (`dist/ui-web/index.html`). Переопределение нужно проверке отказа
   * несобранной витрины: без него она вынуждена удалять настоящий артефакт с
   * диска, то есть портить рабочее дерево ради одного сценария.
   */
  readonly dashboardFile?: string;
  /** Куда наблюдатель печатает отказ разбора файла журнала. См. `WatcherOptions.log`. */
  readonly log?: (line: string) => void;
}

export interface UiServer {
  readonly server: Server;
  readonly port: number;
  close(): Promise<void>;
}

function sendJson(res: ServerResponse, code: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    // Витрина отдаёт живые данные: закешированный обзор хуже, чем никакого.
    'cache-control': 'no-store',
  });
  res.end(text);
}

/** Адрес прогона в API — `<projectKey>/<runId>`: принадлежность проекту часть адреса. */
function parseRunAddress(value: string | null): { key: string; runId: string } | undefined {
  if (value === null) return undefined;
  const parts = value.split('/').filter((part) => part !== '');
  if (parts.length !== 2) return undefined;
  const [key, runId] = parts as [string, string];
  if (!isSafeSegment(key) || !isSafeSegment(runId)) return undefined;
  return { key, runId };
}

/**
 * Запрос на изменение пришёл со своей же страницы.
 *
 * Петлевой порт открыт любой странице, которую откроет браузер пользователя:
 * без этой проверки чужой сайт мог бы фоновым запросом снести историю
 * прогонов. Чтение остаётся свободным — оно и так ничего не меняет.
 */
function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  // Запрос без Origin — не из браузера: curl и тесты обращаются к демону
  // напрямую, и запрещать это значило бы запрещать работу из терминала.
  if (origin === undefined) return true;

  try {
    return new URL(origin).hostname === LOOPBACK || new URL(origin).hostname === 'localhost';
  } catch {
    return false;
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      body += chunk;
      if (Buffer.byteLength(body) > MAX_BODY_BYTES) {
        reject(new Error('Тело запроса слишком велико'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

/**
 * Снимок прогона: по каталогу, если он ещё есть; иначе — по записи хранилища
 * расхода, если она сохранена (design.md изменения run-stats-retention,
 * Решение 12). Отказ 404 остаётся только тогда, когда нет ни того, ни
 * другого — прогон убран целиком, вместе со статистикой.
 */
function snapshotOrRecord(runsRoot: string, key: string, runId: string): ReturnType<typeof buildSnapshot> | undefined {
  const paths = runPaths(runsRoot, key, runId);
  if (existsSync(paths.dir)) return buildSnapshot(paths, key);

  const record = readUsageStore(runsRoot).records.get(`${key}/${runId}`);
  return record === undefined ? undefined : buildSnapshotFromRecord(record, key);
}

function handleSnapshot(runsRoot: string, address: string | null, res: ServerResponse): void {
  const parsed = parseRunAddress(address);
  if (parsed === undefined) {
    sendJson(res, 400, { error: 'Адрес прогона должен иметь вид <проект>/<прогон>' });
    return;
  }

  const snapshot = snapshotOrRecord(runsRoot, parsed.key, parsed.runId);
  if (snapshot === undefined) {
    sendJson(res, 404, { error: `Прогон ${parsed.runId} не найден` });
    return;
  }

  sendJson(res, 200, snapshot);
}

function handleFile(runsRoot: string, url: URL, res: ServerResponse): void {
  const parsed = parseRunAddress(url.searchParams.get('run'));
  const requested = url.searchParams.get('path');

  if (parsed === undefined || requested === null) {
    sendJson(res, 400, { error: 'Нужны параметры run=<проект>/<прогон> и path' });
    return;
  }

  const paths = runPaths(runsRoot, parsed.key, parsed.runId);
  if (!existsSync(paths.dir)) {
    sendJson(res, 404, { error: `Прогон ${parsed.runId} не найден` });
    return;
  }

  // Умолчание — хвост: без параметра просят лог, а у лога интересен конец.
  const side = url.searchParams.get('side') === 'head' ? 'head' : 'tail';

  try {
    sendJson(res, 200, readJournalFile(paths.dir, requested, side));
  } catch (error) {
    // Выход за каталог прогона — ошибка клиента, а не сбой сервера.
    const message = isStepcastError(error) ? error.message : 'Файл не читается';
    sendJson(res, isStepcastError(error) ? 400 : 404, { error: message });
  }
}

const INVALID = Symbol('invalid');

/** Параметр запроса как неотрицательное целое; `undefined` — параметра не было. */
function readNonNegativeInt(url: URL, param: string): number | undefined | typeof INVALID {
  const raw = url.searchParams.get(param);
  if (raw === null) return undefined;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : INVALID;
}

/**
 * Судьба статистики при удалении файлов — `keep` умолчанием (design.md,
 * Решение 10): запрос, не назвавший её, сохраняет статистику, а не отказывает
 * и не снимает молча.
 */
function readStatsDisposition(url: URL): StatsDisposition | typeof INVALID {
  const raw = url.searchParams.get('stats');
  if (raw === null || raw === 'keep') return 'keep';
  return raw === 'drop' ? 'drop' : INVALID;
}

/**
 * Расход поперёк прогонов за период.
 *
 * `days` разбирается тем же правилом, что `attempt` у вывода шага: ноль или
 * нецелое число — ошибка клиента, а не молчаливое умолчание (design.md,
 * Решение 4). Сверху период ограничен `MAX_USAGE_DAYS`: ряд дней строится
 * подряд по календарю, и период длиной в миллионы дней занял бы единственный
 * поток демона на минуты — такой запрос отклоняется, а не считается. Без
 * параметра — весь период наблюдений.
 */
function handleUsage(runsRoot: string, watcher: Watcher, url: URL, res: ServerResponse): void {
  const days = readNonNegativeInt(url, 'days');
  if (days === INVALID || days === 0 || (days !== undefined && days > MAX_USAGE_DAYS)) {
    sendJson(res, 400, { error: `days должен быть натуральным числом не больше ${MAX_USAGE_DAYS}` });
    return;
  }
  sendJson(res, 200, buildUsage(runsRoot, watcher.current(), days === undefined ? {} : { days }));
}

/**
 * Вывод шага по логическому адресу: прогон, работа, шаг, попытка, смещение.
 *
 * Путь файла клиент не подаёт вовсе (design.md, Решение 1) — разрешает его
 * `readStepOutput` через `findStepDir` на каждый запрос, поэтому проверять
 * выход за каталог прогона здесь нечего: обход невозможен по устройству.
 * Идентификаторы работы и шага всё равно проходят проверку сегмента, как и
 * везде в этом файле.
 */
function handleStepOutput(runsRoot: string, url: URL, res: ServerResponse): void {
  const parsed = parseRunAddress(url.searchParams.get('run'));
  const jobId = url.searchParams.get('job');
  const stepId = url.searchParams.get('step');

  if (
    parsed === undefined ||
    jobId === null ||
    stepId === null ||
    !isSafeSegment(jobId) ||
    !isSafeSegment(stepId)
  ) {
    sendJson(res, 400, {
      error: 'Нужны параметры run=<проект>/<прогон>, job и step одним сегментом раскладки',
    });
    return;
  }

  const paths = runPaths(runsRoot, parsed.key, parsed.runId);
  if (!existsSync(paths.dir)) {
    sendJson(res, 404, { error: `Прогон ${parsed.runId} не найден` });
    return;
  }

  const attempt = readNonNegativeInt(url, 'attempt');
  if (attempt === INVALID || attempt === 0) {
    sendJson(res, 400, { error: 'attempt должен быть натуральным числом' });
    return;
  }

  const stdoutOffset = readNonNegativeInt(url, 'stdoutOffset');
  const stderrOffset = readNonNegativeInt(url, 'stderrOffset');
  if (stdoutOffset === INVALID || stderrOffset === INVALID) {
    sendJson(res, 400, { error: 'stdoutOffset и stderrOffset должны быть неотрицательными числами' });
    return;
  }

  try {
    sendJson(
      res,
      200,
      readStepOutput(paths, jobId, stepId, {
        ...(attempt === undefined ? {} : { attempt }),
        ...(stdoutOffset === undefined ? {} : { stdoutOffset }),
        ...(stderrOffset === undefined ? {} : { stderrOffset }),
      }),
    );
  } catch (error) {
    // Чтение с диска гоняется с удалением прогона и с ротацией файлов: между
    // проверкой существования и чтением каталог шага может исчезнуть. Опрос
    // раз в секунду на каждое раскрытое окно делает эту гонку рядовой, а
    // необработанное исключение в слушателе запроса роняет весь демон —
    // отвечать надо одному запросу, как это делает `handleFile`.
    const message = isStepcastError(error) ? error.message : 'Вывод шага не читается';
    sendJson(res, isStepcastError(error) ? 400 : 404, { error: message });
  }
}

/**
 * Удаление прогона из истории.
 *
 * Идущий прогон не удаляется: снести каталог под работающим движком значит
 * оставить его писать в никуда и потерять уже сделанное. Разбирать такое
 * пользователю пришлось бы по последствиям, а не по отказу.
 */
function handleDelete(runsRoot: string, url: URL, watcher: Watcher, res: ServerResponse): void {
  const parsed = parseRunAddress(url.searchParams.get('run'));
  if (parsed === undefined) {
    sendJson(res, 400, { error: 'Адрес прогона должен иметь вид <проект>/<прогон>' });
    return;
  }

  const stats = readStatsDisposition(url);
  if (stats === INVALID) {
    sendJson(res, 400, { error: 'stats должен быть keep или drop' });
    return;
  }

  const paths = runPaths(runsRoot, parsed.key, parsed.runId);
  if (!existsSync(paths.dir)) {
    sendJson(res, 404, { error: `Прогон ${parsed.runId} не найден` });
    return;
  }

  if (isRunAlive(paths)) {
    sendJson(res, 409, {
      error: 'Прогон идёт: остановите его, прежде чем удалять',
    });
    return;
  }

  const result = removeRunWithStats(runsRoot, parsed.key, parsed.runId, stats);
  // Обзор пересобирается сразу: иначе удалённый прогон повисит на экране до
  // следующего опроса, и пользователь решит, что удаление не сработало.
  watcher.poll();
  sendJson(res, 200, {
    removed: `${parsed.key}/${parsed.runId}`,
    stats: result.stats,
    ...(result.unresolvedWorktrees.length === 0 ? {} : { unresolvedWorktrees: result.unresolvedWorktrees }),
    ...(result.preservedWorkspaces.length === 0 ? {} : { preservedWorkspaces: result.preservedWorkspaces }),
  });
}

/**
 * Ответ на любой отбор — по признаку или по явным адресам: адрес, размер
 * каталога, возраст, число прогонов и суммарный объём. Общая точка, потому
 * что подтверждению группового удаления нужен ровно этот состав независимо
 * от того, чем прогоны названы.
 *
 * `uncheckedCount` — число прогонов области отбора, чей статус прочитать не
 * удалось и которых отбор поэтому не назвал (`selectCandidates`); у отбора по
 * явному списку адресов проверять нечего — область и так весь список,
 * названный пользователем, — и вызывающий передаёт ноль.
 */
function sendRunSelection(
  res: ServerResponse,
  runsRoot: string,
  selected: readonly AddressedCandidate[],
  uncheckedCount: number,
): void {
  // Читается один раз на весь отбор: подтверждение должно отличать прогон, у
  // которого есть что сохранить сверх файлов, от того, у которого нет
  // (ui-dashboard, «Прогон без записи в хранилище»).
  const { records } = readUsageStore(runsRoot);

  sendJson(res, 200, {
    runs: selected.map((candidate) => ({
      address: candidate.address,
      sizeBytes: candidate.sizeBytes,
      ageMs: candidate.ageMs,
      endedAt: candidate.endedAt,
      // Журнал прогона не читается: возраст взят по каталогу, статуса нет.
      // Пользователь должен видеть, почему такой прогон назван, а не гадать.
      unreadable: candidate.unreadable,
      hasUsageRecord: records.has(candidate.address),
    })),
    count: selected.length,
    totalBytes: selected.reduce((sum, candidate) => sum + candidate.sizeBytes, 0),
    uncheckedCount,
  });
}

/**
 * Отбор прогонов к групповому удалению — по признаку либо по явному списку
 * адресов, увиденных пользователем в списке прогонов (`run=<адрес>`,
 * повторяемый). Только отчёт: ничего не удаляется здесь, только показывается,
 * что удалится и сколько места освободится, — подтверждение пользователь даёт
 * отдельным запросом со списком адресов, увиденных здесь.
 *
 * Список адресов и признаки взаимоисключающие (design.md изменения
 * ui-runs-list-controls, Решение 9): смешивать «эти пять» с «все отказавшие»
 * нечем — объединение и пересечение дали бы разные списки, и угадывать, какой
 * имелся в виду, хуже отказа.
 */
function handleSelectRuns(runsRoot: string, url: URL, res: ServerResponse): void {
  const addressParams = url.searchParams.getAll('run');
  const hasTraitParams =
    url.searchParams.has('trait') || url.searchParams.has('older-than') || url.searchParams.has('project');

  if (addressParams.length > 0) {
    if (hasTraitParams) {
      sendJson(res, 400, {
        error: 'Параметр run не сочетается с trait, older-than или project: список адресов и признак — разные способы отбора',
      });
      return;
    }

    // Один и тот же адрес, названный дважды, — один прогон: без снятия
    // повторов его каталог мерился бы дважды, и `count` с `totalBytes` назвали
    // бы объём, которого не освободится. Повторы снимаются до проверки
    // предела: предел считает прогоны, а не строки запроса.
    const distinct = [...new Set(addressParams)];

    // Тот же предел, что и у группового удаления: иначе предел удаления
    // обходился бы отбором по адресам.
    if (distinct.length > MAX_RUN_ADDRESSES) {
      sendJson(res, 413, { error: `Список адресов превышает предел в ${MAX_RUN_ADDRESSES}` });
      return;
    }

    const addresses: RunAddress[] = [];
    for (const value of distinct) {
      const address = parseRunAddress(value);
      if (address === undefined) {
        sendJson(res, 400, { error: `Адрес прогона должен иметь вид <проект>/<прогон>: ${value}` });
        return;
      }
      addresses.push(address);
    }

    // Список адресов уже называет свою область целиком: догон идёт по нему, а
    // не по всем проектам корня (design.md, Решение 2). Полный обход стоил бы
    // подтверждению группового удаления чтения каждого прогона установки ради
    // метки у пяти названных.
    catchUpUsageRecords(runsRoot, addresses);
    sendRunSelection(res, runsRoot, selectByAddresses(runsRoot, addresses), 0);
    return;
  }

  const traits: { -readonly [K in keyof SelectTraits]: SelectTraits[K] } = {};

  for (const trait of url.searchParams.getAll('trait')) {
    if (!KNOWN_TRAITS.has(trait)) {
      sendJson(res, 400, {
        error: `Неизвестный признак отбора: ${trait}`,
        hint: 'Допустимые признаки: abandoned, failed',
      });
      return;
    }
    if (trait === 'abandoned') traits.abandoned = true;
    if (trait === 'failed') traits.failed = true;
  }

  const olderThan = url.searchParams.get('older-than');
  if (olderThan !== null) {
    try {
      traits.olderThanMs = parseDuration(olderThan, 'older-than');
    } catch (error) {
      const message = isStepcastError(error) ? error.message : 'Не удалось разобрать срок';
      sendJson(res, 400, { error: message });
      return;
    }
  }

  const project = url.searchParams.get('project');
  // Ключ проекта уходит в путь так же, как ключ из адреса прогона: без этой
  // проверки `?project=../..` перечислял бы каталоги вне корня прогонов.
  if (project !== null && !isSafeSegment(project)) {
    sendJson(res, 400, { error: 'Ключ проекта должен быть одним сегментом раскладки' });
    return;
  }

  // Догон перед отбором — ради hasUsageRecord и счётчика записей ниже по
  // потоку (design.md, Решение 2): отбор сам идёт по каталогам и от
  // отставания хранилища не зависит, а вот `sendRunSelection` читает
  // хранилище тоже, и метка «записи нет» обязана отвечать за диск, а не за
  // снимок хранилища на момент запуска демона.
  //
  // Отбор без единого признака не назовёт ни одного прогона (все ветви
  // `matches` в `selectCandidates` ложны), и обходить ради него корень
  // незачем: проект — область отбора каталогов, а не признак.
  const asked =
    traits.abandoned === true || traits.failed === true || traits.olderThanMs !== undefined;
  if (asked) catchUpUsageStore(runsRoot, project === null ? {} : { project });
  const { selected, uncheckedCount } = selectCandidates(runsRoot, traits, project === null ? {} : { project });
  sendRunSelection(res, runsRoot, selected, uncheckedCount);
}

/**
 * Групповое удаление по явному списку адресов.
 *
 * Список приходит с отбора, увиденного пользователем в подтверждении, а не с
 * признака: между показом и принятием отбор мог измениться, а удалиться
 * должно ровно то, что пользователь видел. Отказ на одном адресе не
 * останавливает остальные — каждый получает свой исход в ответе.
 */
async function handleDeleteRuns(
  runsRoot: string,
  req: IncomingMessage,
  watcher: Watcher,
  res: ServerResponse,
): Promise<void> {
  let body: string;
  try {
    body = await readBody(req);
  } catch {
    sendJson(res, 413, { error: 'Тело запроса слишком велико' });
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body === '' ? '{}' : body);
  } catch {
    sendJson(res, 400, { error: 'Тело запроса не разбирается как JSON' });
    return;
  }

  const list = (parsed as { runs?: unknown }).runs;
  if (!Array.isArray(list) || list.some((item) => typeof item !== 'string')) {
    sendJson(res, 400, { error: 'Тело запроса должно нести список адресов: { "runs": string[] }' });
    return;
  }

  const statsField = (parsed as { stats?: unknown }).stats;
  if (statsField !== undefined && statsField !== 'keep' && statsField !== 'drop') {
    sendJson(res, 400, { error: 'Поле stats должно быть keep или drop' });
    return;
  }
  const stats: StatsDisposition = statsField === 'drop' ? 'drop' : 'keep';

  if (list.length > MAX_RUN_ADDRESSES) {
    sendJson(res, 413, { error: `Список адресов превышает предел в ${MAX_RUN_ADDRESSES}` });
    return;
  }

  const addresses: RunAddress[] = [];
  for (const value of list as string[]) {
    const address = parseRunAddress(value);
    if (address === undefined) {
      sendJson(res, 400, { error: `Адрес прогона должен иметь вид <проект>/<прогон>: ${value}` });
      return;
    }
    addresses.push(address);
  }

  const summary = removeRuns(runsRoot, addresses, stats);
  // Одна пересборка на всю группу, а не на каждый прогон: наблюдатель не
  // должен просыпаться сотни раз за один запрос.
  watcher.poll();
  sendJson(res, 200, summary);
}

const KNOWN_USAGE_RECORD_TRAITS = new Set(['failed']);

/**
 * Отбор записей хранилища расхода к снятию — только отчёт, файлов прогонов
 * не касается (design.md изменения run-stats-retention, Решение 14). Те же
 * признаки, что у `handleSelectRuns`, кроме «оборванного»: он не применим к
 * записи (см. `selectUsageRecords`).
 */
function handleSelectUsageRecords(runsRoot: string, url: URL, res: ServerResponse): void {
  const traits: { -readonly [K in keyof UsageRecordSelectTraits]: UsageRecordSelectTraits[K] } = {};

  for (const trait of url.searchParams.getAll('trait')) {
    if (!KNOWN_USAGE_RECORD_TRAITS.has(trait)) {
      sendJson(res, 400, { error: `Неизвестный признак отбора: ${trait}`, hint: 'Допустимые признаки: failed' });
      return;
    }
    traits.failed = true;
  }

  const olderThan = url.searchParams.get('older-than');
  if (olderThan !== null) {
    try {
      traits.olderThanMs = parseDuration(olderThan, 'older-than');
    } catch (error) {
      const message = isStepcastError(error) ? error.message : 'Не удалось разобрать срок';
      sendJson(res, 400, { error: message });
      return;
    }
  }

  const project = url.searchParams.get('project');
  if (project !== null && !isSafeSegment(project)) {
    sendJson(res, 400, { error: 'Ключ проекта должен быть одним сегментом раскладки' });
    return;
  }

  // Догон перед отбором: отбор по хранилищу обязан отвечать за диск сейчас, а
  // не за снимок, перенесённый при старте демона (design.md, Решение 2).
  //
  // Тот же ранний выход, что и у `selectUsageRecords` (`usageStore.ts`): отбор
  // без признака, срока и проекта не отбирает ничего, и обход всего корня с
  // дозаписью ради заведомо пустого ответа — работа впустую.
  const narrowing = traits.failed === true || traits.olderThanMs !== undefined;
  if (narrowing || project !== null) {
    catchUpUsageStore(runsRoot, project === null ? {} : { project });
  }
  const selected = selectUsageRecords(runsRoot, traits, project === null ? {} : { project });

  sendJson(res, 200, {
    records: selected.map((entry) => ({
      address: entry.address,
      ageMs: entry.ageMs,
      endedAt: entry.record.finished_at ?? entry.record.started_at,
      status: entry.record.status,
    })),
    count: selected.length,
  });
}

/**
 * Снятие записей хранилища расхода по явному списку адресов — та же схема,
 * что у `handleDeleteRuns`: список пришёл с отбора, увиденного пользователем,
 * а не с признака, и файлов прогонов вызов не трогает вовсе.
 */
async function handleDeleteUsageRecords(
  runsRoot: string,
  req: IncomingMessage,
  watcher: Watcher,
  res: ServerResponse,
): Promise<void> {
  let body: string;
  try {
    body = await readBody(req);
  } catch {
    sendJson(res, 413, { error: 'Тело запроса слишком велико' });
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body === '' ? '{}' : body);
  } catch {
    sendJson(res, 400, { error: 'Тело запроса не разбирается как JSON' });
    return;
  }

  const list = (parsed as { records?: unknown }).records;
  if (!Array.isArray(list) || list.some((item) => typeof item !== 'string')) {
    sendJson(res, 400, { error: 'Тело запроса должно нести список адресов: { "records": string[] }' });
    return;
  }

  if (list.length > MAX_RUN_ADDRESSES) {
    sendJson(res, 413, { error: `Список адресов превышает предел в ${MAX_RUN_ADDRESSES}` });
    return;
  }

  const addresses: string[] = [];
  for (const value of list as string[]) {
    const address = parseRunAddress(value);
    if (address === undefined) {
      sendJson(res, 400, { error: `Адрес записи должен иметь вид <проект>/<прогон>: ${value}` });
      return;
    }
    addresses.push(`${address.key}/${address.runId}`);
  }

  // Исход по каждому адресу отдельно — так же, как у снятия каталогов
  // (`RemovalOutcome`): адрес, у которого записи уже не было, не должен
  // выглядеть снятым этим вызовом.
  const existedBefore = readUsageStore(runsRoot).records;
  const removed = removeUsageRecords(runsRoot, addresses);
  // Одна пересборка на всю группу — как и у снятия файлов: прогон без файлов,
  // чья запись снята этим вызовом, обязан пропасть из обзора немедленно.
  watcher.poll();
  sendJson(res, 200, {
    outcomes: addresses.map((address) => ({
      address,
      outcome: existedBefore.has(address) ? ('removed' as const) : ('skipped_missing' as const),
    })),
    removed,
  });
}

async function handleSettingsWrite(
  req: IncomingMessage,
  res: ServerResponse,
  home: string | undefined,
): Promise<void> {
  let body: string;
  try {
    body = await readBody(req);
  } catch {
    sendJson(res, 413, { error: 'Тело запроса слишком велико' });
    return;
  }

  let patch: SettingsPatch;
  try {
    patch = JSON.parse(body === '' ? '{}' : body) as SettingsPatch;
  } catch {
    sendJson(res, 400, { error: 'Тело запроса не разбирается как JSON' });
    return;
  }

  try {
    sendJson(res, 200, home === undefined ? writeSettings(patch) : writeSettings(patch, home));
  } catch (error) {
    const message = isStepcastError(error) ? error.message : (error as Error).message;
    sendJson(res, isStepcastError(error) ? 400 : 500, { error: message });
  }
}

/**
 * Пайплайны проектов: реестр каждого проекта собирается импортом чужого кода
 * (`buildPipelines` асинхронна), поэтому маршрут обёрнут так же, как запись
 * настроек, — `void` в диспетчере и отдельный `catch` здесь, а не необработанный
 * промис.
 */
async function handlePipelines(
  runsRoot: string,
  config: Config | undefined,
  home: string | undefined,
  registryCache: RegistryCache,
  res: ServerResponse,
): Promise<void> {
  if (config === undefined) {
    sendJson(res, 200, { pipelines: [], generatedAt: new Date().toISOString() });
    return;
  }

  try {
    // `home` доезжает сюда, потому что секцию `project` витрина читает у
    // каждого проекта своей: команда проверки объявлена в репозитории.
    const overview = await buildPipelines(runsRoot, config, {
      ...(home === undefined ? {} : { home }),
      registryCache,
    });
    sendJson(res, 200, overview);
  } catch (error) {
    sendJson(res, 500, { error: (error as Error).message });
  }
}

function handleEvents(
  runsRoot: string,
  watcher: Watcher,
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
  });

  const followed = parseRunAddress(url.searchParams.get('run'));

  const send = (event: string, data: unknown): void => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  // Последняя отправленная очередь: пока наблюдатель отдаёт то же значение,
  // слать её заново незачем. Обзор меняется по ходу прогона примерно
  // ежесекундно, очередь — куда реже, а весит она сотни килобайт, и гнать её
  // каждым кадром в каждую вкладку (включая страницу прогона, где она не
  // нужна) — ровно то, чего избегает отдельное событие (design.md, Решение 5).
  let sent: BacklogOverview | undefined;

  const push = (): void => {
    send('overview', watcher.current());
    const backlog = watcher.currentBacklog();
    if (backlog !== sent) {
      sent = backlog;
      send('backlog', backlog);
    }
    if (followed === undefined) return;
    const snapshot = snapshotOrRecord(runsRoot, followed.key, followed.runId);
    if (snapshot !== undefined) send('run', snapshot);
  };

  push();
  const unsubscribe = watcher.subscribe(push);

  // Клиент закрыл вкладку — подписка снимается, лишней работы не остаётся.
  req.on('close', () => {
    unsubscribe();
    res.end();
  });
}

/** Страница витрины. Любой не-API адрес ведёт на неё: маршруты разбирает клиент. */
function handlePage(res: ServerResponse, dashboardFile: string | undefined): void {
  const html = dashboardFile === undefined ? dashboardHtml() : dashboardHtml(dashboardFile);
  if (html === undefined) {
    res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Витрина не собрана. Соберите её командой npm run build:ui.\n');
    return;
  }

  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(html);
}

export function createUiServer(options: UiServerOptions): Promise<UiServer> {
  const { runsRoot, config, home, dashboardFile } = options;
  // Перенос накопленного делает тот, кто открывает хранилище — здесь, при
  // старте демона, до первого обзора и до первого запроса, — поэтому
  // `GET /api/usage` и прочие читающие маршруты остаются чтением (design.md
  // изменения run-stats-retention, Решение 9).
  backfillUsageStore(runsRoot);
  const watcher =
    options.watcher ??
    createWatcher({ runsRoot, ...(options.log === undefined ? {} : { log: options.log }) });
  const ownsWatcher = options.watcher === undefined;
  // Один кеш реестров на сервер, не на модуль: тесты поднимают несколько
  // демонов в одном процессе, и общий кеш связал бы их между собой
  // (design.md, Решение 3).
  const registryCache = createRegistryCache();

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${LOOPBACK}`);
    const method = req.method ?? 'GET';

    if (method !== 'GET' && !sameOrigin(req)) {
      sendJson(res, 403, { error: 'Запрос пришёл со стороннего адреса' });
      return;
    }

    if (method === 'DELETE' && url.pathname === '/api/run') {
      handleDelete(runsRoot, url, watcher, res);
      return;
    }

    if (method === 'DELETE' && url.pathname === '/api/runs') {
      void handleDeleteRuns(runsRoot, req, watcher, res);
      return;
    }

    if (method === 'DELETE' && url.pathname === '/api/usage-records') {
      void handleDeleteUsageRecords(runsRoot, req, watcher, res);
      return;
    }

    if (method === 'PUT' && url.pathname === '/api/settings') {
      void handleSettingsWrite(req, res, home);
      return;
    }

    if (method !== 'GET') {
      sendJson(res, 405, { error: 'Такого действия у витрины нет' });
      return;
    }

    switch (url.pathname) {
      case '/api/overview':
        sendJson(res, 200, watcher.current());
        return;
      case '/api/backlog':
        sendJson(res, 200, watcher.currentBacklog());
        return;
      case '/api/run':
        handleSnapshot(runsRoot, url.searchParams.get('run'), res);
        return;
      case '/api/file':
        handleFile(runsRoot, url, res);
        return;
      case '/api/step-output':
        handleStepOutput(runsRoot, url, res);
        return;
      case '/api/runs':
        handleSelectRuns(runsRoot, url, res);
        return;
      case '/api/usage-records':
        handleSelectUsageRecords(runsRoot, url, res);
        return;
      case '/api/pipelines':
        void handlePipelines(runsRoot, config, home, registryCache, res);
        return;
      case '/api/settings':
        sendJson(res, 200, home === undefined ? readSettings() : readSettings(home));
        return;
      case '/api/usage':
        handleUsage(runsRoot, watcher, url, res);
        return;
      case '/api/events':
        handleEvents(runsRoot, watcher, url, req, res);
        return;
      default:
        // Адрес под /api — это обращение к API, и его отсутствие надо назвать,
        // а не подменять страницей.
        if (isApiPath(url.pathname)) {
          sendJson(res, 404, { error: 'Нет такого маршрута' });
          return;
        }
        handlePage(res, dashboardFile);
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, LOOPBACK, () => {
      server.removeListener('error', reject);
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : options.port;

      resolve({
        server,
        port,
        close: () =>
          new Promise<void>((done) => {
            if (ownsWatcher) watcher.dispose();
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}
