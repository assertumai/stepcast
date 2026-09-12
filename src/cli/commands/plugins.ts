import type { ResolvedConfig } from '../../core/config/resolve.js';
import { ExitCode, type ExitCodeValue } from '../../core/errors.js';
import {
  introspect,
  isIntrospection,
  type Introspection,
  type IntrospectionAttribution,
  type IntrospectionBuiltin,
  type IntrospectionContributions,
  type IntrospectionDeclaredService,
  type IntrospectionRequestedService,
  type IntrospectionRow,
  type IntrospectionState,
} from '../../core/plugins/introspect.js';
import type { Kernel } from '../../core/plugins/kernel.js';
import { inspectPluginTree, rowFailureError, type LoadOptions, type RowOutcome } from '../../core/plugins/load.js';
import type { TreeRow, TreeRowSource } from '../../core/plugins/tree.js';
import { daemonPaths, runningDaemon } from '../../ui/daemon.js';
import type { CliIo, ParsedArgs } from '../args.js';
import { formatColumns } from '../output.js';

/**
 * Команда осмотра дерева плагинов (`plugin-tree`, `plugin-introspection`,
 * design.md, Решение 8).
 *
 * Печатает итоговый состав — место, `id`, слой, модуль, состояние — тем же
 * образом, каким `stepcast config` печатает действующую конфигурацию, и
 * вдобавок объявленные/запрошенные сервисы и вклады каждой строки: одна
 * модель осмотра (`introspect.ts`) на текст, `--json` и раздел витрины —
 * им негде разойтись (design.md, Решение 1).
 *
 * Флаг `--dump` объявлен ради совместимости с прежним пунктом очереди;
 * поведение команды от него не зависит. `--json` печатает ту же модель
 * машинным форматом (Решение 10).
 */

/** Слой строки: «встроенный», путь файла либо каталог плагина с его слоем (`user-plugins`, задача 3.3). */
function describeLayer(layer: TreeRowSource): string {
  switch (layer.kind) {
    case 'builtin':
      return 'встроенный';
    case 'file':
      return layer.path;
    case 'directory':
      return `${layer.dir} (${layer.layer === 'project' ? 'проект' : 'дом'})`;
  }
}

function describeState(state: IntrospectionState): string {
  switch (state.kind) {
    case 'active':
      return 'действует';
    case 'disabled':
      return 'отключена';
    case 'not-attempted':
      return 'не загружалась';
    case 'failed':
      return `отказ: ${state.reason}`;
  }
}

const CONTRIB_LABELS = { backends: 'бэкенды', predicates: 'предикаты', commands: 'команды', steps: 'виды шага' } as const;

/**
 * Строки-дополнения: объявленные/запрошенные сервисы и вклады — только когда
 * есть что сказать. Общие для строки дерева и для раздела встроенного вне строк
 * (`renderBuiltin`): у обоих один состав сведений, и печататься он обязан
 * одинаково.
 */
function describeDetails(
  declared: readonly IntrospectionDeclaredService[],
  requested: readonly IntrospectionRequestedService[],
  contributions: IntrospectionContributions,
): string[] {
  const lines: string[] = [];

  if (declared.length > 0) {
    const names = declared.map((service) => (service.slot ? `${service.name} (слот)` : service.name));
    lines.push(`    сервисы объявлены: ${names.join(', ')}`);
  }

  if (requested.length > 0) {
    const names = requested.map((service) => `${service.name} (${service.resolved ? 'разрешён' : 'не разрешён'})`);
    lines.push(`    сервисы запрошены: ${names.join(', ')}`);
  }

  const contributionParts = (Object.keys(CONTRIB_LABELS) as (keyof typeof CONTRIB_LABELS)[])
    .filter((kind) => contributions[kind].length > 0)
    .map((kind) => `${CONTRIB_LABELS[kind]}: ${contributions[kind].join(', ')}`);
  if (contributionParts.length > 0) lines.push(`    вклады: ${contributionParts.join('; ')}`);

  return lines;
}

/** Печать одного дерева осмотра: прежние пять колонок плюс строки-дополнения (design.md, Migration Plan). */
export function renderIntrospectionRows(rows: readonly IntrospectionRow[]): string[] {
  const columns = formatColumns(
    rows.map((row) => [String(row.place), row.id, describeLayer(row.layer), row.use, describeState(row.state)]),
  );
  const out: string[] = [];
  rows.forEach((row, index) => {
    out.push(columns[index] ?? '');
    out.push(...describeDetails(row.declaredServices, row.requestedServices, row.contributions));
  });
  return out;
}

/**
 * Встроенное вне строк дерева (design.md, Решение 2, граница правила): виды
 * шага ядра, встроенные команды и служебные сервисы, заведённые до применения
 * первой строки, плюс всякая поздняя регистрация на корне. Печатается отдельным
 * разделом, а не приписывается строке наугад и не замалчивается.
 */
function renderBuiltin(builtin: IntrospectionBuiltin): string[] {
  const details = describeDetails(builtin.declaredServices, [], builtin.contributions);
  if (details.length === 0) return [];
  return [`${builtin.owner} (вне строк дерева):`, ...details];
}

/**
 * Приписывание не состоялось — названная причина вместо пустых перечней
 * (`plugin-introspection`, «Неизвестное осмотру называется причиной, а не
 * пустотой»).
 */
function renderAttribution(attribution: IntrospectionAttribution): string[] {
  if (attribution.available) return [];
  return [`вклады и сервисы строкам не приписаны: ${attribution.reason}`];
}

/** Одно дерево осмотра целиком: строки, встроенное вне строк и оговорка о приписывании. */
export function renderIntrospection(introspection: Introspection): string[] {
  return [
    ...renderIntrospectionRows(introspection.rows),
    ...renderBuiltin(introspection.builtin),
    ...renderAttribution(introspection.attribution),
  ];
}

