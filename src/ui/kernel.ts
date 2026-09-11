import { homedir } from 'node:os';
import { join } from 'node:path';

import { resolveConfig, type ResolvedConfig } from '../core/config/resolve.js';
import { loadPlugins, type RowOutcome } from '../core/plugins/load.js';
import { kernelFromRegistry, type Registry } from '../core/plugins/registry.js';
import { resolveWithCachedKernel, type KernelCache } from './pipelines.js';
import { UI_ROWS, UI_SHELL_ROW } from './screens/rows.js';
import { NO_ROUTES, type ActiveScreen, type ApiRoutes, type ApiService, type ScreensService } from './screens/registry.js';
import type { ActivePluginRow } from './plugins.js';

/**
 * Единственная точка получения действующего ядра демона (`ui-daemon`,
 * design.md Решение 6): ключ кеша `home:<home>`, строки поставки витрины —
 * `ui-shell` и по строке на экран (`src/ui/screens/rows.ts`). Ею пользуются и
 * диспетчер маршрутов (`src/ui/server.ts`), и `readSettings`, и `readModels`:
 * ключ кеша один, и разрешать его разными наборами строк поставки нельзя —
 * второй вызов снял бы ядро первого как «разошедшееся».
 *
 * Сборка идёт на каждый вызов: совпавшее дерево не пересобирает ничего
 * (`resolveWithCachedKernel`, сравнение `treeEqual`), а разошедшееся снимает
 * прежнее ядро и поднимает новое — это и есть «правка патча действует со
 * следующего запроса» (`ui-daemon`).
 */

export interface DaemonKernel {
  readonly resolved: ResolvedConfig;
  readonly registry: Registry;
  /**
   * Итог каждой строки дерева (`RowOutcome`, `user-plugins`, design.md
   * Решение 10) — того самого состава, что лежит в `registry`: состояние
   * каталожной строки (действует, отключена, отказ с причиной) иначе было бы
   * неоткуда взять — с одним `enabled` отказавшая строка неотличима от
   * действующей. Переживает попадание в кеш ядра: дерево совпало, значит
   * итоги описывают тот же состав.
   */
  readonly outcomes: readonly RowOutcome[];
  /**
   * Действующий состав браузерных строк плагинов домашнего слоя (design.md
   * изменения `hot-swap-preserves-data`, Решение 1, 12): строка, отключённая
   * патчем или исчезнувшая из дерева, сюда не попадает. Переживает попадание
   * в кеш ядра тем же приёмом, что `outcomes`.
   *
   * Развилка «кто владеет составом» решена в пользу `currentDaemonKernel`, а
   * не сервиса на контексте ядра демона (строка `ui-shell` рядом со
   * `screens`/`api`): состав собирается из `onDirectoryRow`
   * (`src/core/plugins/load.ts`) — колбэка, который зовётся ПО ХОДУ сборки
   * дерева, до того как реестр вообще существует, — а `ctx.screens`/`ctx.api`
   * появляются только ПОСЛЕ того, как дерево применилось (строка каркаса —
   * такая же строка дерева, как и любая другая). Заводить сервис ради поля,
   * заполняемого раньше, чем сам сервис появится, значило бы держать
   * состояние в двух местах и синхронизировать их вручную.
   */
  readonly plugins: readonly ActivePluginRow[];
  /** Действующий состав экранов — сервис `screens` ядра, породившего `registry`. */
  readonly screens: ReadonlyMap<string, ActiveScreen>;
  /** Маршруты того же ядра — их ищет диспетчер (`src/ui/server.ts`). */
  readonly api: ApiRoutes;
  /**
   * Причина последнего отказа сборки дерева, если он случился на этом вызове;
   * `undefined` — сборка удалась. Отказ MUST NOT менять действующий состав
   * (design.md, Решение 7): `resolved`/`registry` в этом случае — прежний
   * успешно собранный кернел либо, если ни один ещё не удался, встроенный.
   */
  readonly buildError: string | undefined;
  /**
   * Действующим стал запасной встроенный состав: сборка отказала, и ни одна
   * ещё не удавалась. Конфигурация в нём — не пользовательская (ни домашнего
   * слоя, ни проектного), поэтому всё, что отвечает значениями конфигурации,
   * а не составом экранов, обязано отказать с названной причиной, а не выдать
   * умолчания за настройки пользователя (`src/ui/settings.ts`,
   * `src/ui/models.ts`).
   */
  readonly fallback: boolean;
}

