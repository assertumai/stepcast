import type { StepcastError } from '../errors.js';
import { BUILTIN_OWNER, type Fiber, type Kernel } from './kernel.js';
import type { RootWindow, RowOutcome } from './load.js';
import { declaredServices, requestedServices } from './services.js';
import type { TreeRowSource } from './tree.js';

/**
 * Осмотр состава (`plugin-introspection`): одна модель, которой пользуются
 * печать команды, `--json` и экран витрины (design.md, Решение 1) — им негде
 * разойтись, потому что ни один из трёх не строит своё представление заново,
 * а читает это.
 *
 * Собирается функцией `introspect()` из `RowOutcome[]` (`load.ts`) и `Kernel`,
 * породившего реестр, — до `kernel.dispose()`: после снятия ядра ни сервисов,
 * ни областей не осталось бы (design.md, Решение 15). Авторство вклада и
 * сервиса выводится из области, которой они зарегистрированы (`RowOutcome.fiber`
 * для строки со своей областью, `RowOutcome.rootWindow` для встроенной строки
 * движка без неё) — design.md, Решение 2, а не из имени или порядка.
 */

/** Состояние строки в осмотре — то же самое, что несёт `RowOutcome.status`, плюс причина у отказа. */
export type IntrospectionState =
  | { readonly kind: 'active' }
  | { readonly kind: 'disabled' }
  | { readonly kind: 'not-attempted' }
  | { readonly kind: 'failed'; readonly reason: string };

/** Один объявленный сервис строки: имя и признак «это имя слота» (`slot:` — витрина, `services.ts`). */
export interface IntrospectionDeclaredService {
  readonly name: string;
  readonly slot: boolean;
}

/** Один запрошенный сервис строки: имя и признак разрешённости (`services.ts`, Решение 5). */
export interface IntrospectionRequestedService {
  readonly name: string;
  readonly resolved: boolean;
}

/** Вклады строки по видам — те же четыре, что несёт `Registry` (`registry.ts`). */
export interface IntrospectionContributions {
  readonly backends: readonly string[];
  readonly predicates: readonly string[];
  readonly commands: readonly string[];
  readonly steps: readonly string[];
}

const EMPTY_CONTRIBUTIONS: IntrospectionContributions = { backends: [], predicates: [], commands: [], steps: [] };

/** Одна строка дерева, глазами осмотра. */
export interface IntrospectionRow {
  /** Место в порядке дерева, считая с единицы — то же, что первая колонка печати. */
  readonly place: number;
  readonly id: string;
  readonly use: string;
  readonly layer: TreeRowSource;
  readonly state: IntrospectionState;
  /** Имя и версия применённого плагина — только у строки, заведшей `LoadedPlugin` (файл, каталог). */
  readonly plugin?: { readonly name: string; readonly version?: string };
  readonly declaredServices: readonly IntrospectionDeclaredService[];
  readonly requestedServices: readonly IntrospectionRequestedService[];
  readonly contributions: IntrospectionContributions;
}

/**
 * Состав слотов витрины — половина осмотра, которую собирает страница
 * (`ui/src/slotsReport.ts`) и доносит демону (`plugin-introspection`, Решение
 * 7). `available: false` — демон ни разу не получал отчёт: осмотр называет
 * причину, а не выдаёт пустой состав за действительный (design.md, «Неизвестное
 * осмотру называется причиной»). Заполняется вызывающим демона (`src/ui/screens/plugins/server.ts`);
 * `introspect()` этого модуля сама сторону браузера не знает и не обязана.
 */
export type BrowserIntrospection =
  | { readonly available: false; readonly reason: string }
  | {
      readonly available: true;
      /** Момент, когда демон получил этот отчёт, — ISO-строка: осмотр не выдаёт его за «сейчас». */
      readonly observedAt: string;
      /** Витрина открыта хоть одной вкладкой прямо сейчас. */
      readonly open: boolean;
    };

