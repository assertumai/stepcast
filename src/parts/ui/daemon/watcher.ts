import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { listProjects, listRunsByKey } from '../../pipeline/run/journal/reader.js';
import { runPaths, usageStorePath } from '../../pipeline/run/journal/paths.js';
import { buildBacklog, type BacklogOverview } from '../backlog.js';
import { buildOverview, type Overview, type RunOverview } from '../overview.js';
import { buildWidgets, projectWidgetVersions, type WidgetsOverview } from '../widgets.js';
import { buildProposals, proposalsDirFingerprint, type ProposalsOverview } from '../proposals.js';
import { buildHomePlugins, type PluginsOverview } from '../plugins.js';
import { buildRouteTable, builtinRoutesPath, homeRoutesPath, projectRoutesPath, type RouteBuildResult } from '../routesFile.js';
import {
  buildDashboards,
  dashboardsDirFingerprint,
  homeDashboardsDirPath,
  projectDashboardsDirPath,
  type DashboardsBuildResult,
} from '../dashboardsFile.js';
import { StepcastError } from '../../../kernel/errors.js';
import type { JournalProblem } from '../../pipeline/run/journal/reader.js';

/**
 * Наблюдатель за корнем прогонов — и за файлом очереди в корне каждого
 * проекта, названного указателем `projects.json`.
 *
 * Один на демон, слушателей много: свой опрос на каждое SSE-соединение
 * умножал бы работу на число открытых вкладок при том, что данные у всех одни
 * и те же.
 *
 * Опрос по таймеру, а не уведомления файловой системы, — по той же причине,
 * по которой так устроен `follow()`: уведомления приходят не на всех файловых
 * системах, включая сетевые, и пропущенный прогон хуже секундной задержки.
 */

/** Каталоги меняются редко — куда реже, чем строки в логе у `follow()`. */
const DEFAULT_INTERVAL_MS = 1_000;

export interface WatcherOptions {
  readonly runsRoot: string;
  readonly intervalMs?: number;
  /**
   * Куда печатать отказ разбора файла журнала — по умолчанию поток ошибок
   * демона: `startDetached` отводит его в `~/.stepcast/ui.log`, а в
   * `--foreground` то же уходит в терминал. Печать передаётся параметром,
   * чтобы проверка собирала строки, а не писала в общий поток.
   */
  readonly log?: (line: string) => void;
  /**
   * Домашний каталог: определяет, чей `.stepcast/plugins/` наблюдатель
   * отпечатывает (design.md изменения `hot-swap-preserves-data`, задача 12).
   * По умолчанию — `homedir()`, тем же умолчанием, что у `currentDaemonKernel`
   * (`src/parts/ui/daemon/kernel.ts`).
   */
  readonly home?: string;
  /** Корень проекта, в котором поднят демон — проектный слой таблицы маршрутов (`ui-daemon`). */
  readonly projectRoot?: string;
  /**
   * Файл маршрутов поставки. У поставки он один (`builtinRoutesPath()`) и
   * подменяется только проверкой сценария «Встроенный файл сломан»: сломать
   * настоящий файл пакета ей негде.
   */
  readonly builtinRoutesPath?: string;
}

/** Строка лога демона: прогон, файл, место, обе версии и, при расхождении, лекарство. */
function formatProblemLine(runId: string, problem: JournalProblem): string {
  const at = problem.at === undefined ? '' : `, ${problem.at}`;
  const journalFormat = problem.journalFormat === undefined ? 'нет' : String(problem.journalFormat);
  const remedy =
    problem.kind === 'version-skew'
      ? '; перезапустите демон: stepcast down && stepcast up'
      : problem.kind === 'legacy-journal'
        ? '; прогон записан прежней формой журнала — перезапуск не поможет'
        : '';
  return (
    `прогон ${runId}: ${problem.file}${at} — ${problem.detail} ` +
    `(версия журнала: ${journalFormat}, версия читателя: ${problem.readerFormat})${remedy}`
  );
}

