import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { basename, extname, join, sep } from 'node:path';

import { listProjects } from '../core/journal/reader.js';
import { isSafeSegment } from './routes.js';
import { WIDGET_ERROR_EXPORT } from './widgetRuntime.js';

/**
 * Виджет пользователя — файл `<проект>/.stepcast/widgets/<id>.tsx`.
 *
 * Три обязанности этого модуля: перечислить виджеты проекта (тем же обходом
 * `projects.json`, каким `buildSteps` читает каталог переиспользуемых шагов,
 * `src/ui/steps.ts:149`), разрешить адрес виджета в путь на диске без выхода
 * за каталог (приём `resolveJournalPath`, `src/ui/file.ts:62`), и
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

export interface WidgetView {
  readonly id: string;
  readonly version: string;
}

export interface ProjectWidgetsView {
  readonly projectKey: string;
  readonly widgets: readonly WidgetView[];
}

export interface WidgetsOverview {
  readonly projects: readonly ProjectWidgetsView[];
  readonly generatedAt: string;
}

/** Виджеты одного проекта, с версией каждого. Файл, исчезнувший между перечислением и отпечатком, пропускается — та же гонка, что и у `buildProjectWidgets`. */
export function buildProjectWidgets(projectPath: string): readonly WidgetView[] {
  const dir = widgetsDirPath(projectPath);
  const widgets: WidgetView[] = [];
  for (const id of listProjectWidgetIds(projectPath)) {
    const fingerprint = widgetFingerprint(join(dir, `${id}${WIDGET_EXTENSION}`));
    if (fingerprint === undefined) continue;
    widgets.push({ id, version: fingerprintVersion(fingerprint) });
  }
  return widgets;
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

/** Поверхность esbuild, которой пользуется этот модуль — оба API нужны: `transform` компилирует, `stop` останавливает служебный процесс (design.md, Решение 12). */
export interface EsbuildTransformApi {
  transform(input: string, options: Record<string, unknown>): Promise<{ readonly code: string }>;
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

/**
 * Текст модуля ошибки компиляции: `import()` браузера превращает любой не-2xx
 * ответ в `TypeError` без тела, поэтому демон отдаёт ошибку тем же 200 и
 * исполняемым модулем, что и рабочий результат (design.md, Решение 8) — с
 * той разницей, что вместо компонента модуль экспортирует разобранную ошибку
 * под объявленным именем; хост читает его после `import()`, заголовок ответа
 * (`sendWidgetModule` в `src/ui/server.ts`) — для `curl` и проверки, не
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
