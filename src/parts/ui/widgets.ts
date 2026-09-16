import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';

import { listProjects } from '../pipeline/run/journal/reader.js';
import { isSafeSegment } from './routes.js';
import { SHARED_MODULE_LIST, WIDGET_ERROR_EXPORT, WIDGET_STYLE_EXPORT } from './daemon/sharedModules.js';
import { parseWidgetImports, unresolvedSharedNames, type UnresolvedSharedKind } from './widgetImports.js';

/**
 * Виджет пользователя — файл `<проект>/.stepcast/widgets/<id>.tsx`.
 *
 * Три обязанности этого модуля: перечислить виджеты проекта (тем же обходом
 * `projects.json`, каким `buildSteps` читает каталог переиспользуемых шагов,
 * `src/parts/ui/steps.ts:149`), разрешить адрес виджета в путь на диске без выхода
 * за каталог (приём `resolveJournalPath`, `src/parts/ui/file.ts:62`), и
 * скомпилировать файл — одним `transform`, не разрешая его импортов
 * (design.md, Решение 2).
 *
 * Кеш компиляции и сам компилятор — на стороне вызывающего (`createUiServer`,
 * design.md Решение 11): фабрика заводится здесь, но живёт снаружи, потому
 * что тесты поднимают несколько серверов в одном процессе, и модульный
 * синглтон связал бы их между собой.
 */

const WIDGET_EXTENSION = '.tsx';

export function widgetsDirPath(projectPath: string): string {
  return join(projectPath, '.stepcast', 'widgets');
}

/**
 * Идентификаторы виджетов верхнего уровня каталога виджетов проекта,
 * отсортированные. Вложенные каталоги и файлы иного расширения не считаются
 * виджетами; символическая ссылка не проходит фильтр `isFile()` — тип записи
 * `readdirSync` берётся не по её цели, а по самой записи каталога.
 */
export function listProjectWidgetIds(projectPath: string): readonly string[] {
  const dir = widgetsDirPath(projectPath);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && extname(entry.name) === WIDGET_EXTENSION)
    .map((entry) => basename(entry.name, WIDGET_EXTENSION))
    .sort();
}

/**
 * Путь виджета на диске — или `undefined`, если адрес не проходит проверку:
 * небезопасный сегмент, отсутствующий файл, либо реальный путь (`realpath`)
 * вне каталога виджетов. Последнее закрывает символическую ссылку из
 * каталога виджетов наружу (design.md, Решение 10): без приведения к
 * реальному пути такая ссылка вынесла бы содержимое любого файла диска мимо
 * проверки сегмента.
 */
export function resolveWidgetFile(projectPath: string, id: string): string | undefined {
  if (!isSafeSegment(id)) return undefined;

  const dir = widgetsDirPath(projectPath);
  const target = join(dir, `${id}${WIDGET_EXTENSION}`);
  if (!existsSync(target)) return undefined;

  let realDir: string;
  let realTarget: string;
  try {
    realDir = realpathSync(dir);
    realTarget = realpathSync(target);
  } catch {
    return undefined;
  }

  // Сравнение с разделителем на конце — тот же приём, что у `resolveJournalPath`:
  // без него каталог-сосед с общим префиксом прошёл бы как вложенный.
  if (!realTarget.startsWith(realDir + sep)) return undefined;
  return realTarget;
}

export interface FileFingerprint {
  readonly mtimeMs: number;
  readonly size: number;
}

/** Отпечаток файла виджета — тем же приёмом, что у наблюдателя (`mtime` и размер вместе). */
export function widgetFingerprint(path: string): FileFingerprint | undefined {
  try {
    const stat = statSync(path);
    return { mtimeMs: stat.mtimeMs, size: stat.size };
  } catch {
    return undefined;
  }
}

/** Отпечаток строкой — ключ кеша компиляции и версия виджета в потоке событий. */
export function fingerprintVersion(fingerprint: FileFingerprint): string {
  return `${fingerprint.mtimeMs}:${fingerprint.size}`;
}

