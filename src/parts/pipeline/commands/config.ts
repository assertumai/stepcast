import { describeSource, resolveConfig, type ResolvedConfig } from '../index.js';
import { formatDuration, formatMoney, formatTokens } from '../../../kernel/units.js';
import { ExitCode, type ExitCodeValue } from '../../../kernel/errors.js';
import type { PipelineCommandEnv } from '../contract.js';
import { formatColumns } from '../../../kernel/cli/output.js';
import { commandRow } from '../../../kernel/cli/commandRow.js';
import type { ParsedArgs } from '../../../kernel/cli/args.js';
import { contributionOwner, type Registry } from '../../../kernel/registry.js';

/** Ключи, чьи значения хранятся числом, но читаются человеком в единицах. */
const TOKEN_KEYS = new Set([
  'limits.tokens',
  'context.inline_threshold',
  'context.max_tokens',
  'context.note_max_tokens',
]);
const DURATION_KEYS = new Set([
  'runs.keep',
  'defaults.step_timeout',
  'defaults.stall_timeout',
  'defaults.max_wait',
  'limits.wallclock',
]);
const MONEY_KEYS = new Set(['limits.cost']);

/**
 * Элемент `project.nested_repos` в отчёте: строковая форма печатается как
 * есть, объектная — каталогом с объявлениями в скобках, потому что счётчик
 * скрыл бы ровно то, ради чего вложенный репозиторий их объявил.
 */
function describeNestedRepoEntry(item: unknown): string {
  if (typeof item !== 'object' || item === null) return String(item);

  const raw = item as Record<string, unknown>;
  const dir = typeof raw.dir === 'string' ? raw.dir : '?';
  const parts: string[] = [];
  if (typeof raw.check === 'string') parts.push(`check: ${raw.check}`);
  const spec = raw.spec as Record<string, unknown> | undefined;
  if (typeof spec?.dir === 'string') parts.push(`spec.dir: ${spec.dir}`);
  if (typeof spec?.rules === 'string') parts.push(`spec.rules: ${spec.rules}`);
  if (typeof spec?.tool === 'string') parts.push(`spec.tool: ${spec.tool}`);
  if (typeof spec?.check === 'string') parts.push(`spec.check: ${spec.check}`);

  return parts.length === 0 ? dir : `${dir} (${parts.join(', ')})`;
}

function renderValue(path: string, value: unknown): string {
  if (typeof value === 'number') {
    if (TOKEN_KEYS.has(path)) return formatTokens(value);
    if (DURATION_KEYS.has(path)) return formatDuration(value);
    if (MONEY_KEYS.has(path)) return formatMoney(value);
  }
  // Списки запретов (env_deny, context.deny) сводятся к счётчику намеренно:
  // сами шаблоны читатель видит в столбце вклада каждого слоя. Объявления
  // (project.tools, project.edit_paths, project.nested_repos, записи таблицы
  // раннеров) — не запреты, а состав, и счётчик скрыл бы единственное, что в
  // отчёте имеет смысл, — сами значения. Для раннеров это ещё и единственный
  // ответ на вопрос «чем исполнится .py»: команда и закреплённые расширения
  // видны рядом с тем слоем, который их назвал.
  if (Array.isArray(value)) {
    if (path === 'project.tools' || path === 'project.edit_paths') return value.join(', ');
    if (path === 'project.nested_repos') return value.map(describeNestedRepoEntry).join(', ');
    // Команда печатается пробелами — так её и набирают в оболочке; список
    // расширений остаётся списком.
    if (path.startsWith('runners.')) return value.join(path.endsWith('.command') ? ' ' : ', ');
    return `${value.length} шаблонов`;
  }
  return String(value);
}

/**
 * Раздел о загруженных плагинах: чем движок сегодня расширен и откуда это
 * пришло. Отчёт о конфигурации без него отвечал бы на вопрос «какие
 * настройки», умалчивая о том, кто их принёс.
 *
 * Полного ответа на «что загружено и откуда» этот раздел не обещает: состав
 * строк, их порядок и слой каждой — у `stepcast plugins` (`plugin-tree`,
 * design.md, Решение 8), а не здесь.
 */
export function renderPluginsReport(registry: Registry | undefined): string[] {
  if (registry === undefined || registry.plugins.length === 0) return [];

  const lines = ['', 'Плагины (полное дерево со слоями и порядком — stepcast plugins):'];
  for (const plugin of registry.plugins) {
    const contributions: string[] = [];
    const own = (kind: 'backends' | 'predicates' | 'commands'): string[] =>
      [...registry[kind].keys()].filter((name) => contributionOwner(registry, kind, name) === plugin.name).sort();

    const backends = own('backends');
    const predicates = own('predicates');
    const commands = own('commands');
    if (backends.length > 0) contributions.push(`бэкенды: ${backends.join(', ')}`);
    if (predicates.length > 0) contributions.push(`предикаты: ${predicates.join(', ')}`);
    if (commands.length > 0) contributions.push(`команды: ${commands.join(', ')}`);

    lines.push(`  ${plugin.name}${plugin.version === undefined ? '' : ` ${plugin.version}`}`);
    lines.push(`    модуль: ${plugin.source}`);
    lines.push(`    вклады: ${contributions.length === 0 ? 'нет' : contributions.join('; ')}`);
  }
  return lines;
}