/** Итог строки, выведенный из неё самой, — для вызывающего, который плагинов не загружал (реестр пришёл готовым). */
export function outcomeWithoutLoad(row: TreeRow): RowOutcome {
  const failure = rowFailureError(row);
  if (failure !== undefined) return { row, status: 'failed', error: failure };
  return { row, status: row.enabled ? 'active' : 'disabled' };
}

/**
 * Причина, которой осмотр называет непроставленное приписывание: реестр пришёл
 * готовым (`resolveWithPlugins` с полем `registry`), итоги строк выведены из
 * самих строк, и областей, по которым приписываются вклады и сервисы, ниоткуда
 * не взять. Названа здесь, рядом с печатью, и передаётся точкой входа.
 */
export const CACHED_REGISTRY_ATTRIBUTION: IntrospectionAttribution = {
  available: false,
  reason: 'реестр пришёл готовым: областей строк не сохранилось, и вклады с сервисами по строкам не разложены',
};

export type DaemonSection =
  | { readonly available: false; readonly reason: string }
  | { readonly available: true; readonly port: number; readonly introspection: Introspection };

const DAEMON_TIMEOUT_MS = 1000;

/**
 * Спросить дерево у поднятого демона витрины по петле (design.md, Решение 8).
 * Любая неудача — нет записи, процесс мёртв, отказ соединения, таймаут, ответ
 * не разобрался — становится названной причиной, а не исключением: раздел
 * витрины MUST NOT менять код возврата команды.
 */
async function fetchDaemonSection(): Promise<DaemonSection> {
  const record = runningDaemon(daemonPaths());
  if (record === undefined) {
    return { available: false, reason: 'демон витрины не запущен' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DAEMON_TIMEOUT_MS);
  try {
    const response = await fetch(`http://127.0.0.1:${record.port}/api/plugins`, { signal: controller.signal });
    if (!response.ok) {
      return { available: false, reason: `демон ответил кодом ${response.status}` };
    }
    const body: unknown = await response.json();
    if (!isIntrospection(body)) {
      return { available: false, reason: 'ответ демона не разобрался как осмотр' };
    }
    return { available: true, port: record.port, introspection: body };
  } catch (error) {
    return { available: false, reason: `демон не отвечает: ${error instanceof Error ? error.message : String(error)}` };
  } finally {
    clearTimeout(timer);
  }
}

/** Раздел витрины текстом: заголовок называет порт и чужое разрешение конфигурации (design.md, Решение 9). */
function renderDaemonSection(section: DaemonSection): string[] {
  if (!section.available) {
    return ['', `витрина: ${section.reason}`];
  }
  return [
    '',
    `витрина (демон на порту ${section.port}, дерево разрешено домашним слоем без проекта):`,
    ...renderIntrospection(section.introspection),
  ];
}

function isJsonRequested(args: ParsedArgs): boolean {
  return args.flags.json === true;
}

/** Машинный вывод: своё дерево плюс раздел витрины, названные отдельными полями — не слитые по `id` (Решение 9, 10). */
function printJson(io: CliIo, own: Introspection, daemon: DaemonSection): void {
  io.out(JSON.stringify({ own, daemon }, null, 2));
}

function printText(io: CliIo, own: Introspection, daemon: DaemonSection): void {
  for (const line of renderIntrospection(own)) io.out(line);
  for (const line of renderDaemonSection(daemon)) io.out(line);
}

/**
 * Путь успеха: итоги строк приходят те самые, которыми точка входа собрала
 * реестр (`CommandEnv.pluginOutcomes`, `resolveWithPlugins`), а не выведенные
 * из дерева заново — иначе отказ каталожной строки, ставший её состоянием
 * (design.md, Решение 10), не был бы виден в печати вовсе. Отказ отдельной
 * каталожной строки не меняет код возврата — команда исполнилась, дерево
 * напечатано целиком (`plugin-tree`, «Отказ найденной обходом строки не
 * прекращает команду»).
 *
 * `attribution` — оговорка вызывающего: точка входа, пришедшая с готовым
 * реестром, передаёт `CACHED_REGISTRY_ATTRIBUTION`, и печать называет причину
 * вместо пустых перечней вкладов и сервисов.
 */
export async function runPluginsCommand(
  args: ParsedArgs,
  io: CliIo,
  outcomes: readonly RowOutcome[],
  kernel: Kernel,
  attribution: IntrospectionAttribution = { available: true },
): Promise<ExitCodeValue> {
  const own = introspect(outcomes, kernel, 'cli', { attribution });
  const daemon = await fetchDaemonSection();
  if (isJsonRequested(args)) {
    printJson(io, own, daemon);
  } else {
    printText(io, own, daemon);
  }
  return ExitCode.ok;
}

/**
 * Путь после отказа загрузки (design.md, Решение 8): дерево берётся заново из
 * уже разрешённой конфигурации (`resolved`, разобрана точкой входа до того,
 * как определилось, что это команда `plugins`), а per-строчный итог и осмотр —
 * из `inspectPluginTree`, которая не бросает на первом отказе и собирает
 * осмотр до снятия своего ядра (Решение 15).
 */
export async function runPluginsCommandAfterLoadFailure(
  args: ParsedArgs,
  io: CliIo,
  resolved: ResolvedConfig,
  loadOptions: LoadOptions,
): Promise<ExitCodeValue> {
  const { introspection } = await inspectPluginTree(resolved, loadOptions);
  const daemon = await fetchDaemonSection();
  if (isJsonRequested(args)) {
    printJson(io, introspection, daemon);
  } else {
    printText(io, introspection, daemon);
  }
  return ExitCode.configError;
}
