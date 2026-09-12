import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { Document, isMap, isSeq, parse as parseYaml, parseDocument, type Node, type YAMLMap } from 'yaml';
import { z } from 'zod';

import { StepcastError } from '../core/errors.js';
import { describeSchemaFailure } from '../core/schema-failure.js';
import { checkDashboardDocument, DashboardDocumentError, type DashboardDefinition } from './dashboards.js';
import { isSafeSegment } from './routes.js';

/**
 * Файл дашборда и его два слоя (`ui-dashboards`, design.md Решение 1, 2, 9,
 * 11). Модуль демона: он один читает диск. Модель ячейки, подстановки и
 * проверки, которым довольно документа, — в `src/ui/dashboards.ts`, общем
 * демону и браузеру.
 */

const ParamScalarSchema = z.union([z.string(), z.number(), z.boolean()]);

const DashboardCellAtSchema = z
  .object({
    column: z.number().int().min(0),
    row: z.number().int().min(0),
    width: z.number().int().min(1),
    height: z.number().int().min(1),
  })
  .strict();

const DashboardCellSchema = z
  .object({
    id: z.string().min(1),
    widget: z.string().min(1),
    at: DashboardCellAtSchema,
    title: z.string().min(1).optional(),
    params: z.record(z.string().min(1), ParamScalarSchema).optional(),
  })
  .strict();

export type DashboardCellRowDocument = z.infer<typeof DashboardCellSchema>;

const DashboardGridSchema = z
  .object({
    columns: z.number().int().min(1).default(12),
  })
  .strict();

export const DashboardDocumentSchema = z
  .object({
    title: z.string().min(1).optional(),
    grid: DashboardGridSchema.default({ columns: 12 }),
    cells: z.array(DashboardCellSchema),
  })
  .strict();

export type DashboardFileDocument = z.infer<typeof DashboardDocumentSchema>;

const DASHBOARD_EXTENSION = '.yml';
const DASHBOARDS_DIR_NAME = 'dashboards';

export function homeDashboardsDirPath(home: string): string {
  return join(home, '.stepcast', DASHBOARDS_DIR_NAME);
}

export function projectDashboardsDirPath(projectRoot: string): string {
  return join(projectRoot, '.stepcast', DASHBOARDS_DIR_NAME);
}

export type DashboardLayerName = 'home' | 'project';

function dashboardPath(dir: string, id: string): string {
  return join(dir, `${id}${DASHBOARD_EXTENSION}`);
}

/**
 * Идентификаторы дашбордов верхнего уровня каталога слоя, отсортированные —
 * тем же приёмом, что `listProjectWidgetIds` (`src/ui/widgets.ts`): вложенный
 * каталог и файл иного расширения дашбордом не считаются.
 */
function listDashboardIds(dir: string): readonly string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    // Каталога нет, он исчез между тактом отпечатка и сборкой либо недоступен
    // на чтение: ни одно из этих состояний не отказ витрины. Проверки `existsSync`
    // тут мало — между ней и `readdirSync` каталог успевает исчезнуть, и тогда
    // исключение уходило бы наружу: на старте — отказом подъёма демона, в такте
    // таймера — необработанным исключением («Каталогов дашбордов нет — пустой
    // состав без отказа»).
    return [];
  }
  return entries
    .filter((entry) => entry.isFile() && extname(entry.name) === DASHBOARD_EXTENSION)
    .map((entry) => basename(entry.name, DASHBOARD_EXTENSION))
    .sort();
}

function parseDashboardDocument(path: string): DashboardFileDocument {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    throw new StepcastError(`Файл дашборда не читается: ${path}`, {
      file: path,
      hint: (error as NodeJS.ErrnoException).message,
      cause: error,
    });
  }

  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (error) {
    throw new StepcastError(`Файл дашборда не разбирается как YAML: ${path}`, { file: path, cause: error });
  }

  const parsed = DashboardDocumentSchema.safeParse(raw);
  if (!parsed.success) {
    const failure = describeSchemaFailure(parsed.error);
    throw new StepcastError(`Файл дашборда ${path} не соответствует формату: ${failure.message}`, {
      file: path,
      ...(failure.at === undefined ? {} : { at: failure.at }),
      hint: 'Формат описан в docs/dashboards.md; схема — schema/dashboard.schema.json',
    });
  }
  return parsed.data;
}

