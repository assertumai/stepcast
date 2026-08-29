import { describeSource, resolveConfig, type ResolvedConfig } from '../../core/index.js';
import { formatDuration, formatMoney, formatTokens } from '../../core/units.js';
import { ExitCode, type ExitCodeValue } from '../../core/errors.js';
import { formatColumns } from '../output.js';
import type { ParsedArgs } from '../args.js';

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

function renderValue(path: string, value: unknown): string {
  if (typeof value === 'number') {
    if (TOKEN_KEYS.has(path)) return formatTokens(value);
    if (DURATION_KEYS.has(path)) return formatDuration(value);
    if (MONEY_KEYS.has(path)) return formatMoney(value);
  }
  // Списки запретов (env_deny, context.deny) сводятся к счётчику намеренно:
  // сами шаблоны читатель видит в столбце вклада каждого слоя. project.tools
  // — не запрет, а объявление, и счётчик скрыл бы единственное, что в отчёте
  // имеет смысл, — сами имена.
  if (Array.isArray(value)) {
    if (path === 'project.tools') return value.join(', ');
    return `${value.length} шаблонов`;
  }
  return String(value);
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
): ExitCodeValue {
  const flags: Record<string, unknown> = {};
  if (typeof args.flags.model === 'string') flags['defaults.model'] = args.flags.model;
  if (typeof args.flags.agent === 'string') flags['defaults.agent'] = args.flags.agent;

  const resolved = resolveConfig({ cwd, flags });
  for (const line of renderConfigReport(resolved)) write(line);
  return ExitCode.ok;
}
