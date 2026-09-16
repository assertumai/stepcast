import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Document, parse as parseYaml, parseDocument } from 'yaml';
import { z } from 'zod';

import { StepcastError } from '../../kernel/errors.js';
import { findPackageRoot } from '../pipeline/domain/package-schema.js';
import { describeSchemaFailure } from '../../kernel/schema-failure.js';
import {
  isReservedPath,
  normalizedTemplate,
  paramPlaceholderNames,
  templateParamNames,
  type RouteDefinition,
  type RouteNav,
  type RouteTable,
  type RouteTarget,
} from './routes.js';

/**
 * Файл маршрутов и его три слоя (`ui-routes`, design.md Решение 1, 2, 9).
 *
 * Модуль демона: он один читает диск и знает про `findPackageRoot`,
 * `homedir()` и проектный корень. Разбор адреса и сборка ссылки по уже
 * собранной таблице остаются в `src/parts/ui/routes.ts` — общем и демону, и
 * браузеру.
 */

const ROUTE_NAME = /^[A-Za-z0-9_]+$/;

const RouteNavSchema = z
  .object({
    title: z.string().min(1).optional(),
    order: z.number().optional(),
    active_for: z.array(z.string().min(1)).optional(),
  })
  .strict();

const RouteTargetSchema = z.union([
  z.object({ screen: z.string().min(1) }).strict(),
  z.object({ widget: z.string().min(1) }).strict(),
  z.object({ dashboard: z.string().min(1) }).strict(),
]);