/**
 * Вклады и сервисы корневой области, не попавшие ни в одно окно применения
 * строки, — граница правила приписывания, названная честно (design.md,
 * Решение 2, «Граница правила названа честно»). Сюда попадает всё, что ядро
 * завело до первой строки (`createKernelShell`: встроенные команды CLI и
 * четыре служебных сервиса — виды шага с `builtin-step-kinds-as-rows` вносят
 * строки, и каждый числится за своей) и всякая поздняя регистрация на корне. Такой вклад не приписывается строке наугад и не
 * исчезает из осмотра: он показан владельцем «встроенный».
 */
export interface IntrospectionBuiltin {
  /** Имя владельца — то же `BUILTIN_OWNER`, которым его называет `Registry.owners`. */
  readonly owner: string;
  readonly contributions: IntrospectionContributions;
  readonly declaredServices: readonly IntrospectionDeclaredService[];
}

/**
 * Приписывание вкладов и сервисов строкам: `available: false` — итоги строк
 * пришли без областей (реестр взят готовым, `resolveWithPlugins` с полем
 * `registry`), и пустые перечни строк значили бы не «строка ничего не дала», а
 * «спросить было не у кого». Осмотр называет эту разницу причиной, а не выдаёт
 * одно за другое (`plugin-introspection`, «Неизвестное осмотру называется
 * причиной, а не пустотой»).
 */
export type IntrospectionAttribution =
  | { readonly available: true }
  | { readonly available: false; readonly reason: string };

export interface Introspection {
  readonly version: 1;
  readonly surface: 'cli' | 'daemon';
  readonly rows: readonly IntrospectionRow[];
  readonly builtin: IntrospectionBuiltin;
  readonly attribution: IntrospectionAttribution;
  readonly browser: BrowserIntrospection;
}

function stateOf(outcome: RowOutcome): IntrospectionState {
  switch (outcome.status) {
    case 'active':
      return { kind: 'active' };
    case 'disabled':
      return { kind: 'disabled' };
    case 'not-attempted':
      return { kind: 'not-attempted' };
    case 'failed':
      return { kind: 'failed', reason: reasonOf(outcome.error) };
  }
}

function reasonOf(error: StepcastError | undefined): string {
  return error?.message ?? 'неизвестная причина';
}

const CONTRIB_KINDS = ['backends', 'predicates', 'commands', 'steps'] as const;

/** Вклады строки со своей областью — по фиберу, во всех четырёх сервисах вкладов (design.md, Решение 2). */
function contributionsOf(kernel: Kernel, fiber: Fiber): IntrospectionContributions {
  const out: Record<(typeof CONTRIB_KINDS)[number], string[]> = { backends: [], predicates: [], commands: [], steps: [] };
  for (const kind of CONTRIB_KINDS) {
    for (const entry of kernel.ctx[kind].entriesWithFiber()) {
      if (entry.ownerFiber === fiber) out[kind].push(entry.name);
    }
  }
  return out;
}

/** Вклады окна корневых регистраций — то, что появилось за время применения встроенной строки без своей области. */
function contributionsFromWindow(window: RootWindow): IntrospectionContributions {
  const out: Record<(typeof CONTRIB_KINDS)[number], string[]> = { backends: [], predicates: [], commands: [], steps: [] };
  for (const { kind, name } of window.contributions) out[kind].push(name);
  return out;
}