/** Действующий дашборд, названный файлом-источником (`ui-dashboards`, «Действующий дашборд называет файл»). */
export interface DashboardEntry {
  readonly id: string;
  readonly layer: DashboardLayerName;
  readonly file: string;
  readonly document: DashboardDefinition;
}

/** Дашборд, чья сборка отказала — не гасит витрину и не отменяет прочие (`ui-dashboards`, «Отказ файла останавливает дашборд»). */
export interface DashboardFailure {
  readonly id: string;
  readonly layer: DashboardLayerName;
  readonly file: string;
  readonly reason: string;
  readonly at?: string;
}

export interface DashboardsBuildResult {
  readonly dashboards: readonly DashboardEntry[];
  readonly failures: readonly DashboardFailure[];
}

function toCellDefinition(cell: DashboardCellRowDocument): DashboardDefinition['cells'][number] {
  return {
    id: cell.id,
    widget: cell.widget,
    at: cell.at,
    ...(cell.title === undefined ? {} : { title: cell.title }),
    ...(cell.params === undefined ? {} : { params: cell.params }),
  };
}

function toDefinition(document: DashboardFileDocument): DashboardDefinition {
  return {
    ...(document.title === undefined ? {} : { title: document.title }),
    grid: document.grid,
    cells: document.cells.map(toCellDefinition),
  };
}

function buildOneDashboard(id: string, layer: DashboardLayerName, path: string): DashboardEntry {
  const document = toDefinition(parseDashboardDocument(path));
  try {
    checkDashboardDocument(document);
  } catch (error) {
    if (error instanceof DashboardDocumentError) {
      throw new StepcastError(`Дашборд ${id} (${path}): ${error.message}`, {
        file: path,
        at: error.cellIds.join(', '),
      });
    }
    throw error;
  }
  return { id, layer, file: path, document };
}

export interface DashboardBuildOptions {
  readonly home: string;
  /** Корень проекта, в котором поднят демон — `undefined`, если демон его не знает. */
  readonly projectRoot?: string;
}

/**
 * Собрать действующий состав дашбордов двух слоёв. Проектный файл с тем же
 * `<id>` заменяет домашний целиком — слияния по полям здесь нет (Решение 2).
 * Отказ одного дашборда не бросается наружу: он едет в `failures` рядом с
 * прочими собранными (`ui-daemon`, «Сломанный файл не отменяет остальные»).
 */
export function buildDashboards(options: DashboardBuildOptions): DashboardsBuildResult {
  const homeDir = homeDashboardsDirPath(options.home);
  const projectDir = options.projectRoot === undefined ? undefined : projectDashboardsDirPath(options.projectRoot);

  const homeIds = listDashboardIds(homeDir);
  const projectIds = projectDir === undefined ? [] : listDashboardIds(projectDir);
  const allIds = [...new Set([...homeIds, ...projectIds])].sort();

  const dashboards: DashboardEntry[] = [];
  const failures: DashboardFailure[] = [];

  for (const id of allIds) {
    const useProject = projectIds.includes(id);
    const layer: DashboardLayerName = useProject ? 'project' : 'home';
    const dir = useProject ? (projectDir as string) : homeDir;
    const path = dashboardPath(dir, id);
    try {
      dashboards.push(buildOneDashboard(id, layer, path));
    } catch (error) {
      if (error instanceof StepcastError) {
        failures.push({
          id,
          layer,
          file: path,
          reason: error.message,
          ...(error.at === undefined ? {} : { at: error.at }),
        });
        continue;
      }
      throw error;
    }
  }

  return { dashboards, failures };
}

export function writableDashboardPath(layer: DashboardLayerName, id: string, options: DashboardBuildOptions): string {
  if (!isSafeSegment(id)) {
    throw new StepcastError(`Идентификатор дашборда ${id} недопустим`, {
      hint: 'id — один безопасный сегмент пути, без разделителей и без шага вверх по дереву',
    });
  }
  if (layer === 'home') return dashboardPath(homeDashboardsDirPath(options.home), id);
  if (options.projectRoot === undefined) {
    throw new StepcastError('Демон не знает корень проекта — записать проектный слой дашбордов некуда', {
      hint: 'Поднимите витрину в каталоге проекта (stepcast up) либо сохраните дашборд в домашний слой',
    });
  }
  return dashboardPath(projectDashboardsDirPath(options.projectRoot), id);
}

