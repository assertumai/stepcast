import { paramPlaceholderNames, substituteParams } from './routes.js';

/**
 * Модель ячейки дашборда, подстановка параметров и приведение к типу манифеста
 * — общий чистый модуль демону и браузеру (`ui-dashboards`, design.md Решение
 * 8, 9, 12).
 *
 * Чтение слоёв, схема и диагностика файла — забота `src/parts/ui/dashboardsFile.ts`
 * (модуля демона, у которого есть диск). Знание о составе виджетов и их
 * манифестах живёт только в браузере (Решение 5, 9): этот модуль не знает ни
 * одного имени виджета и работает с типом параметра, который ему называет
 * вызывающий.
 */

export type ParamScalar = string | number | boolean;

export interface DashboardCellAt {
  readonly column: number;
  readonly row: number;
  readonly width: number;
  readonly height: number;
}

export interface DashboardCellDefinition {
  readonly id: string;
  readonly widget: string;
  readonly at: DashboardCellAt;
  readonly title?: string;
  readonly params?: Readonly<Record<string, ParamScalar>>;
}

export interface DashboardGridDefinition {
  readonly columns: number;
}

/** Дашборд после разбора и слияния слоёв — то, что содержит один файл. */
export interface DashboardDefinition {
  readonly title?: string;
  readonly grid: DashboardGridDefinition;
  readonly cells: readonly DashboardCellDefinition[];
}

/**
 * Отказ, которому достаточно самого документа: повтор `id` ячейки, ячейка вне
 * сетки, наложение двух ячеек (`ui-dashboards`, Решение 9, 12). `cellIds`
 * называет причастные ячейки — вызывающий (`dashboardsFile.ts`) добавляет файл.
 */
export class DashboardDocumentError extends Error {
  readonly cellIds: readonly string[];

  constructor(message: string, cellIds: readonly string[]) {
    super(message);
    this.name = 'DashboardDocumentError';
    this.cellIds = cellIds;
  }
}

function cellRight(at: DashboardCellAt): number {
  return at.column + at.width;
}

function cellBottom(at: DashboardCellAt): number {
  return at.row + at.height;
}

function cellsOverlap(a: DashboardCellAt, b: DashboardCellAt): boolean {
  return a.column < cellRight(b) && b.column < cellRight(a) && a.row < cellBottom(b) && b.row < cellBottom(a);
}

/**
 * Проверки, которым довольно самого документа — отказ дашборда целиком
 * (`ui-dashboards`, «Отказ файла останавливает дашборд, отказ ячейки — только
 * ячейку»). Знание о составе виджетов сюда не входит: неизвестный виджет и
 * несовпадение параметров с манифестом проверяются на странице, по одной
 * ячейке (Решение 9).
 */
export function checkDashboardDocument(doc: DashboardDefinition): void {
  const seenIds = new Set<string>();
  for (const cell of doc.cells) {
    if (seenIds.has(cell.id)) {
      throw new DashboardDocumentError(`Ячейка ${cell.id} повторяется`, [cell.id]);
    }
    seenIds.add(cell.id);
  }

  for (const cell of doc.cells) {
    if (cell.at.column < 0 || cellRight(cell.at) > doc.grid.columns) {
      throw new DashboardDocumentError(
        `Ячейка ${cell.id} (колонка ${cell.at.column}, ширина ${cell.at.width}) выходит за пределы сетки в ${doc.grid.columns} колонок`,
        [cell.id],
      );
    }
  }

  for (let i = 0; i < doc.cells.length; i++) {
    for (let j = i + 1; j < doc.cells.length; j++) {
      const a = doc.cells[i] as DashboardCellDefinition;
      const b = doc.cells[j] as DashboardCellDefinition;
      if (cellsOverlap(a.at, b.at)) {
        throw new DashboardDocumentError(`Ячейки ${a.id} и ${b.id} накладываются в сетке`, [a.id, b.id]);
      }
    }
  }
}

/**
 * Тип параметра манифеста виджета — та же форма, что несёт `WidgetParam`
 * (`ui/src/sharedSlots.ts`): дашборд заводится раньше слота виджетов, и это
 * единственная форма, общая демону и браузеру, поэтому браузерный тип
 * определяется через неё, а не наоборот.
 */
export type WidgetParamType =
  | { readonly kind: 'string' }
  | { readonly kind: 'number' }
  | { readonly kind: 'boolean' }
  | { readonly kind: 'enum'; readonly values: readonly string[] };

export type ParamCoercionResult =
  | { readonly ok: true; readonly value: ParamScalar }
  | { readonly ok: false; readonly reason: string };

function describeType(type: WidgetParamType): string {
  switch (type.kind) {
    case 'string':
      return 'строкой';
    case 'number':
      return 'числом';
    case 'boolean':
      return 'логическим значением';
    case 'enum':
      return `одним из значений: ${type.values.join(', ')}`;
  }
}

function coerceToType(value: ParamScalar, type: WidgetParamType): ParamScalar | undefined {
  switch (type.kind) {
    case 'string':
      return String(value);
    case 'number': {
      // `Number('')` и `Number('   ')` дают конечный 0: без этой отсечки пустое
      // значение — в том числе подстановка параметра маршрута, оказавшегося
      // пустым, — молча становилось бы числом 0 вместо названной причины.
      if (typeof value === 'string' && value.trim() === '') return undefined;
      const parsed = typeof value === 'number' ? value : Number(value);
      return Number.isFinite(parsed) ? parsed : undefined;
    }
    case 'boolean': {
      if (typeof value === 'boolean') return value;
      const text = String(value).trim().toLowerCase();
      if (text === 'true') return true;
      if (text === 'false') return false;
      return undefined;
    }
    case 'enum': {
      const text = String(value);
      return type.values.includes(text) ? text : undefined;
    }
  }
}

/**
 * Подставить `${params.<имя>}` в значение параметра ячейки и привести
 * результат к типу манифеста (`ui-dashboards`, Решение 8). Подстановка
 * применяется только к строковому значению — числа и булевы ячейки уже несут
 * свой тип, языку подстановки в них нечего заменять.
 *
 * Отказ — не исключение, а значение: неизвестный виджет соседней ячейки не
 * должен зависеть от того, как эта функция сообщает о своей причине, а
 * страница обязана нарисовать соседей независимо от этой ячейки (Решение 9).
 */
export function resolveCellParam(
  widgetName: string,
  paramName: string,
  raw: ParamScalar,
  type: WidgetParamType,
  routeParams: Readonly<Record<string, string>>,
): ParamCoercionResult {
  let value: ParamScalar = raw;
  let expression: string | undefined;

  if (typeof raw === 'string') {
    const names = paramPlaceholderNames(raw);
    for (const name of names) {
      if (name in routeParams) continue;
      return {
        ok: false,
        reason:
          `Виджет ${widgetName}: параметр ${paramName} ссылается на \${params.${name}}, ` +
          `которого нет в параметрах открытого маршрута`,
      };
    }
    if (names.length > 0) {
      value = substituteParams(raw, routeParams);
      expression = raw;
    }
  }

  const coerced = coerceToType(value, type);
  if (coerced === undefined) {
    const fromExpression = expression === undefined ? '' : ` (из выражения ${expression})`;
    return {
      ok: false,
      reason:
        `Виджет ${widgetName}: параметр ${paramName} должен быть ${describeType(type)}, ` +
        `получено ${JSON.stringify(value)}${fromExpression}`,
    };
  }
  return { ok: true, value: coerced };
}