/**
 * Раздел о недостающих служебных сервисах пайплайна (design.md изменения
 * `pipeline-owns-services`, Решение 8): состав без строки `pipeline` — законное
 * состояние ядра, и отчёт называет причину прямо, а не молчит пустыми
 * перечнями бэкендов, предикатов и видов шага, будто их никогда не было.
 */
export function renderMissingServicesReport(registry: Registry | undefined): string[] {
  if (registry === undefined || registry.missingServices.length === 0) return [];
  return [
    '',
    `Сервисы пайплайна не заведены: ${registry.missingServices.join(', ')} — строку, которая их заводит, отключил патч либо она снята из перечня состава (см. stepcast plugins)`,
  ];
}

/**
 * Строка отчёта для ключа `plugins`: действующее значение — проекция
 * итогового дерева (`Config.plugins`: модули действующих строк в порядке
 * дерева), а вклад слоёв — объявленное, как у прочих складывающихся списков
 * (`stepcast-configuration`).
 *
 * Объявленное и действующее здесь расходятся законно: патч заменяет строку
 * чужим модулем, отключает её или вставляет свою, а ключ `plugins` об этом не
 * знает. Печатать суммой объявленного значит называть действующим состав,
 * которого не будет, — ровно та ложь, ради которой второго представления
 * состава и не заведено (`config/resolve.ts`, `Config.plugins`).
 */
function renderPluginsRow(resolved: ResolvedConfig): string[] {
  const contributions = resolved.denyContributions.get('plugins') ?? [];
  const breakdown = contributions
    .map((item) => `${describeSource(item.source)} (${item.patterns.length})`)
    .join(' + ');
  const effective = resolved.config.plugins;
  return ['plugins', effective.length === 0 ? 'нет' : effective.join(', '), breakdown];
}

export function renderConfigReport(resolved: ResolvedConfig): string[] {
  const rows: string[][] = [];
  const paths = [...resolved.provenance.keys()];
  // Ключ `plugins` печатается и тогда, когда его не объявлял ни один слой:
  // строку дерева приносит ещё и патч, а его `provenance` не знает — он не про
  // точечные пути (`config/resolve.ts`).
  if (!paths.includes('plugins') && resolved.config.plugins.length > 0) paths.push('plugins');
  paths.sort();

  for (const path of paths) {
    if (path === 'plugins') {
      rows.push(renderPluginsRow(resolved));
      continue;
    }

    const contributions = resolved.denyContributions.get(path);
    if (contributions !== undefined) {
      const breakdown = contributions
        .map((item) => `${describeSource(item.source)} (${item.patterns.length})`)
        .join(' + ');
      const total = (resolved.provenance.has(path) ? contributions : []).reduce(
        (sum, item) => sum + item.patterns.length,
        0,
      );
      rows.push([path, `${total} шаблонов`, breakdown]);
      continue;
    }

    const source = resolved.provenance.get(path);
    rows.push([
      path,
      renderValue(path, resolved.values.get(path)),
      source === undefined ? '' : describeSource(source),
    ]);
  }

  return formatColumns(rows);
}

export function runConfigCommand(
  args: ParsedArgs,
  write: (line: string) => void,
  cwd: string,
  registry?: Registry,
): ExitCodeValue {
  const flags: Record<string, unknown> = {};
  if (typeof args.flags.model === 'string') flags['defaults.model'] = args.flags.model;
  if (typeof args.flags.agent === 'string') flags['defaults.agent'] = args.flags.agent;

  // Флаги перекрывают слои, поэтому конфигурация разрешается здесь заново.
  // Умолчания плагинов при этом сохраняются: их приносит тот же реестр,
  // который уже собрала точка входа.
  const resolved = resolveConfig({ cwd, flags, ...pluginDefaultsOf(registry) });
  for (const line of renderConfigReport(resolved)) write(line);
  for (const line of renderPluginsReport(registry)) write(line);
  for (const line of renderMissingServicesReport(registry)) write(line);
  return ExitCode.ok;
}

/** Умолчания бэкендов из реестра — тем же слоем, что и при разрешении в точке входа. */
function pluginDefaultsOf(registry: Registry | undefined): {
  pluginDefaults?: readonly { plugin: string; values: Record<string, unknown> }[];
} {
  if (registry === undefined) return {};
  const layers = registry.plugins.flatMap((plugin) => {
    const backends: Record<string, unknown> = {};
    for (const [name, contribution] of registry.backends) {
      if (contribution.defaults === undefined) continue;
      if (contributionOwner(registry, 'backends', name) !== plugin.name) continue;
      backends[name] = contribution.defaults;
    }
    return Object.keys(backends).length === 0 ? [] : [{ plugin: plugin.name, values: { backends } }];
  });
  return layers.length === 0 ? {} : { pluginDefaults: layers };
}

export const row = commandRow<PipelineCommandEnv>({
  name: 'config',
  spec: {
    description: 'показать действующую конфигурацию и происхождение каждого значения',
    flags: {
      model: { kind: 'string', description: 'переопределить модель по умолчанию' },
      agent: { kind: 'string', description: 'переопределить бэкенд по умолчанию' },
    },
  },
  run: (args, io, env) => runConfigCommand(args, io.out, env.cwd, env.registry),
});