export interface DashboardFingerprint {
  readonly mtimeMs: number;
  readonly size: number;
}

/** Отпечаток файла дашборда — `undefined`, если файла ещё нет (дашборд создаётся впервые). */
export function dashboardFingerprint(path: string): DashboardFingerprint | undefined {
  try {
    const stat = statSync(path);
    return { mtimeMs: stat.mtimeMs, size: stat.size };
  } catch {
    return undefined;
  }
}

/**
 * Отпечаток каталога слоя дашбордов — имя и `mtime`+размер каждого файла,
 * отдельная часть отпечатка наблюдателя (`ui-daemon`, «Поток событий несёт
 * действующие дашборды», Решение 10). Отсутствие каталога — законное
 * состояние, а не отказ (та же трактовка, что у `buildDashboards`).
 */
export function dashboardsDirFingerprint(dir: string): string {
  if (!existsSync(dir)) return '-';
  const ids = listDashboardIds(dir);
  if (ids.length === 0) return 'empty';
  return ids
    .map((id) => {
      const fp = dashboardFingerprint(dashboardPath(dir, id));
      return `${id}:${fp === undefined ? '-' : `${fp.mtimeMs}:${fp.size}`}`;
    })
    .join(',');
}

function fingerprintsEqual(a: DashboardFingerprint | undefined, b: DashboardFingerprint | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.mtimeMs === b.mtimeMs && a.size === b.size;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
  const aKeys = Object.keys(a as Record<string, unknown>);
  const bKeys = Object.keys(b as Record<string, unknown>);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key) =>
    deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
  );
}

/**
 * Влить объект в узел-отображение, трогая только разошедшиеся ключи: узел
 * ключа, чьё значение совпало, остаётся прежним вместе со своим комментарием,
 * порядком и видом записи (`flow` против блочного). Именно это отличает
 * подвинутую ячейку от пересозданной: меняется `at.row`, а `widget` с
 * комментарием пользователя рядом остаётся тем же узлом.
 */
function mergeIntoMap(doc: Document, node: YAMLMap, target: Record<string, unknown>): void {
  for (const key of Object.keys(node.toJSON() as Record<string, unknown>)) {
    if (!(key in target)) node.delete(key);
  }
  for (const [key, value] of Object.entries(target)) {
    const current = node.get(key, true);
    if (value !== null && typeof value === 'object' && !Array.isArray(value) && isMap(current)) {
      mergeIntoMap(doc, current, value as Record<string, unknown>);
      continue;
    }
    if (deepEqual(node.get(key), value)) continue;
    node.set(key, doc.createNode(value));
  }
}

/**
 * Заменить список ячеек, не трогая узлы неизменившихся — комментарии и
 * форматирование ячейки, которую сохранение не коснулось, переживают правку
 * (`ui-dashboards`, «Виджет добавлен из каталога и сохранён», «Ячейка
 * подвинута»). Ячейка с прежним `id` правится на месте: пересоздание узла
 * целиком теряло бы её комментарии и вид записи даже от сдвига одного
 * `at.row` — а сценарий требует, чтобы менялось только место этой ячейки.
 */
function applyCells(doc: Document, targetCells: readonly DashboardCellRowDocument[]): void {
  const existingSeq = doc.get('cells', true);
  const existingById = new Map<string, YAMLMap>();
  if (isSeq(existingSeq)) {
    for (const item of existingSeq.items) {
      if (!isMap(item)) continue;
      const plain = item.toJSON() as { id?: unknown };
      if (typeof plain.id === 'string') existingById.set(plain.id, item as YAMLMap);
    }
  }

  const newItems: Node[] = targetCells.map((cell) => {
    const existingNode = existingById.get(cell.id);
    if (existingNode === undefined) return doc.createNode(cell) as Node;
    if (!deepEqual(existingNode.toJSON(), cell)) {
      mergeIntoMap(doc, existingNode, cell as unknown as Record<string, unknown>);
    }
    return existingNode as unknown as Node;
  });

  if (isSeq(existingSeq)) {
    existingSeq.items = newItems;
  } else {
    doc.set('cells', newItems);
  }
}

