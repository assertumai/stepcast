import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { listProjects, listRunsByKey } from '../core/journal/reader.js';
import { runPaths, usageStorePath } from '../core/journal/paths.js';
import { buildBacklog, type BacklogOverview } from './backlog.js';
import { buildOverview, type Overview, type RunOverview } from './overview.js';
import { buildProjectWidgets, buildWidgets, type WidgetsOverview } from './widgets.js';
import type { JournalProblem } from '../core/journal/reader.js';

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
 * Часть `backlog` — файлы очередей, тем же приёмом: `mtime` **и** размер
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
 */
function fingerprint(runsRoot: string): Fingerprint {
  const parts: string[] = [];
  const backlogParts: string[] = [];
  const widgetParts: string[] = [];

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
      try {
        const backlog = statSync(join(project.path, 'backlog.md'));
        backlogParts.push(`${project.key}:${backlog.mtimeMs}:${backlog.size}`);
      } catch {
        backlogParts.push(`${project.key}:-`);
      }

      // Версия каждого виджета уже несёт `mtime` и размер (`fingerprintVersion`
      // в `src/ui/widgets.ts`) — отдельно их здесь не считать.
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
        ? buildProjectWidgets(project.path)
            .map((widget) => `${widget.id}:${widget.version}`)
            .join(',') || '-'
        : '?';
      widgetParts.push(`${project.key}:${widgets}`);
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
  return { runs: parts.join('|'), backlog: backlogParts.join('|'), widgets: widgetParts.join('|') };
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
  const { runsRoot } = options;
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

  let mark = fingerprint(runsRoot);
  let overview = buildOverview(runsRoot);
  let projects = projectList(overview);
  let backlog = buildBacklog(overview);
  let widgets = buildWidgets(runsRoot);
  reportProblems(overview);

  const poll = (): void => {
    const next = fingerprint(runsRoot);
    if (next.runs === mark.runs && next.backlog === mark.backlog && next.widgets === mark.widgets) return;
    const backlogChanged = next.backlog !== mark.backlog;
    const widgetsChanged = next.widgets !== mark.widgets;
    mark = next;
    overview = buildOverview(runsRoot);
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
