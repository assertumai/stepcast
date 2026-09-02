import { describeSource, resolveConfig, type ResolvedConfig } from '../../core/index.js';
import { formatDuration, formatMoney, formatTokens } from '../../core/units.js';
import { ExitCode, type ExitCodeValue } from '../../core/errors.js';
import { formatColumns } from '../output.js';
import type { ParsedArgs } from '../args.js';
import { contributionOwner, type Registry } from '../../core/plugins/registry.js';

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
  // (project.tools, project.edit_paths, project.nested_repos) — не запреты,
  // а состав, и счётчик скрыл бы единственное, что в отчёте имеет смысл, —
  // сами значения.
  if (Array.isArray(value)) {
    if (path === 'project.tools' || path === 'project.edit_paths') return value.join(', ');
    if (path === 'project.nested_repos') return value.map(describeNestedRepoEntry).join(', ');
    return `${value.length} шаблонов`;
  }
  return String(value);
}

/**
 * Раздел о загруженных плагинах: чем движок сегодня расширен и откуда это
 * пришло. Отчёт о конфигурации без него отвечал бы на вопрос «какие
 * настройки», умалчивая о том, кто их принёс.
 */
export function renderPluginsReport(registry: Registry | undefined): string[] {
  if (registry === undefined || registry.plugins.length === 0) return [];

  const lines = ['', 'Плагины:'];
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

export function renderConfigReport(resolved: ResolvedConfig): string[] {
  const rows: string[][] = [];
  const paths = [...resolved.provenance.keys()].sort();

  for (const path of paths) {
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