function applyScalarField(doc: Document, key: 'title', value: string | undefined): void {
  if (value === undefined) {
    if (doc.has(key)) doc.delete(key);
    return;
  }
  if (doc.get(key) === value) return;
  doc.set(key, value);
}

function applyGrid(doc: Document, grid: { readonly columns: number }): void {
  const current = doc.get('grid', true);
  if (isMap(current) && deepEqual(current.toJSON(), grid)) return;
  doc.set('grid', grid);
}

/**
 * Записать документ дашборда в файл слоя через `Document` библиотеки `yaml`:
 * комментарии, порядок ячеек и форматирование пользователя переживают правку
 * (`ui-dashboards`, Решение 11). Неразбираемый или не соответствующий формату
 * файл не переписывается — отказ называет место разбора. Отпечаток документа,
 * от которого началась правка (`baseFingerprint`, `undefined` — дашборд ещё не
 * существовал), сверяется с текущим: расхождение — отказ «файл изменился с
 * момента открытия», а не молчаливая перезапись чужой правки.
 *
 * Записываемый документ проходит те же проверки сетки, что и читаемый файл:
 * без них сохранение отвечало бы удачей, а дашборд после неё пропадал бы из
 * действующего состава и оказывался среди `failures` — отказ, о котором никто
 * не сказал, вместо названной причины на месте сохранения.
 */
export function writeDashboard(
  layer: DashboardLayerName,
  id: string,
  document: DashboardFileDocument,
  baseFingerprint: DashboardFingerprint | undefined,
  options: DashboardBuildOptions,
): void {
  try {
    checkDashboardDocument(toDefinition(document));
  } catch (error) {
    if (error instanceof DashboardDocumentError) {
      throw new StepcastError(`Дашборд ${id} не сохранён: ${error.message}`, {
        at: error.cellIds.join(', '),
        hint: 'Поправьте раскладку: ячейки не должны повторяться, выходить за колонки сетки и накладываться',
      });
    }
    throw error;
  }

  const path = writableDashboardPath(layer, id, options);

  const currentFingerprint = dashboardFingerprint(path);
  if (!fingerprintsEqual(baseFingerprint, currentFingerprint)) {
    throw new StepcastError(`Файл дашборда ${id} изменился с момента открытия`, {
      file: path,
      hint: 'Перечитайте дашборд и повторите правку',
    });
  }

  let doc: Document;
  if (existsSync(path)) {
    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch (error) {
      throw new StepcastError(`Файл дашборда не читается: ${path}`, {
        file: path,
        hint: (error as NodeJS.ErrnoException).message,
        cause: error,
      });
    }
    doc = parseDocument(text);
    // `parseDocument`, в отличие от `parse`, на синтаксической ошибке не
    // бросает: он разбирает как получится, а отказы складывает в `doc.errors`.
    // Без этой проверки запись шла бы поверх файла, который чтение состава
    // считает сломанным, — и потеряла бы то, чего разбор не понял (например,
    // второй ключ `cells:`), молча ([`ui-dashboards`, «Файл, который не
    // разбирается, MUST NOT перезаписываться сохранением»]).
    const parseFailure = doc.errors[0];
    if (parseFailure !== undefined) {
      const pos = parseFailure.linePos?.[0];
      throw new StepcastError(
        `Файл дашборда ${path} не разбирается как YAML — запись отменена: ${parseFailure.message}`,
        {
          file: path,
          ...(pos === undefined ? {} : { at: `строка ${pos.line}, колонка ${pos.col}` }),
          hint: 'Почините файл вручную, прежде чем сохранять дашборд из витрины',
        },
      );
    }
    const existing = DashboardDocumentSchema.safeParse(doc.toJS());
    if (!existing.success) {
      const failure = describeSchemaFailure(existing.error);
      throw new StepcastError(`Файл дашборда ${path} не соответствует формату — запись отменена: ${failure.message}`, {
        file: path,
        ...(failure.at === undefined ? {} : { at: failure.at }),
        hint: 'Почините файл вручную, прежде чем сохранять дашборд из витрины',
      });
    }
  } else {
    doc = new Document({});
  }

  applyScalarField(doc, 'title', document.title);
  applyGrid(doc, document.grid);
  applyCells(doc, document.cells);

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, doc.toString(), 'utf8');
}
