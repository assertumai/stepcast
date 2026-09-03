import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { existsSync } from 'node:fs';

import { runPaths } from '../core/journal/paths.js';
import { isRunAlive } from '../core/journal/reader.js';
import { removeRun, removeRuns, selectCandidates, type RunAddress, type SelectTraits } from '../core/run/cleanup.js';
import { isStepcastError } from '../core/errors.js';
import { parseDuration } from '../core/units.js';
import type { Config } from '../core/config/resolve.js';
import { dashboardHtml } from './assets.js';
import { readJournalFile } from './file.js';
import { buildPipelines } from './pipelines.js';
import { isApiPath, isSafeSegment } from './routes.js';
import { readSettings, writeSettings, type SettingsPatch } from './settings.js';
import { buildSnapshot } from './snapshot.js';
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

function handleSnapshot(runsRoot: string, address: string | null, res: ServerResponse): void {
  const parsed = parseRunAddress(address);
  if (parsed === undefined) {
    sendJson(res, 400, { error: 'Адрес прогона должен иметь вид <проект>/<прогон>' });
    return;
  }

  const paths = runPaths(runsRoot, parsed.key, parsed.runId);
  if (!existsSync(paths.dir)) {
    sendJson(res, 404, { error: `Прогон ${parsed.runId} не найден` });
    return;
  }

  sendJson(res, 200, buildSnapshot(paths, parsed.key));
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

  const result = removeRun(runsRoot, parsed.key, parsed.runId);
  // Обзор пересобирается сразу: иначе удалённый прогон повисит на экране до
  // следующего опроса, и пользователь решит, что удаление не сработало.
  watcher.poll();
  sendJson(res, 200, {
    removed: `${parsed.key}/${parsed.runId}`,
    ...(result.unresolvedWorktrees.length === 0 ? {} : { unresolvedWorktrees: result.unresolvedWorktrees }),
    ...(result.preservedWorkspaces.length === 0 ? {} : { preservedWorkspaces: result.preservedWorkspaces }),
  });
}

/**
 * Отбор прогонов к групповому удалению по признаку.
 *
 * Только отчёт: ничего не удаляется здесь, только показывается, что удалится
 * и сколько места освободится, — подтверждение пользователь даёт отдельным
 * запросом со списком адресов, увиденных здесь.
 */
function handleSelectRuns(runsRoot: string, url: URL, res: ServerResponse): void {
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

  const selected = selectCandidates(runsRoot, traits, project === null ? {} : { project });

  sendJson(res, 200, {
    runs: selected.map((candidate) => ({
      address: candidate.address,
      sizeBytes: candidate.sizeBytes,
      ageMs: candidate.ageMs,
      endedAt: candidate.endedAt,
      // Журнал прогона не читается: возраст взят по каталогу, статуса нет.
      // Пользователь должен видеть, почему такой прогон назван, а не гадать.
      unreadable: candidate.unreadable,
    })),
    count: selected.length,
    totalBytes: selected.reduce((sum, candidate) => sum + candidate.sizeBytes, 0),
  });
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

  const summary = removeRuns(runsRoot, addresses);
  // Одна пересборка на всю группу, а не на каждый прогон: наблюдатель не
  // должен просыпаться сотни раз за один запрос.
  watcher.poll();
  sendJson(res, 200, summary);
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

  const push = (): void => {
    send('overview', watcher.current());
    if (followed === undefined) return;
    const paths = runPaths(runsRoot, followed.key, followed.runId);
    if (existsSync(paths.dir)) send('run', buildSnapshot(paths, followed.key));
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
  const watcher = options.watcher ?? createWatcher({ runsRoot });
  const ownsWatcher = options.watcher === undefined;

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
      case '/api/pipelines':
        if (config === undefined) {
          sendJson(res, 200, { pipelines: [], generatedAt: new Date().toISOString() });
          return;
        }
        // `home` доезжает сюда, потому что секцию `project` витрина читает у
        // каждого проекта своей: команда проверки объявлена в репозитории.
        sendJson(res, 200, buildPipelines(runsRoot, config, home === undefined ? {} : { home }));
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