/** Один осмотренный ряд — строка дерева плюс её вклады и сервисы, выведенные по правилу приписывания. */
function rowOf(kernel: Kernel, outcome: RowOutcome, place: number): IntrospectionRow {
  const base = {
    place,
    id: outcome.row.id,
    use: outcome.row.use,
    layer: outcome.row.source,
    state: stateOf(outcome),
  };

  if (outcome.fiber !== undefined) {
    const fiber = outcome.fiber;
    const plugin = kernel.pluginOf(fiber);
    return {
      ...base,
      ...(plugin === undefined ? {} : { plugin: { name: plugin.name, ...(plugin.version === undefined ? {} : { version: plugin.version }) } }),
      declaredServices: declaredServices(kernel.ctx)
        .filter((service) => service.fiber === fiber)
        .map((service) => ({ name: service.name, slot: service.slot })),
      requestedServices: requestedServices(fiber),
      contributions: contributionsOf(kernel, fiber),
    };
  }

  if (outcome.rootWindow !== undefined) {
    return {
      ...base,
      declaredServices: outcome.rootWindow.services.map((name) => ({ name, slot: name.startsWith('slot:') })),
      requestedServices: [],
      contributions: contributionsFromWindow(outcome.rootWindow),
    };
  }

  // Отключённая, не загружавшаяся либо отказавшая строка: ни области, ни окна
  // регистраций — её вкладов и сервисов не числится (`plugin-introspection`,
  // «Отключённая строка в осмотре»). Исключение — снимок запрошенных имён,
  // снятый загрузчиком перед тем, как он снял область отказавшей строки
  // (`RowOutcome.requestedServices`): незакрытое внедрение обязано быть видно
  // моделью, а не одним текстом причины.
  return {
    ...base,
    declaredServices: [],
    requestedServices: outcome.requestedServices ?? [],
    contributions: EMPTY_CONTRIBUTIONS,
  };
}

/**
 * Встроенное вне строк дерева: то, что зарегистрировано на корневой области и
 * не попало ни в одно окно применения строки (design.md, Решение 2, граница
 * правила). Окна берутся из итогов строк: вклад, названный окном, принадлежит
 * своей строке и здесь не повторяется.
 */
function builtinOf(kernel: Kernel, outcomes: readonly RowOutcome[]): IntrospectionBuiltin {
  const claimedContributions = new Set<string>();
  const claimedServices = new Set<string>();
  for (const outcome of outcomes) {
    if (outcome.rootWindow === undefined) continue;
    for (const entry of outcome.rootWindow.contributions) claimedContributions.add(`${entry.kind}:${entry.name}`);
    for (const name of outcome.rootWindow.services) claimedServices.add(name);
  }

  const root = kernel.ctx.fiber;
  const contributions: Record<(typeof CONTRIB_KINDS)[number], string[]> = { backends: [], predicates: [], commands: [], steps: [] };
  for (const kind of CONTRIB_KINDS) {
    for (const entry of kernel.ctx[kind].entriesWithFiber()) {
      if (entry.ownerFiber === root && !claimedContributions.has(`${kind}:${entry.name}`)) contributions[kind].push(entry.name);
    }
  }

  return {
    owner: BUILTIN_OWNER,
    contributions,
    declaredServices: declaredServices(kernel.ctx)
      .filter((service) => service.fiber === root && !claimedServices.has(service.name))
      .map((service) => ({ name: service.name, slot: service.slot })),
  };
}

/**
 * Собрать осмотр из итогов строк и ядра, породившего реестр (design.md,
 * Решение 1). Зовётся до `kernel.dispose()` — `walkPluginTree` строит его
 * внутри себя, до снятия ядра (Решение 15).
 *
 * `browser` — причина «этот вызов не собирает браузерную половину» по
 * умолчанию: собственно браузерный состав приносит вызывающий демона
 * (`src/ui/screens/plugins/server.ts`), у которого есть последний отчёт
 * страницы, — здесь взять его неоткуда.
 *
 * `attribution` — для вызывающего, чьи итоги строк пришли без областей
 * (готовый реестр): он обязан назвать это причиной, иначе пустые перечни
 * строк неотличимы от честно пустых.
 */
export function introspect(
  outcomes: readonly RowOutcome[],
  kernel: Kernel,
  surface: 'cli' | 'daemon',
  options: {
    readonly browser?: BrowserIntrospection;
    readonly attribution?: IntrospectionAttribution;
  } = {},
): Introspection {
  return {
    version: 1,
    surface,
    rows: outcomes.map((outcome, index) => rowOf(kernel, outcome, index + 1)),
    builtin: builtinOf(kernel, outcomes),
    attribution: options.attribution ?? { available: true },
    browser: options.browser ?? { available: false, reason: 'осмотр не запрашивал состав браузерной половины' },
  };
}