interface Built {
  readonly resolved: ResolvedConfig;
  readonly registry: Registry;
  readonly outcomes: readonly RowOutcome[];
  readonly plugins: readonly ActivePluginRow[];
}

interface DaemonKernelState {
  /** Последний успешно собранный состав. Снова `undefined` — если он оказался негодным (нет сервисов). */
  last?: Built | undefined;
  /** Запасное ядро встроенного состава: поднимается один раз на кеш, а не на запрос. */
  fallback?: Built;
}

/**
 * Состояние по кешу ядер, а не модульный синглтон: тесты поднимают несколько
 * демонов в одном процессе (`src/ui/pipelines.ts`, комментарий о кеше ядер),
 * и общее состояние связало бы их между собой. Ключ — сам `KernelCache`
 * сервера; вызов без кеша (тесты, прямые обращения) получает состояние на
 * один вызов и ничего не переживает до следующего.
 */
const states = new WeakMap<KernelCache, DaemonKernelState>();

function stateFor(cache: KernelCache | undefined): DaemonKernelState {
  if (cache === undefined) return {};
  let state = states.get(cache);
  if (state === undefined) {
    state = {};
    states.set(cache, state);
  }
  return state;
}

/**
 * Ядро встроенного состава — строки движка плюс строки витрины, применённые
 * без домашнего и проектного слоёв (design.md, Решение 7): используется,
 * когда ни одна сборка ещё не удалась, — витрина обязана открыться хотя бы
 * для того, чтобы показать причину отказа. Путь глобального конфига называет
 * заведомо отсутствующий файл, поэтому чтение слоёв не касается того же
 * файла, который уже отказал: домашний и проектный патчи в эту сборку не
 * входят вовсе, а не читаются повторно.
 */
async function builtinOnlyKernel(home: string): Promise<Built> {
  const resolved = resolveConfig({
    cwd: home,
    home,
    globalPath: join(home, '.stepcast', '__builtin-fallback__', 'config.yml'),
    projectPath: null,
    builtinRows: UI_ROWS.map((row) => row.id),
  });
  const { registry, outcomes } = await loadPlugins(resolved, { projectRoot: home, builtinRows: UI_ROWS });
  return { resolved, registry, outcomes, plugins: [] };
}

/**
 * Сервисы состава, заведённые строкой каркаса. Их может не быть вовсе: патч
 * вправе отключить `ui-shell` (`docs/config.md` предлагает эту форму для любой
 * встроенной строки), и собранное таким патчем дерево обслуживать запросы не
 * может — реестра маршрутов в нём нет. Читаются проверкой, а не обращением
 * напрямую: `ctx.screens` у такого ядра — `undefined`, и обращение к нему
 * бросило бы `TypeError` мимо разбора отказа сборки, то есть уронило бы демон
 * на необработанном отклонении промиса.
 */
function screenServices(registry: Registry): { screens: ScreensService; api: ApiService } | undefined {
  const { ctx } = kernelFromRegistry(registry);
  const screens = ctx.screens as ScreensService | undefined;
  const api = ctx.api as ApiService | undefined;
  return screens === undefined || api === undefined ? undefined : { screens, api };
}