export interface Watcher {
  /** Текущий обзор без ожидания следующего опроса. */
  current(): Overview;
  /** Текущая очередь без ожидания следующего опроса. */
  currentBacklog(): BacklogOverview;
  /** Текущий состав виджетов без ожидания следующего опроса. */
  currentWidgets(): WidgetsOverview;
  /**
   * Текущий состав плагинов домашнего слоя с браузерной половиной, без
   * ожидания следующего опроса (design.md изменения `hot-swap-preserves-data`,
   * задача 12) — тот же наивный обход каталога, что и содержимое события
   * `plugins`; действующий состав демона (с учётом патча и коллизий имени) —
   * `currentDaemonKernel` (`src/parts/ui/daemon/kernel.ts`), решение записано там же.
   */
  currentPlugins(): PluginsOverview;
  /**
   * Действующая таблица маршрутов с источниками, без ожидания следующего
   * опроса (`ui-routes`, Решение 10). Пересобирается только по сдвигу своей
   * части отпечатка — правка `routes.yml` не заставляет перечитывать очередь,
   * виджеты или прогоны, и наоборот.
   */
  currentRoutes(): RouteBuildResult;
  /** Причина последнего отказа сборки таблицы маршрутов — действующей остаётся прежняя (`ui-routes`, «Отказ таблицы не гасит витрину»). */
  currentRoutesError(): string | undefined;
  /**
   * Действующий состав дашбордов обоих слоёв, без ожидания следующего опроса
   * (`ui-dashboards`, Решение 10). Пересобирается только по сдвигу своей части
   * отпечатка — правка каталогов дашбордов не заставляет перечитывать очередь,
   * виджеты, маршруты или прогоны, и наоборот. Отказ одного дашборда едет
   * причиной внутри `failures`, не отменяя прочие (`ui-daemon`, «Сломанный
   * файл не отменяет остальные»).
   */
  currentDashboards(): DashboardsBuildResult;
  /**
   * Действующая очередь предложений всех проектов, без ожидания следующего
   * опроса (`ui-proposals`, «Состав очереди идёт потоком событий»).
   * Пересобирается только по сдвигу своей части отпечатка — такт, где
   * сдвинулись лишь прогон, виджеты или маршруты, оставляет прежний объект.
   * Наблюдатель каталог очереди не создаёт, не чинит и не убирает — только
   * читает (`ui-daemon`, «Наблюдение очереди её не изменяет»).
   */
  currentProposals(): ProposalsOverview;
  /** Подписаться на обновления. Возвращает функцию отписки. */
  subscribe(listener: (overview: Overview, backlog: BacklogOverview) => void): () => void;
  /** Проверить корень прогонов немедленно, не дожидаясь таймера. */
  poll(): void;
  dispose(): void;
}

/**
 * Отпечаток наблюдаемого состояния — двумя отдельными частями, потому что и
 * пересобирается по ним разное: `runs` сторожит обзор, `backlog` — очереди
 * проектов. Слитый отпечаток заставлял бы разбирать очереди всех проектов
 * (у этого репозитория — сотни килобайт) на каждую запись `status.json`
 * идущего прогона, то есть едва ли не ежесекундно.
 */
interface Fingerprint {
  readonly runs: string;
  readonly backlog: string;
  readonly widgets: string;
  readonly plugins: string;
  readonly routes: string;
  readonly dashboards: string;
  readonly proposals: string;
}