/**
 * Причина устаревания: то, чего действующая таблица больше не несёт, — сам
 * голый спецификатор (`kind: 'specifier'`) либо имя его клаузы (`kind:
 * 'name'`), — и, если есть, текст записи о смене (`widget-migration`,
 * Решение 9).
 */
export interface WidgetDeprecation {
  readonly kind: UnresolvedSharedKind;
  readonly name: string;
  readonly noteText?: string;
}

export interface WidgetView {
  readonly id: string;
  readonly version: string;
  /** Не отменяет отдачу виджета — устаревший виджет по-прежнему компилируется (`widget-migration`, «Признак не отменяет отдачу виджета»). */
  readonly deprecated?: WidgetDeprecation;
}

export interface ProjectWidgetsView {
  readonly projectKey: string;
  readonly widgets: readonly WidgetView[];
}

export interface WidgetsOverview {
  readonly projects: readonly ProjectWidgetsView[];
  readonly generatedAt: string;
}

/**
 * Причина устаревания, выведенная из самого файла виджета — без единого
 * файла состояния в кабинете проекта (`widget-migration`, «Признак не
 * требует состояния в проекте»). Файл, ставший нечитаемым между
 * перечислением и этим чтением, — не отказ: виджет просто не назван
 * устаревшим, той же гонкой, что и у отпечатка.
 */