/**
 * Осмотр, пришедший извне процесса (ответ демона команде, `plugins.ts`),
 * разобран целиком — не только по корню, но и по каждому полю, которое читает
 * печать.
 *
 * Проверка глубокая намеренно: ответ демона другой сборки с неполной строкой
 * дал бы `TypeError` уже за пределами `try` вокруг запроса и сменил бы код
 * возврата команды, чего требование «неудача обращения любой природы MUST NOT
 * менять кода возврата» не допускает. Состав, не подошедший под форму целиком,
 * становится названной причиной: номер формы (`version`) на то и есть, чтобы
 * расхождение было видно здесь, а не на первом разыменовании.
 */
export function isIntrospection(value: unknown): value is Introspection {
  if (!isRecord(value)) return false;
  return (
    value.version === 1 &&
    (value.surface === 'cli' || value.surface === 'daemon') &&
    Array.isArray(value.rows) &&
    value.rows.every((row: unknown) => isIntrospectionRowShaped(row)) &&
    isBuiltinShaped(value.builtin) &&
    isAttributionShaped(value.attribution) &&
    isBrowserShaped(value.browser)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isStringArray(value: unknown): boolean {
  return Array.isArray(value) && value.every((item: unknown) => typeof item === 'string');
}

function isContributionsShaped(value: unknown): boolean {
  return isRecord(value) && CONTRIB_KINDS.every((kind) => isStringArray(value[kind]));
}

function isDeclaredServiceShaped(value: unknown): boolean {
  return isRecord(value) && typeof value.name === 'string' && typeof value.slot === 'boolean';
}

function isRequestedServiceShaped(value: unknown): boolean {
  return isRecord(value) && typeof value.name === 'string' && typeof value.resolved === 'boolean';
}

function isLayerShaped(value: unknown): boolean {
  if (!isRecord(value)) return false;
  switch (value.kind) {
    case 'builtin':
      return true;
    case 'file':
      return typeof value.path === 'string';
    case 'directory':
      return typeof value.dir === 'string' && (value.layer === 'project' || value.layer === 'home');
    default:
      return false;
  }
}

function isStateShaped(value: unknown): boolean {
  if (!isRecord(value)) return false;
  switch (value.kind) {
    case 'active':
    case 'disabled':
    case 'not-attempted':
      return true;
    case 'failed':
      return typeof value.reason === 'string';
    default:
      return false;
  }
}

function isIntrospectionRowShaped(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    typeof value.place === 'number' &&
    typeof value.id === 'string' &&
    typeof value.use === 'string' &&
    isLayerShaped(value.layer) &&
    isStateShaped(value.state) &&
    (value.plugin === undefined || (isRecord(value.plugin) && typeof value.plugin.name === 'string')) &&
    Array.isArray(value.declaredServices) &&
    value.declaredServices.every((service: unknown) => isDeclaredServiceShaped(service)) &&
    Array.isArray(value.requestedServices) &&
    value.requestedServices.every((service: unknown) => isRequestedServiceShaped(service)) &&
    isContributionsShaped(value.contributions)
  );
}

function isBuiltinShaped(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.owner === 'string' &&
    isContributionsShaped(value.contributions) &&
    Array.isArray(value.declaredServices) &&
    value.declaredServices.every((service: unknown) => isDeclaredServiceShaped(service))
  );
}

function isAttributionShaped(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.available === true) return true;
  return value.available === false && typeof value.reason === 'string';
}

function isBrowserShaped(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.available === false) return typeof value.reason === 'string';
  return value.available === true && typeof value.observedAt === 'string' && typeof value.open === 'boolean';
}