/**
 * Часть `runs` — состояние корня: какие прогоны есть, когда каждый последний
 * раз менялся и убран ли он. Сравнение отпечатков дешевле разбора всех
 * `status.json` — их приходится читать только когда отпечаток разошёлся.
 *
 * Отпечаток обязан покрывать всё, что показывает обзор, иначе изменение
 * останется невидимым навсегда. Признак уборки входит сюда именно поэтому:
 * `stepcast gc` сносит содержимое прогона, не трогая `status.json`, и по
 * одному лишь mtime состояния уборка неотличима от её отсутствия.
 *
 * По той же причине сюда входит и хранилище расхода: прогон без файлов живёт в
 * обзоре одной лишь своей записью (`buildOverview`), и его появление или снятие
 * не меняет ни одного каталога корня. Хранилище — единственный файл, который
 * дописывается без создания каталога, поэтому размер идёт рядом с mtime:
 * дозапись и снятие записи в пределах одной секунды mtime могут не сдвинуть.
 *
 * Часть `backlog` — оба файла очереди каждого проекта (`backlog.md` и
 * `archived.md`), тем же приёмом: `mtime` **и** размер
 * вместе, потому что правка в пределах секунды может не сдвинуть `mtime`, а
 * `atomicWrite` подменяет файл переименованием, так что размер меняется вместе
 * с содержимым почти всегда (design.md, Решение 4). Отсутствие файла — такое
 * же законное состояние отпечатка, как и его наличие.
 *
 * Часть `widgets` — виджеты `.stepcast/widgets/` каждого проекта с известным
 * путём, тем же приёмом «`mtime` и размер» (design.md изменения
 * `ui-runtime-widget-spike`, Решение 7). Отдельная часть, а не слияние с
 * `backlog`: цена перечитывания разная — очередь весит сотни килобайт разбора
 * Markdown, состав виджетов — `readdirSync` каталога с единицами файлов, и
 * слитая часть заставляла бы перечитывать очередь на каждое сохранение
 * виджета в редакторе.
 *
 * Часть `plugins` — плагины домашнего слоя с браузерной половиной, тем же
 * приёмом «`id`:версия» через запятую (design.md изменения
 * `hot-swap-preserves-data`, задача 12): отдельная часть, потому что без неё
 * `poll()` увидел бы неизменными `runs`/`backlog`/`widgets` и ушёл бы ранним
 * возвратом (ниже), даже когда на диске поменялся только каталог плагинов, —
 * и событие `plugins` не отправилось бы вовсе, пока не изменится что-то ещё.
 *
 * Часть `routes` — три файла слоя таблицы маршрутов, `mtime` и размер каждого
 * (`ui-routes`, Решение 10): своя часть, а не слияние с `plugins`, — правка
 * `routes.yml` не должна перечитывать каталог плагинов домашнего слоя, и
 * наоборот. Отсутствие файла слоя — законное состояние, тем же приёмом, что и
 * `backlog`.
 *
 * Часть `dashboards` — оба каталога слоёв дашбордов, имя и `mtime`+размер
 * каждого файла (`ui-dashboards`, Решение 10): отдельная часть, потому что
 * правка дашборда не должна перечитывать таблицу маршрутов, очередь или
 * виджеты, и наоборот. Каталог перечисляется целиком (не список фиксированных
 * путей, как у `routes`), потому что дашбордов может быть сколько угодно и
 * какой файл появится — заранее не известно.
 *
 * Часть `proposals` — каталог очереди предложений `.stepcast/proposals/`
 * каждого проекта с известным путём, имя и `mtime`+размер каждой записи
 * (`ui-proposals`, «Состав очереди идёт потоком событий»): отдельная часть,
 * тем же приёмом, что `widgets` и `dashboards` — принятая или отклонённая
 * запись не должна перечитывать виджеты, маршруты или дашборды, и наоборот.
 * Отсутствие каталога очереди — законное состояние отпечатка, тем же
 * приёмом, что и у `backlog`.
 */
function statPart(path: string): string {
  try {
    const stat = statSync(path);
    return `${path}:${stat.mtimeMs}:${stat.size}`;
  } catch {
    return `${path}:-`;
  }
}

function routesFingerprint(builtinPath: string, home: string, projectRoot: string | undefined): string {
  const paths = [builtinPath, homeRoutesPath(home)];
  if (projectRoot !== undefined) paths.push(projectRoutesPath(projectRoot));
  return paths.map(statPart).join('|');
}

function dashboardsFingerprint(home: string, projectRoot: string | undefined): string {
  const homePart = dashboardsDirFingerprint(homeDashboardsDirPath(home));
  const projectPart = projectRoot === undefined ? '-' : dashboardsDirFingerprint(projectDashboardsDirPath(projectRoot));
  return `${homePart}|${projectPart}`;
}