/** Отказ сборки в текст: причина приходит в `GET /api/screens` и показывается на странице. */
function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function currentDaemonKernel(
  kernelCache: KernelCache | undefined,
  home: string = homedir(),
): Promise<DaemonKernel> {
  const state = stateFor(kernelCache);
  let buildError: string | undefined;

  // Состав браузерных строк собирается по ходу сборки дерева, тем же
  // колбэком, что и вклад строки каркаса (`onDirectoryRow`, `LoadOptions`,
  // design.md изменения `hot-swap-preserves-data`, Решение 1): каждая
  // директорийная строка с браузерной половиной в манифесте добавляет себя
  // сюда. Строка без браузерной половины, отключённая патчем (не доходит до
  // `applyTreeRow` вовсе) или отказавшая при применении (кидает раньше, чем
  // вызовет колбэк) — не добавляется.
  const collectedPlugins: ActivePluginRow[] = [];

  try {
    const { resolved, registry, outcomes } = await resolveWithCachedKernel(
      `home:${home}`,
      { cwd: home, home, projectPath: null },
      home,
      kernelCache,
      UI_ROWS,
      ({ row, manifest }) => {
        if (manifest.browser === undefined) return;
        // Каталог и путь половины — из манифеста, а не из `id`: каталожная
        // строка вправе лежать вне `~/.stepcast/plugins/` (`use: ./путь`), и
        // предполагаемый путь дал бы отпечаток несуществующего каталога и
        // поиск половины не там, где она есть.
        collectedPlugins.push({ id: row.id, dir: manifest.dir, browser: manifest.browser });
      },
    );
    if (screenServices(registry) === undefined) {
      // Дерево собралось, но обслуживать им нечего. Прежнее ядро к этому
      // моменту уже снято кешем (дерево-то разошлось), поэтому «последним
      // успешно собранным составом» становится запасной встроенный — витрина
      // обязана открыться хотя бы затем, чтобы назвать причину (Решение 7).
      state.last = undefined;
      buildError = `Строка ${UI_SHELL_ROW.id} не применена: без неё у демона нет ни реестра экранов, ни реестра маршрутов`;
    } else {
      // Итоги приходят `undefined`, когда реестр взят из кеша (дерево совпало,
      // `loadPlugins` не звался): описывают тот же состав прежние итоги, и
      // выбрасывать их означало бы потерять состояние каталожных строк на
      // каждом втором запросе. Состав браузерных строк — тем же приёмом:
      // `onDirectoryRow` не звался вовсе, и `collectedPlugins` пуст, но не по
      // тому, что строк не осталось, а по тому, что сборки не было.
      state.last = {
        resolved,
        registry,
        outcomes: outcomes ?? state.last?.outcomes ?? [],
        plugins: outcomes === undefined ? state.last?.plugins ?? [] : collectedPlugins,
      };
    }
  } catch (error) {
    buildError = reasonOf(error);
  }

  // Запасное ядро остаётся отдельно от последнего успешно собранного: если
  // ни одна сборка ещё не удалась, это обязано быть видно и на следующем
  // запросе тоже — иначе настройки начали бы выдавать встроенные умолчания за
  // значения пользователя, один раз отказав и больше об этом не вспомнив.
  const fallback = state.last === undefined;
  let active = state.last;
  if (active === undefined) {
    if (state.fallback === undefined) {
      state.fallback = await builtinOnlyKernel(home);
      // Запасное ядро тоже обязано быть снято при остановке сервера — тем же
      // правилом, что и удержанные `resolveWithCachedKernel` ядра, иначе оно
      // текло бы всё время жизни демона. Поднимается оно один раз на кеш, а
      // не на запрос: отказ сборки может держаться сколько угодно долго.
      kernelCache?.raised.add(kernelFromRegistry(state.fallback.registry));
    }
    active = state.fallback;
  }

  const services = screenServices(active.registry);
  return {
    resolved: active.resolved,
    registry: active.registry,
    outcomes: active.outcomes,
    plugins: active.plugins,
    // Запасное ядро собрано из тех же `UI_ROWS`, поэтому сервисы у него есть
    // всегда; пустой состав — ответ на случай, которого быть не может, но
    // который не имеет права стать `TypeError` в долгоживущем процессе.
    screens: services?.screens.active ?? new Map(),
    api: services?.api ?? NO_ROUTES,
    buildError,
    fallback,
  };
}