export const RouteRowSchema = z
  .object({
    id: z.string().min(1),
    path: z.string().regex(/^\//, 'путь обязан начинаться с /').optional(),
    target: RouteTargetSchema.optional(),
    params: z.record(z.string().regex(ROUTE_NAME), z.string()).optional(),
    values: z.record(z.string().regex(ROUTE_NAME), z.array(z.string().min(1)).min(1)).optional(),
    nav: RouteNavSchema.optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

export type RouteRowDocument = z.infer<typeof RouteRowSchema>;

export const RouteDocumentSchema = z
  .object({
    routes: z.array(RouteRowSchema),
  })
  .strict();

export type RouteFileDocument = z.infer<typeof RouteDocumentSchema>;

const ROUTES_FILE_NAME = 'routes.yml';

/** Расположение встроенного файла маршрутов — тем же приёмом, что `src/builtin/steps` (`src/parts/ui/steps.ts:63`). */
export function builtinRoutesPath(): string {
  return join(findPackageRoot(fileURLToPath(new URL('.', import.meta.url))), 'src', 'builtin', ROUTES_FILE_NAME);
}

export function homeRoutesPath(home: string): string {
  return join(home, '.stepcast', ROUTES_FILE_NAME);
}

export function projectRoutesPath(projectRoot: string): string {
  return join(projectRoot, '.stepcast', ROUTES_FILE_NAME);
}

function readRoutesDocument(path: string): readonly RouteRowDocument[] {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    throw new StepcastError(`Файл маршрутов не читается: ${path}`, {
      file: path,
      hint: (error as NodeJS.ErrnoException).message,
      cause: error,
    });
  }

  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (error) {
    throw new StepcastError(`Файл маршрутов не разбирается как YAML: ${path}`, { file: path, cause: error });
  }

  const parsed = RouteDocumentSchema.safeParse(raw);
  if (!parsed.success) {
    const failure = describeSchemaFailure(parsed.error);
    throw new StepcastError(`Файл маршрутов ${path} не соответствует формату: ${failure.message}`, {
      file: path,
      ...(failure.at === undefined ? {} : { at: failure.at }),
      hint: 'Формат описан в docs/routes.md; схема — schema/routes.schema.json',
    });
  }
  return parsed.data.routes;
}

export type RouteLayerName = 'builtin' | 'home' | 'project';

interface LayerFile {
  readonly layer: RouteLayerName;
  readonly path: string;
  readonly rows: readonly RouteRowDocument[];
}

function readLayer(layer: RouteLayerName, path: string, required: boolean): LayerFile | undefined {
  if (!required && !existsSync(path)) return undefined;
  return { layer, path, rows: readRoutesDocument(path) };
}

/** Откуда пришло поле строки маршрута — слой и файл (для перечня в витрине). */
export interface RouteFieldSource {
  readonly layer: RouteLayerName;
  readonly file: string;
}

interface FieldSlot<T> {
  readonly value: T;
  readonly source: RouteFieldSource;
}

/** Поля строки, слитые по листьям через слои (`ui-routes`, Решение 2). */
interface MergedFields {
  path?: FieldSlot<string>;
  target?: FieldSlot<NonNullable<RouteRowDocument['target']>>;
  params?: FieldSlot<Readonly<Record<string, string>>>;
  values?: FieldSlot<Readonly<Record<string, readonly string[]>>>;
  navTitle?: FieldSlot<string>;
  navOrder?: FieldSlot<number>;
  navActiveFor?: FieldSlot<readonly string[]>;
  enabled?: FieldSlot<boolean>;
}

interface MergedRow {
  readonly id: string;
  readonly fields: MergedFields;
  /** Файлы, коснувшиеся строки — последний нужен как место отказа «нет пути/цели». */
  readonly touchedFiles: readonly string[];
}

/** Слить строки слоёв по `id`, по листьям, сохраняя порядок первого появления (`ui-routes`, Решение 1, 2). */
function mergeRows(layers: readonly LayerFile[]): readonly MergedRow[] {
  const order: string[] = [];
  const byId = new Map<string, { fields: MergedFields; touchedFiles: string[] }>();

  for (const layer of layers) {
    for (const raw of layer.rows) {
      let entry = byId.get(raw.id);
      if (entry === undefined) {
        entry = { fields: {}, touchedFiles: [] };
        byId.set(raw.id, entry);
        order.push(raw.id);
      }
      entry.touchedFiles.push(layer.path);
      const source: RouteFieldSource = { layer: layer.layer, file: layer.path };
      if (raw.path !== undefined) entry.fields.path = { value: raw.path, source };
      if (raw.target !== undefined) entry.fields.target = { value: raw.target, source };
      if (raw.params !== undefined) entry.fields.params = { value: raw.params, source };
      if (raw.values !== undefined) entry.fields.values = { value: raw.values, source };
      if (raw.enabled !== undefined) entry.fields.enabled = { value: raw.enabled, source };
      if (raw.nav?.title !== undefined) entry.fields.navTitle = { value: raw.nav.title, source };
      if (raw.nav?.order !== undefined) entry.fields.navOrder = { value: raw.nav.order, source };
      if (raw.nav?.active_for !== undefined) entry.fields.navActiveFor = { value: raw.nav.active_for, source };
    }
  }

  return order.map((id) => ({ id, ...byId.get(id)! }));
}

function toRouteTarget(raw: NonNullable<RouteRowDocument['target']>): RouteTarget {
  if ('screen' in raw) return { kind: 'screen', id: raw.screen };
  if ('widget' in raw) return { kind: 'widget', id: raw.widget };
  return { kind: 'dashboard', id: raw.dashboard };
}

/** Маршрут действующей таблицы вместе с источником каждого поля — для перечня в витрине. */
export interface RouteEntry {
  readonly id: string;
  readonly definition: RouteDefinition;
  readonly sources: {
    readonly path: RouteFieldSource;
    readonly target: RouteFieldSource;
    readonly params?: RouteFieldSource;
    readonly values?: RouteFieldSource;
    readonly navTitle?: RouteFieldSource;
    readonly navOrder?: RouteFieldSource;
    readonly navActiveFor?: RouteFieldSource;
    readonly enabled?: RouteFieldSource;
  };
}

/**
 * Отключённая строка маршрута: в действующую таблицу она не входит вовсе
 * (`enabled: false` убирает маршрут из навигации, разбора адреса и сборки
 * ссылок), но перечню в витрине видна — иначе включить её обратно можно было
 * бы только правкой файла руками, а перечень маршрутов обязан оставаться
 * входом в любом состоянии таблицы (`ui-routes`, «Витрина показывает маршруты
 * с источником и правит файл слоя»).
 */
export interface DisabledRouteEntry {
  readonly id: string;
  readonly path?: string;
  readonly target?: RouteTarget;
  readonly nav?: RouteNav;
  /** Файл, объявивший строку отключённой, — его и называет витрина. */
  readonly disabledBy: RouteFieldSource;
}

export interface RouteBuildResult {
  readonly table: RouteTable;
  readonly entries: readonly RouteEntry[];
  readonly disabled: readonly DisabledRouteEntry[];
}

/** Строка действующей таблицы, обогащённая источником каждого поля — форма ответа `GET /api/routes` и события потока `routes`. */
export interface RoutePayloadEntry extends RouteDefinition {
  readonly sources: RouteEntry['sources'];
}

/** Действующая таблица с источниками, готовая к отправке JSON — общая форма для `GET /api/routes` и события `routes` (`ui-daemon`). */
export function routesPayload(result: RouteBuildResult): readonly RoutePayloadEntry[] {
  return result.entries.map((entry) => ({ ...entry.definition, sources: entry.sources }));
}

export interface RouteBuildOptions {
  readonly home: string;
  /** Корень проекта, в котором поднят демон — `undefined`, если демон его не знает. */
  readonly projectRoot?: string;
  /**
   * Файл поставки. У поставки он один (`builtinRoutesPath()`), и подменяется
   * только проверкой: сломать настоящий файл пакета ради сценария «Встроенный
   * файл сломан» ей негде.
   */
  readonly builtinPath?: string;
}

function buildNav(fields: MergedFields): RouteNav | undefined {
  if (fields.navTitle === undefined && fields.navOrder === undefined && fields.navActiveFor === undefined) {
    return undefined;
  }
  return {
    ...(fields.navTitle === undefined ? {} : { title: fields.navTitle.value }),
    ...(fields.navOrder === undefined ? {} : { order: fields.navOrder.value }),
    ...(fields.navActiveFor === undefined ? {} : { activeFor: fields.navActiveFor.value }),
  };
}

function validateParamPlaceholders(id: string, path: string, params: FieldSlot<Readonly<Record<string, string>>>): void {
  const names = new Set(templateParamNames(path));
  for (const [key, value] of Object.entries(params.value)) {
    for (const name of paramPlaceholderNames(value)) {
      if (names.has(name)) continue;
      throw new StepcastError(
        `Маршрут ${id}: параметр цели ${key} ссылается на \${params.${name}}, которого нет в пути ${path}`,
        {
          file: params.source.file,
          at: `${id}.params.${key}`,
          hint:
            names.size === 0
              ? `Путь маршрута ${path} не объявляет ни одного параметра`
              : `Путь маршрута объявляет параметры: ${[...names].join(', ')}`,
        },
      );
    }
  }
}

/**
 * Собрать действующую таблицу маршрутов трёх слоёв. Отказ — исключение
 * `StepcastError`: вызывающий (`src/parts/ui/daemon/kernel.ts`) обязан оставить в силе
 * последнюю успешно собранную таблицу, а не гасить витрину (`ui-routes`,
 * «Отказ таблицы не гасит витрину»).
 */
export function buildRouteTable(options: RouteBuildOptions): RouteBuildResult {
  const layers: LayerFile[] = [];
  const builtin = readLayer('builtin', options.builtinPath ?? builtinRoutesPath(), true);
  if (builtin !== undefined) layers.push(builtin);
  const home = readLayer('home', homeRoutesPath(options.home), false);
  if (home !== undefined) layers.push(home);
  if (options.projectRoot !== undefined) {
    const project = readLayer('project', projectRoutesPath(options.projectRoot), false);
    if (project !== undefined) layers.push(project);
  }

  const merged = mergeRows(layers);
  const entries: RouteEntry[] = [];
  const disabled: DisabledRouteEntry[] = [];

  for (const row of merged) {
    const enabledField = row.fields.enabled;
    if (enabledField !== undefined && !enabledField.value) {
      // Отключённая строка не проверяется на путь, цель и конфликты: её нет в
      // действующей таблице, и отказывать из-за неё значило бы гасить рабочие
      // маршруты ради выключенного. Витрине она отдаётся отдельным перечнем.
      const disabledNav = buildNav(row.fields);
      disabled.push({
        id: row.id,
        ...(row.fields.path === undefined ? {} : { path: row.fields.path.value }),
        ...(row.fields.target === undefined ? {} : { target: toRouteTarget(row.fields.target.value) }),
        ...(disabledNav === undefined ? {} : { nav: disabledNav }),
        disabledBy: enabledField.source,
      });
      continue;
    }

    if (row.fields.path === undefined || row.fields.target === undefined) {
      throw new StepcastError(`Маршрут ${row.id} не объявляет путь и цель ни в одном слое`, {
        file: row.touchedFiles[row.touchedFiles.length - 1] as string,
        at: row.id,
        hint: 'Маршрут, добавляющий новый id, обязан объявить path и target — слить их неоткуда',
      });
    }

    const path = row.fields.path.value;
    if (isReservedPath(path)) {
      throw new StepcastError(`Маршрут ${row.id} объявляет зарезервированный путь ${path}`, {
        file: row.fields.path.source.file,
        at: row.id,
        hint: 'Пути /api, /widgets/, /plugins/ и /shared/ разбирает демон — страница по ним не открывается',
      });
    }

    if (row.fields.params !== undefined) validateParamPlaceholders(row.id, path, row.fields.params);

    const nav = buildNav(row.fields);
    const definition: RouteDefinition = {
      id: row.id,
      path,
      target: toRouteTarget(row.fields.target.value),
      ...(row.fields.params === undefined ? {} : { params: row.fields.params.value }),
      ...(row.fields.values === undefined ? {} : { values: row.fields.values.value }),
      ...(nav === undefined ? {} : { nav }),
    };

    entries.push({
      id: row.id,
      definition,
      sources: {
        path: row.fields.path.source,
        target: row.fields.target.source,
        ...(row.fields.params === undefined ? {} : { params: row.fields.params.source }),
        ...(row.fields.values === undefined ? {} : { values: row.fields.values.source }),
        ...(row.fields.navTitle === undefined ? {} : { navTitle: row.fields.navTitle.source }),
        ...(row.fields.navOrder === undefined ? {} : { navOrder: row.fields.navOrder.source }),
        ...(row.fields.navActiveFor === undefined ? {} : { navActiveFor: row.fields.navActiveFor.source }),
        ...(row.fields.enabled === undefined ? {} : { enabled: row.fields.enabled.source }),
      },
    });
  }

  // Путь принадлежит одному маршруту (`ui-routes`, Решение 3): шаблоны,
  // различающиеся только именами параметров, — тот же адрес.
  const byNormalized = new Map<string, RouteEntry>();
  for (const entry of entries) {
    const key = normalizedTemplate(entry.definition.path);
    const existing = byNormalized.get(key);
    if (existing !== undefined) {
      throw new StepcastError(
        `Путь ${entry.definition.path} занят маршрутами ${existing.id} (${existing.sources.path.file}) и ${entry.id} (${entry.sources.path.file})`,
        {
          at: entry.id,
          hint: `Один путь — один маршрут: поправьте строку ${existing.id} своим id, вместо второй строки на тот же путь`,
        },
      );
    }
    byNormalized.set(key, entry);
  }

  return { table: entries.map((entry) => entry.definition), entries, disabled };
}

/** Имя файла слоя, в который пишет витрина, — для подсказок и для `POST /api/routes`. */
export type WritableRouteLayer = 'home' | 'project';

export function writableLayerPath(layer: WritableRouteLayer, options: RouteBuildOptions): string {
  if (layer === 'home') return homeRoutesPath(options.home);
  if (options.projectRoot === undefined) {
    throw new StepcastError('Демон не знает корень проекта — записать проектный слой маршрутов некуда', {
      hint: 'Поднимите витрину в каталоге проекта (stepcast up) либо сохраните маршрут в домашний слой',
    });
  }
  return projectRoutesPath(options.projectRoot);
}

/**
 * Записать строку маршрута в файл слоя через `Document` библиотеки `yaml`:
 * комментарии, порядок прочих строк и форматирование пользователя переживают
 * правку (`ui-routes`, Решение 11). Файл, который не разбирается, не
 * переписывается — отказ называет место разбора.
 */
export function writeRouteRow(layer: WritableRouteLayer, row: RouteRowDocument, options: RouteBuildOptions): void {
  const path = writableLayerPath(layer, options);

  let doc: Document;
  if (existsSync(path)) {
    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch (error) {
      throw new StepcastError(`Файл маршрутов не читается: ${path}`, {
        file: path,
        hint: (error as NodeJS.ErrnoException).message,
        cause: error,
      });
    }
    doc = parseDocument(text);
    // `parseDocument` на синтаксической ошибке не бросает — она едет списком
    // `doc.errors`, и без этой проверки сохранение переписывало бы файл,
    // который чтение слоя (`parse`, выше) считает сломанным, по своему
    // «как получится» разбору (`ui-routes`, «Файл, который не разбирается, не
    // переписывается»).
    const parseFailure = doc.errors[0];
    if (parseFailure !== undefined) {
      const pos = parseFailure.linePos?.[0];
      throw new StepcastError(
        `Файл маршрутов ${path} не разбирается как YAML — запись отменена: ${parseFailure.message}`,
        {
          file: path,
          ...(pos === undefined ? {} : { at: `строка ${pos.line}, колонка ${pos.col}` }),
          hint: 'Почините файл вручную, прежде чем сохранять маршрут из витрины',
        },
      );
    }
    const existing = RouteDocumentSchema.safeParse(doc.toJS());
    if (!existing.success) {
      const failure = describeSchemaFailure(existing.error);
      throw new StepcastError(`Файл маршрутов ${path} не соответствует формату — запись отменена: ${failure.message}`, {
        file: path,
        ...(failure.at === undefined ? {} : { at: failure.at }),
        hint: 'Почините файл вручную, прежде чем сохранять маршрут из витрины',
      });
    }
    if (doc.get('routes') === undefined) doc.set('routes', []);
  } else {
    doc = new Document({ routes: [] });
  }

  const rows = (doc.toJS() as RouteFileDocument).routes;
  const index = rows.findIndex((existingRow) => existingRow.id === row.id);
  if (index === -1) {
    doc.addIn(['routes', rows.length], row);
  } else {
    doc.setIn(['routes', index], row);
  }

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, doc.toString(), 'utf8');
}