function fingerprint(
  runsRoot: string,
  home: string,
  projectRoot: string | undefined,
  builtinPath: string,
): Fingerprint {
  const parts: string[] = [];
  const backlogParts: string[] = [];
  const widgetParts: string[] = [];
  const proposalsParts: string[] = [];
  const pluginParts = buildHomePlugins(home)
    .plugins.map((plugin) => `${plugin.id}:${plugin.version}`)
    .join(',');
  const routes = routesFingerprint(builtinPath, home, projectRoot);
  const dashboards = dashboardsFingerprint(home, projectRoot);

  try {
    const store = statSync(usageStorePath(runsRoot));
    parts.push(`usage:${store.mtimeMs}:${store.size}`);
  } catch {
    // Хранилища ещё нет: до первой записи его отсутствие — такое же состояние,
    // как и любое другое, и его смена на «файл появился» отпечаток заметит.
    parts.push('usage:-');
  }

  for (const project of listProjects(runsRoot)) {
    // Путь неизвестен — читать очередь неоткуда, как и в buildBacklog: такой
    // проект в очереди не покажется, а стало быть, отпечатывать по нему нечего.
    if (project.path !== undefined) {
      // Оба файла очереди, а не один: доска переносит пункт из `backlog.md` в
      // `archived.md` и обратно (`POST /api/backlog/move`), и правка только
      // архива обязана доехать до вкладки тем же тактом. Отпечаток по одному
      // файлу оставлял бы перенесённый пункт видимым на прежнем месте до
      // следующей правки очереди.
      for (const name of ['backlog.md', 'archived.md']) {
        try {
          const file = statSync(join(project.path, name));
          backlogParts.push(`${project.key}/${name}:${file.mtimeMs}:${file.size}`);
        } catch {
          backlogParts.push(`${project.key}/${name}:-`);
        }
      }

      // Версия каждого виджета уже несёт `mtime` и размер (`fingerprintVersion`
      // в `src/parts/ui/widgets.ts`) — отдельно их здесь не считать.
      //
      // Зовётся `projectWidgetVersions`, а не `buildProjectWidgets`: второй
      // вдобавок читает исходник каждого виджета ради признака устаревания, а
      // в отпечаток тот признак не входит вовсе. Такт идёт раз в секунду по
      // каждому виджету каждого проекта, и чтение там было бы чистой тратой:
      // признак всё равно пересчитывается на том такте, где эта часть
      // отпечатка сдвинулась (`widget-migration`, Решение 9).
      //
      // Запись идёт на каждый проект с известным путём, а не на каждый файл, —
      // тем же приёмом, каким `backlog` пишет `${project.key}:-`: проект без
      // виджетов тоже раздел состава («Проект без виджетов SHALL показываться
      // пустым»), и без его записи появление такого проекта не сдвинуло бы
      // часть отпечатка, а состав не пересобрался бы до первой правки
      // какого-нибудь виджета. Отсутствующий каталог проекта помечен отдельно
      // от «каталог есть, виджетов нет»: `buildWidgets` такой проект в состав
      // не берёт вовсе, и появление каталога обязано сдвинуть отпечаток ещё до
      // первого виджета в нём.
      const widgets = existsSync(project.path)
        ? projectWidgetVersions(project.path)
            .map((widget) => `${widget.id}:${widget.version}`)
            .join(',') || '-'
        : '?';
      widgetParts.push(`${project.key}:${widgets}`);
      proposalsParts.push(`${project.key}:${proposalsDirFingerprint(project.path)}`);
    }

    for (const runId of listRunsByKey(runsRoot, project.key)) {
      const paths = runPaths(runsRoot, project.key, runId);
      let mtime = 0;
      try {
        mtime = statSync(paths.status).mtimeMs;
      } catch {
        // Прогон без состояния: он всё равно должен попасть в отпечаток, иначе
        // его появление останется незамеченным до первой записи состояния.
      }
      parts.push(`${project.key}/${runId}:${mtime}:${existsSync(paths.jobs) ? '1' : '0'}`);
    }
  }
  return {
    runs: parts.join('|'),
    backlog: backlogParts.join('|'),
    widgets: widgetParts.join('|'),
    plugins: pluginParts,
    routes,
    dashboards,
    proposals: proposalsParts.join('|'),
  };
}