function widgetDeprecation(path: string): WidgetDeprecation | undefined {
  let source: string;
  try {
    source = readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
  const first = unresolvedSharedNames(parseWidgetImports(source))[0];
  if (first === undefined) return undefined;
  return {
    kind: first.kind,
    name: first.name,
    ...(first.noteText === undefined ? {} : { noteText: first.noteText }),
  };
}

/** Виджет с версией, но без признака устаревания — дешёвая часть состава: один `stat` на файл. */
export interface WidgetVersionView {
  readonly id: string;
  readonly version: string;
}

/**
 * Виджеты одного проекта с версией каждого и **без** чтения их содержимого —
 * ровно то, что нужно части отпечатка наблюдателя (`src/parts/ui/daemon/watcher.ts`):
 * версия выводится из `mtime`+размера, а такт опроса идёт раз в секунду по
 * каждому виджету каждого проекта, и читать там исходники было бы чистой
 * тратой. Признак устаревания считается не здесь, а в `buildProjectWidgets` —
 * то есть на такте, где часть отпечатка уже сдвинулась, и состав всё равно
 * пересобирается.
 *
 * Файл, исчезнувший между перечислением и отпечатком, пропускается — обычная
 * гонка с правкой на диске.
 */
export function projectWidgetVersions(projectPath: string): readonly WidgetVersionView[] {
  const dir = widgetsDirPath(projectPath);
  const widgets: WidgetVersionView[] = [];
  for (const id of listProjectWidgetIds(projectPath)) {
    const fingerprint = widgetFingerprint(join(dir, `${id}${WIDGET_EXTENSION}`));
    if (fingerprint === undefined) continue;
    widgets.push({ id, version: fingerprintVersion(fingerprint) });
  }
  return widgets;
}

/** Виджеты одного проекта — версия плюс признак устаревания, выведенный из самого файла. */
export function buildProjectWidgets(projectPath: string): readonly WidgetView[] {
  const dir = widgetsDirPath(projectPath);
  return projectWidgetVersions(projectPath).map((widget) => {
    const deprecated = widgetDeprecation(join(dir, `${widget.id}${WIDGET_EXTENSION}`));
    return { ...widget, ...(deprecated === undefined ? {} : { deprecated }) };
  });
}

/**
 * Виджеты всех проектов, известных корню прогонов — тем же обходом, что и
 * `buildSteps`. Проект без каталога виджетов остаётся записью с пустым
 * списком (сценарий «Каталога виджетов нет»), а не пропадает из обзора: так
 * его отличают от проекта без известного пути, которого в обзоре нет вовсе.
 */
export function buildWidgets(runsRoot: string): WidgetsOverview {
  const projects: ProjectWidgetsView[] = [];
  for (const project of listProjects(runsRoot)) {
    if (project.path === undefined || !existsSync(project.path)) continue;
    projects.push({ projectKey: project.key, widgets: buildProjectWidgets(project.path) });
  }
  return { projects, generatedAt: new Date().toISOString() };
}

/** Разобранная ошибка компиляции: путь файла, строка, колонка, текст (design.md, Решение 8). */
export interface CompileFailure {
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly text: string;
}

export type CompileOutcome =
  | { readonly kind: 'ok'; readonly code: string }
  | { readonly kind: 'error'; readonly failure: CompileFailure };

/**
 * Поверхность esbuild, которой пользуется этот модуль: `transform` компилирует
 * один файл (виджет), `stop` останавливает служебный процесс (design.md,
 * Решение 12). `build` — второй режим, сборка бандла для браузерной половины
 * плагина (design.md изменения `hot-swap-preserves-data`, Решение 13);
 * необязателен, чтобы не ломать подставные компиляторы существующих тестов
 * (`test/ui-widgets.test.ts`, `test/ui-server.test.ts`), которым бандл не нужен.
 */
/** Вход сборки в `metafile` esbuild — только те поля, которые здесь читаются. */
interface MetafileInput {
  readonly imports?: readonly {
    /** Путь, в который разрешён импорт: ключ другого входа — или сам специфик, если импорт внешний. */
    readonly path: string;
    /** Импорт остался внешним именем и в бандл не втянут. */
    readonly external?: boolean;
  }[];
}

export interface EsbuildTransformApi {
  transform(input: string, options: Record<string, unknown>): Promise<{ readonly code: string }>;
  build?(options: Record<string, unknown>): Promise<{
    readonly outputFiles: readonly { readonly path: string; readonly text: string }[];
    /**
     * Входы сборки (`metafile: true` в опциях) — по ним ловится свой
     * экземпляр общего модуля, принесённый мимо голого имени (design.md
     * изменения `shared-module-table`, Решение 9): внешние специфаки
     * (`external`) сюда не попадают вовсе, esbuild их не читает.
     *
     * Поле необязательно только в типе: сборка зовётся с `metafile: true`, и
     * результат без него — отказ, а не пропуск проверки (`compileBundle`).
     * У каждого входа читается `imports`: `original` несёт специфик так, как
     * его написал автор, и отличает свою копию (`./vendor/react.js`) от
     * подпути установленного пакета (`react-dom/client`) — отказы у них
     * разные.
     */
    readonly metafile?: { readonly inputs: Readonly<Record<string, MetafileInput | undefined>> };
  }>;
  stop(): Promise<void> | void;
}

/** Форма `TransformFailure` esbuild — своя, а не импортированная: нужны только поля, которые здесь читаются. */
interface EsbuildTransformFailure {
  readonly errors?: readonly {
    readonly text: string;
    readonly location?: { readonly line: number; readonly column: number } | null;
  }[];
  readonly message?: string;
}

async function importEsbuild(): Promise<EsbuildTransformApi> {
  // Динамический импорт — не только лень (демон без виджетов не поднимает
  // службу), но и единственное место, где отказ пакета или его
  // платформенного бинарника (`@esbuild/<платформа>`) становится значением,
  // а не необработанным исключением, роняющим демон (design.md, Риск 1).
  return (await import('esbuild')) as unknown as EsbuildTransformApi;
}

/**
 * Подъём компилятора: отказ становится названной ошибкой **и** строкой в логе
 * демона (требование ui-daemon). Строка нужна потому, что ответ с ошибкой
 * видит только тот, кто открыл экран виджетов, а причина у отказа общая для
 * демона — зависимости нет или она не собрана для этой платформы, — и
 * искать её будут в `~/.stepcast/ui.log`. Логируется один раз: результат
 * подъёма кеширован вызывающим, и повторный запрос виджета берёт тот же
 * отказавший промис, а не зовёт этот код заново.
 */
async function loadEsbuild(
  load: () => Promise<EsbuildTransformApi>,
  log: (line: string) => void,
): Promise<EsbuildTransformApi> {
  try {
    return await load();
  } catch (error) {
    const message =
      `Компилятор виджетов недоступен: зависимость "esbuild" не установлена или не собрана ` +
      `для этой платформы (${(error as Error).message})`;
    log(message);
    throw new Error(message);
  }
}

/** Ошибка эсбилда — структурная (`TransformFailure.errors`) — или любая другая, включая отказ подъёма службы. */
function toFailure(file: string, error: unknown): CompileFailure {
  const failure = error as EsbuildTransformFailure;
  const first = failure.errors?.[0];
  if (first !== undefined) {
    return {
      file,
      line: first.location?.line ?? 0,
      column: first.location?.column ?? 0,
      text: first.text,
    };
  }
  return { file, line: 0, column: 0, text: failure.message ?? String(error) };
}

/** Имя пакета npm из специфика таблицы: `react/jsx-runtime` → `react`, `@stepcast/slots` → `@stepcast/slots`. */
function packageNameFromSpecifier(specifier: string): string {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? `${parts[0]}/${parts[1]}` : (parts[0] as string);
}

/**
 * Имена пакетов таблицы общих модулей — множество, не список: `react` и
 * `react/jsx-runtime` дают один и тот же пакет, и второй записи здесь не
 * нужно (design.md изменения `shared-module-table`, Решение 9).
 */
const SHARED_PACKAGE_NAMES: ReadonlySet<string> = new Set(
  SHARED_MODULE_LIST.map((entry) => packageNameFromSpecifier(entry.specifier)),
);

/**
 * Имя пакета, которому принадлежит файл, — по ближайшему `package.json`
 * вверх по дереву от файла (design.md, Решение 9). `undefined` — файл не
 * входит ни в один пакет (ближайший `package.json`, если и есть, не назвал
 * `name` строкой) или дерево кончилось раньше, чем package.json нашёлся —
 * свои файлы плагина без единого `package.json` в предках именно так себя и
 * ведут, и это не отказ, а обычный случай.
 */
function nearestPackageName(absFile: string): string | undefined {
  let dir = dirname(absFile);
  for (;;) {
    const candidate = join(dir, 'package.json');
    if (existsSync(candidate)) {
      try {
        const pkg = JSON.parse(readFileSync(candidate, 'utf8')) as { readonly name?: unknown };
        return typeof pkg.name === 'string' ? pkg.name : undefined;
      } catch {
        return undefined;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * Свой экземпляр общего модуля в бандле — вход сборки, чей ближайший
 * `package.json` носит имя пакета из таблицы (design.md, Решение 9).
 * Внешние специфаки (`external: SHARED_MODULE_LIST...`) в `metafile.inputs`
 * не попадают вовсе — esbuild не читает их файлов, — поэтому голый
 * `import 'react'` этой проверки не касается: только копия, принесённая мимо
 * имени.
 */
interface OwnSharedModuleCopy {
  readonly file: string;
  readonly packageName: string;
}

/** Специфик ведёт на пакет, а не на файл рядом: не относительный и не абсолютный. */
function isBareSpecifier(specifier: string): boolean {
  return !specifier.startsWith('.') && !specifier.startsWith('/');
}

/** Специфаки таблицы, принадлежащие одному пакету: у `react` их два — само имя и `react/jsx-runtime`. */
function sharedSpecifiersOfPackage(packageName: string): string {
  return SHARED_MODULE_LIST.filter(
    (sharedEntry) => packageNameFromSpecifier(sharedEntry.specifier) === packageName,
  )
    .map((sharedEntry) => `"${sharedEntry.specifier}"`)
    .join(', ');
}

function findOwnSharedModuleCopy(metafile: {
  readonly inputs: Readonly<Record<string, MetafileInput | undefined>>;
}): OwnSharedModuleCopy | undefined {
  for (const relativeInput of Object.keys(metafile.inputs)) {
    const file = resolve(relativeInput);
    const packageName = nearestPackageName(file);
    if (packageName !== undefined && SHARED_PACKAGE_NAMES.has(packageName)) return { file, packageName };
  }
  return undefined;
}

/** Отказ сборки, названный файлом, именем таблицы и способом исправления (design.md, Решение 9). */
function ownSharedModuleCopyFailure(entry: string, copy: OwnSharedModuleCopy): CompileFailure {
  return {
    file: entry,
    line: 0,
    column: 0,
    text:
      `Браузерная половина приносит собственный экземпляр общего модуля витрины: файл ${copy.file} ` +
      `принадлежит пакету "${copy.packageName}", а это имя есть в таблице общих модулей. Импортируйте ` +
      `${sharedSpecifiersOfPackage(copy.packageName)} голым именем — экземпляр даст страница, свой в ` +
      `бандл приносить нельзя.`,
  };
}

/** Специфаки таблицы — множество для проверки точного совпадения, не по имени пакета. */
const SHARED_SPECIFIERS: ReadonlySet<string> = new Set(SHARED_MODULE_LIST.map((entry) => entry.specifier));

/**
 * Подпуть пакета таблицы, которого в самой таблице нет: `react-dom/client`,
 * `react/jsx-dev-runtime`. Внешним такой импорт остаётся (esbuild считает
 * внешними и подпути внешнего пакета), в бандл не втягивается — и потому
 * мимо проверки своего экземпляра проходит целиком. Но карта имён страницы
 * несёт ровно специфаки таблицы, и браузер на таком бандле откажет уже при
 * `import()`: «Failed to resolve module specifier», без строки о причине и
 * без файла, в котором её искать.
 *
 * Отсюда отказ на сборке: подпуть, которого таблица не несёт, — не рабочий
 * плагин, и узнать об этом автор должен от демона, а не от консоли чужого
 * браузера.
 */
function findUnmappedSharedSubpath(metafile: {
  readonly inputs: Readonly<Record<string, MetafileInput | undefined>>;
}): { readonly specifier: string; readonly packageName: string } | undefined {
  for (const input of Object.values(metafile.inputs)) {
    for (const imported of input?.imports ?? []) {
      const specifier = imported.path;
      if (!isBareSpecifier(specifier) || SHARED_SPECIFIERS.has(specifier)) continue;
      const packageName = packageNameFromSpecifier(specifier);
      if (SHARED_PACKAGE_NAMES.has(packageName)) return { specifier, packageName };
    }
  }
  return undefined;
}

/** Отказ подпути сверх таблицы: назвать сам подпуть, то, что таблица несёт, и способ завести новое имя. */
function unmappedSharedSubpathFailure(
  entry: string,
  subpath: { readonly specifier: string; readonly packageName: string },
): CompileFailure {
  return {
    file: entry,
    line: 0,
    column: 0,
    text:
      `Браузерная половина импортирует "${subpath.specifier}" — подпуть пакета "${subpath.packageName}", ` +
      `которого нет в таблице общих модулей: карта имён страницы несёт ровно её специфаки ` +
      `(${sharedSpecifiersOfPackage(subpath.packageName)}), и браузер отказал бы этому импорту при ` +
      `загрузке. Возьмите нужное из ${sharedSpecifiersOfPackage(subpath.packageName)}; подпуть сверх ` +
      `таблицы заводится её пополнением (docs/plugins.md), а не импортом.`,
  };
}

/**
 * Текст модуля ошибки компиляции: `import()` браузера превращает любой не-2xx
 * ответ в `TypeError` без тела, поэтому демон отдаёт ошибку тем же 200 и
 * исполняемым модулем, что и рабочий результат (design.md, Решение 8) — с
 * той разницей, что вместо компонента модуль экспортирует разобранную ошибку
 * под объявленным именем; хост читает его после `import()`, заголовок ответа
 * (`sendWidgetModule` в `src/parts/ui/daemon/server.ts`) — для `curl` и проверки, не
 * исполняющих JS.
 */
export function errorModuleText(failure: CompileFailure): string {
  return (
    `export const ${WIDGET_ERROR_EXPORT} = ${JSON.stringify(failure)};\n` + `export default undefined;\n`
  );
}

interface CacheEntry {
  readonly version: string;
  readonly outcome: CompileOutcome;
}

/** Записей без предела копится по одной на каждое сохранение файла за долгую сессию правок (design.md, Решение 11). */
const DEFAULT_MAX_CACHE_ENTRIES = 200;

export interface WidgetCompilerOptions {
  readonly maxCacheEntries?: number;
  /** Лог демона: сюда идёт строка об отказе подъёма компилятора. По умолчанию — `stderr`, тем же приёмом, что у наблюдателя. */
  readonly log?: (line: string) => void;
  /**
   * Подъём компилятора. Объявлен опцией ради проверки ветки «зависимости нет»:
   * иначе сценарий воспроизводился бы только сносом `node_modules/esbuild`, то
   * есть не воспроизводился бы вовсе, и деградация «ошибка есть в ответе, но
   * её нет в логе» осталась бы незамеченной (требование ui-daemon).
   */
  readonly loadCompiler?: () => Promise<EsbuildTransformApi>;
}

export interface WidgetCompiler {
  /**
   * Скомпилировать файл виджета, используя кеш по отпечатку. `undefined` —
   * файл исчез между разрешением адреса и компиляцией (гонка с правкой на
   * диске); вызывающий обязан ответить тем же 404, что и на отсутствующий
   * файл.
   */
  compile(path: string): Promise<CompileOutcome | undefined>;
  /**
   * Собрать браузерную половину плагина бандлом: локальные относительные
   * импорты разрешаются и попадают в один модуль, React и его подпути — во
   * внешних именах (тот же контракт, что у виджета — переходники
   * `src/parts/ui/widgetRuntime.ts`); CSS выхода дописывается в текст модуля
   * экспортом стилей, а не вставляется модулем самостоятельно (design.md
   * изменения `hot-swap-preserves-data`, Решение 7, 13). Кеш — по `cacheKey`
   * (отпечаток каталога плагина, `directoryFingerprint`, `src/parts/ui/plugins.ts`),
   * не по файлу: правка любого файла каталога обязана обесценить запись.
   * `undefined` — файл исчез между разрешением адреса и сборкой.
   */
  compileBundle(entry: string, cacheKey: string): Promise<CompileOutcome | undefined>;
  /** Остановить служебный процесс компилятора, если он был поднят. */
  dispose(): Promise<void>;
}

/**
 * Фабрика компилятора: кеш по «путь + `mtime` + размер», ограниченный числом
 * записей, и ленивый подъём `esbuild` первым вызовом `compile()`. Заводится
 * вызывающим (`createUiServer`), не модулем — общий кеш связал бы серверы,
 * поднятые в одном процессе проверки, между собой.
 */
export function createWidgetCompiler(options: WidgetCompilerOptions = {}): WidgetCompiler {
  const maxEntries = options.maxCacheEntries ?? DEFAULT_MAX_CACHE_ENTRIES;
  const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const load = options.loadCompiler ?? importEsbuild;
  const cache = new Map<string, CacheEntry>();
  const bundleCache = new Map<string, CacheEntry>();
  let esbuild: Promise<EsbuildTransformApi> | undefined;

  return {
    async compile(path) {
      const fingerprint = widgetFingerprint(path);
      if (fingerprint === undefined) return undefined;
      const version = fingerprintVersion(fingerprint);

      const cached = cache.get(path);
      if (cached !== undefined && cached.version === version) {
        // Переставить в конец очереди вытеснения: недавно спрошенная запись
        // не должна уходить первой.
        cache.delete(path);
        cache.set(path, cached);
        return cached.outcome;
      }

      let source: string;
      try {
        source = readFileSync(path, 'utf8');
      } catch {
        return undefined;
      }

      let outcome: CompileOutcome;
      try {
        esbuild ??= loadEsbuild(load, log);
        const compiler = await esbuild;
        const result = await compiler.transform(source, {
          loader: 'tsx',
          jsx: 'automatic',
          format: 'esm',
          sourcefile: path,
        });
        outcome = { kind: 'ok', code: result.code };
      } catch (error) {
        outcome = { kind: 'error', failure: toFailure(path, error) };
      }

      cache.set(path, { version, outcome });
      if (cache.size > maxEntries) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
      }
      return outcome;
    },

    async compileBundle(entry, cacheKey) {
      if (!existsSync(entry)) return undefined;

      const cached = bundleCache.get(entry);
      if (cached !== undefined && cached.version === cacheKey) {
        bundleCache.delete(entry);
        bundleCache.set(entry, cached);
        return cached.outcome;
      }

      let outcome: CompileOutcome;
      try {
        esbuild ??= loadEsbuild(load, log);
        const compiler = await esbuild;
        if (compiler.build === undefined) {
          throw new Error('Компилятор виджетов не поддерживает сборку бандла');
        }
        const result = await compiler.build({
          entryPoints: [entry],
          bundle: true,
          write: false,
          format: 'esm',
          jsx: 'automatic',
          outdir: 'stepcast-plugin-bundle',
          // Внешними остаются ровно имена таблицы общих модулей — второго
          // перечня здесь нет (design.md изменения `shared-module-table`,
          // Решение 1; `ui-dashboard`, «Имена сборки — те же, что у страницы»).
          external: SHARED_MODULE_LIST.map((sharedEntry) => sharedEntry.specifier),
          loader: { '.css': 'css' },
          // Входы сборки — чтобы поймать свой экземпляр общего модуля,
          // принесённый мимо голого имени (design.md, Решение 9).
          metafile: true,
        });

        // Свой экземпляр общего модуля — отказ раньше, чем результат сборки
        // вообще стал бы кодом: второй React не должен попасть на страницу
        // (design.md, Решение 9, `ui-dashboard` «Свой экземпляр общего модуля
        // в бандле»). Отказ доставляется тем же путём, что и ошибка
        // компиляции, — `errorModuleText` в `src/parts/ui/daemon/server.ts` не знает
        // разницы между этой причиной и синтаксической ошибкой.
        //
        // Результата без `metafile` быть не должно — сборка зовётся с
        // `metafile: true`, — а если он всё же пришёл (подставной компилятор
        // теста, чужая сборка esbuild), проверить принесённый экземпляр
        // нечем. Тихо пропустить бандл дальше значило бы отдать странице
        // второй React без единой строки лога — ровно тот исход, который
        // Решение 9 и закрывает; поэтому здесь отказ с названной причиной.
        if (result.metafile === undefined) {
          throw new Error(
            'Сборка бандла не дала metafile: проверить, не принёс ли плагин свой экземпляр общего модуля, нечем',
          );
        }
        const ownCopy = findOwnSharedModuleCopy(result.metafile);
        const subpath = ownCopy === undefined ? findUnmappedSharedSubpath(result.metafile) : undefined;
        if (ownCopy !== undefined) {
          outcome = { kind: 'error', failure: ownSharedModuleCopyFailure(entry, ownCopy) };
        } else if (subpath !== undefined) {
          outcome = { kind: 'error', failure: unmappedSharedSubpathFailure(entry, subpath) };
        } else {
          const jsFile = result.outputFiles.find((file) => file.path.endsWith('.js'));
          const cssFile = result.outputFiles.find((file) => file.path.endsWith('.css'));
          if (jsFile === undefined) throw new Error('Сборка бандла не дала JS-выхода');
          const code =
            cssFile === undefined
              ? jsFile.text
              : `${jsFile.text}\nexport const ${WIDGET_STYLE_EXPORT} = ${JSON.stringify(cssFile.text)};\n`;
          outcome = { kind: 'ok', code };
        }
      } catch (error) {
        outcome = { kind: 'error', failure: toFailure(entry, error) };
      }

      bundleCache.set(entry, { version: cacheKey, outcome });
      if (bundleCache.size > maxEntries) {
        const oldest = bundleCache.keys().next().value;
        if (oldest !== undefined) bundleCache.delete(oldest);
      }
      return outcome;
    },

    async dispose() {
      if (esbuild === undefined) return;
      try {
        const compiler = await esbuild;
        await compiler.stop();
      } catch {
        // Компилятор не поднялся или уже остановлен — останавливать нечего.
      }
    },
  };
}