/** Отказ сборки в текст — та же форма, что и у прочих причин демона. */
function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Состав проектов обзора: ключ и корень каждого. Второе условие пересборки
 * очереди — вид очереди строится по проектам обзора, и проект, впервые
 * появившийся в нём (например, одной лишь записью хранилища расхода, без
 * каталога прогона), обязан получить свой раздел, даже если ни один файл
 * очереди при этом не менялся.
 */
function projectList(overview: Overview): string {
  return overview.projects.map((project) => `${project.key}:${project.path ?? '-'}`).join('|');
}

export function createWatcher(options: WatcherOptions): Watcher {
  const { runsRoot, projectRoot } = options;
  const home = options.home ?? homedir();
  const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const listeners = new Set<(overview: Overview, backlog: BacklogOverview) => void>();
  // Ключ «прогон + файл + причина»: обзор пересобирается на всякое изменение
  // корня, в худшем случае ежесекундно, — без множества уже сказанного лог
  // демона рос бы строкой в секунду на одну и ту же беду.
  const reported = new Set<string>();

  const reportProblems = (current: Overview): void => {
    for (const project of current.projects) {
      for (const run of project.runs as readonly RunOverview[]) {
        if (run.problem === undefined) continue;
        // В лог идёт отказ разбора, а не отсутствие файла: между записью
        // манифеста и первой записью состояния лежат секунды, и опрос раз в
        // секунду успевает застать здоровый прогон без `status.json`. Строка
        // о нём осталась бы в `~/.stepcast/ui.log` навсегда и обесценила бы
        // правило «одна строка на беду».
        if (run.problem.kind === 'missing') continue;
        const key = `${run.runId} ${run.problem.file} ${run.problem.detail}`;
        if (reported.has(key)) continue;
        reported.add(key);
        log(formatProblemLine(run.runId, run.problem));
      }
    }
  };

  const builtinPath = options.builtinRoutesPath ?? builtinRoutesPath();
  const routeOptions = {
    home,
    ...(projectRoot === undefined ? {} : { projectRoot }),
    ...(options.builtinRoutesPath === undefined ? {} : { builtinPath: options.builtinRoutesPath }),
  };

  let mark = fingerprint(runsRoot, home, projectRoot, builtinPath);
  let overview = buildOverview(runsRoot);
  let projects = projectList(overview);
  let backlog = buildBacklog(overview);
  let widgets = buildWidgets(runsRoot);
  let proposals = buildProposals(runsRoot);
  let plugins = buildHomePlugins(home);
  // Отказ первой сборки не имеет прежней таблицы, которой можно было бы
  // остаться: пустая таблица с названной причиной — единственный разумный
  // старт (`ui-routes`, «Отказ таблицы не гасит витрину» касается уже
  // поднятой витрины, а не самого первого построения).
  //
  // Кроме одного случая: отказ самого файла поставки — отказ подъёма витрины
  // (`ui-routes`, «Встроенный файл сломан»; design.md, Migration Plan). Без
  // файла поставки маршрутов нет вовсе, и молчаливый подъём с пустой таблицей
  // был бы неотличим от «пользователь отключил всё сам» — ровно та подмена
  // причины, которой изменение не допускает.
  let routes: RouteBuildResult = { table: [], entries: [], disabled: [] };
  let routesError: string | undefined;
  try {
    routes = buildRouteTable(routeOptions);
  } catch (error) {
    if (error instanceof StepcastError && error.file === builtinPath) throw error;
    routesError = reasonOf(error);
  }
  let dashboards: DashboardsBuildResult = buildDashboards(routeOptions);
  reportProblems(overview);

  const poll = (): void => {
    const next = fingerprint(runsRoot, home, projectRoot, builtinPath);
    if (
      next.runs === mark.runs &&
      next.backlog === mark.backlog &&
      next.widgets === mark.widgets &&
      next.plugins === mark.plugins &&
      next.routes === mark.routes &&
      next.dashboards === mark.dashboards &&
      next.proposals === mark.proposals
    ) {
      return;
    }
    const backlogChanged = next.backlog !== mark.backlog;
    const widgetsChanged = next.widgets !== mark.widgets;
    const pluginsChanged = next.plugins !== mark.plugins;
    const routesChanged = next.routes !== mark.routes;
    const dashboardsChanged = next.dashboards !== mark.dashboards;
    const proposalsChanged = next.proposals !== mark.proposals;
    const runsChanged = next.runs !== mark.runs;
    mark = next;
    // Обзор пересобирается только по своей части отпечатка, тем же правилом,
    // что и соседи ниже: правка `routes.yml` (как и каталога плагинов) не
    // должна заставлять перечитывать прогоны корня (`ui-routes`, «Правка файла
    // маршрутов применяется в открытой витрине»: «MUST NOT перечитывать ради
    // неё очередь, виджеты и прогоны»).
    if (runsChanged) {
      overview = buildOverview(runsRoot);
    }
    const nextProjects = projectList(overview);
    // Очереди перечитываются только когда изменились их файлы либо состав
    // проектов обзора (сценарий «Неизменный файл не перечитывается»): такт, на
    // котором сдвинулся лишь идущий прогон, оставляет прежнее значение — и тем
    // же значением, а не новым объектом с тем же содержимым, чтобы поток
    // событий отличал «очередь та же» от «очередь другая».
    if (backlogChanged || nextProjects !== projects) {
      projects = nextProjects;
      backlog = buildBacklog(overview);
    }
    // Тем же приёмом — состав виджетов пересобирается только по своей части
    // отпечатка: такт, где сдвинулись лишь прогон или очередь, оставляет
    // прежний объект (design.md изменения `ui-runtime-widget-spike`, Решение 7).
    if (widgetsChanged) {
      widgets = buildWidgets(runsRoot);
    }
    // Тем же приёмом — состав плагинов пересобирается только по своей части
    // отпечатка (design.md изменения `hot-swap-preserves-data`, задача 12).
    if (pluginsChanged) {
      plugins = buildHomePlugins(home);
    }
    // Тем же приёмом — таблица маршрутов пересобирается только по своей части
    // отпечатка (`ui-routes`, Решение 10). Отказ сборки не заменяет прежнюю
    // действующую таблицу — остаётся последняя успешная, причина рядом с ней.
    if (routesChanged) {
      try {
        routes = buildRouteTable(routeOptions);
        routesError = undefined;
      } catch (error) {
        routesError = reasonOf(error);
      }
    }
    // Тем же приёмом — состав дашбордов пересобирается только по своей части
    // отпечатка (`ui-dashboards`, Решение 10). Отказ одного дашборда едет
    // причиной внутри `failures` — `buildDashboards` не бросает исключение из-за
    // него, действующим остаётся состав со всеми прочими дашбордами.
    if (dashboardsChanged) {
      dashboards = buildDashboards(routeOptions);
    }
    // Тем же приёмом — очередь предложений пересобирается только по своей
    // части отпечатка (`ui-proposals`, «Состав очереди идёт потоком событий»):
    // такт, где сдвинулись лишь виджеты или маршруты, оставляет прежний
    // объект.
    if (proposalsChanged) {
      proposals = buildProposals(runsRoot);
    }
    reportProblems(overview);
    for (const listener of listeners) listener(overview, backlog);
  };

  const timer = setInterval(poll, options.intervalMs ?? DEFAULT_INTERVAL_MS);
  // Таймер не должен удерживать процесс: демон живёт своим сервером.
  timer.unref();

  return {
    current: () => overview,
    currentBacklog: () => backlog,
    currentWidgets: () => widgets,
    currentPlugins: () => plugins,
    currentRoutes: () => routes,
    currentRoutesError: () => routesError,
    currentDashboards: () => dashboards,
    currentProposals: () => proposals,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    poll,
    dispose() {
      clearInterval(timer);
      listeners.clear();
    },
  };
}
