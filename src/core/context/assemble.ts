import { globSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve as resolvePath } from 'node:path';

import { ScarpError } from '../errors.js';
import { formatTokens } from '../units.js';
import type { ContextEntry, ContextUpstream } from '../pipeline/model.js';
import type { ContextEntryReport, ContextReport } from './report.js';
import { matchesAnyGlob } from './glob.js';

/**
 * Сборка контекста агентского шага.
 *
 * Записи склеиваются сверху вниз: выходы предшественников, пайплайн, работа,
 * шаг. Порядок нужен не для кеша — им управляет бэкенд, — а для детерминизма:
 * одинаковый вход должен давать посимвольно одинаковый промпт, иначе ключ шага
 * плавает, а `scarp diff` показывает шум вместо разницы.
 */

export type Origin = ContextEntryReport['origin'];

export interface UpstreamOutput {
  readonly job: string;
  readonly path: string;
  readonly value: unknown;
}

export interface AssembleOptions {
  readonly workspace: string;
  readonly pipeline: readonly ContextEntry[];
  readonly job: readonly ContextEntry[];
  readonly step: readonly ContextEntry[];
  readonly upstream: readonly UpstreamOutput[];
  readonly contextUpstream: ContextUpstream;
  readonly inherit: boolean;
  readonly exclude: readonly string[];
  readonly deny: readonly string[];
  readonly inlineThreshold: number;
  readonly maxTokens: number;
  readonly onDenied?: (path: string, pattern: string) => void;
  readonly onDowngraded?: (path: string, tokens: number) => void;
}

export interface AssembledContext {
  readonly text: string;
  readonly report: ContextReport;
}

interface Resolved {
  readonly origin: Origin;
  readonly kind: 'path' | 'text';
  readonly path?: string;
  readonly content: string;
  readonly tokens: number;
  /** Явное указание не понижается: иначе оно перестаёт что-либо значить. */
  readonly pinned: boolean;
  mode: 'inline' | 'reference';
}

/**
 * Оценка размера. Точного токенизатора у клиента нет, поэтому величина везде
 * подписана как оценка: латиница считается примерно по четыре символа на
 * токен, прочие письменности — по два, что ближе к правде для кириллицы.
 */
export function estimateTokens(text: string): number {
  let ascii = 0;
  let other = 0;
  for (const char of text) {
    if (char.charCodeAt(0) < 128) ascii += 1;
    else other += 1;
  }
  return Math.ceil(ascii / 4 + other / 2);
}

export function assembleContext(options: AssembleOptions): AssembledContext {
  const resolved: Resolved[] = [];

  for (const output of selectUpstream(options.upstream, options.contextUpstream)) {
    const content = JSON.stringify(output.value, null, 2);
    resolved.push({
      origin: 'upstream',
      kind: 'path',
      path: output.path,
      content,
      tokens: estimateTokens(content),
      pinned: false,
      mode: 'inline',
    });
  }

  const levels: Array<readonly [Origin, readonly ContextEntry[]]> = options.inherit
    ? [
        ['pipeline', options.pipeline],
        ['job', options.job],
        ['step', options.step],
      ]
    : [['step', options.step]];

  for (const [origin, entries] of levels) {
    for (const entry of entries) {
      resolved.push(...resolveEntry(entry, origin, options));
    }
  }

  applyBudget(resolved, options);

  return {
    text: render(resolved, options.workspace),
    report: {
      entries: resolved.map((item) => ({
        origin: item.origin,
        kind: item.kind,
        ...(item.path === undefined ? {} : { path: item.path }),
        mode: item.mode,
        tokens: item.mode === 'inline' ? item.tokens : referenceTokens(item),
      })),
      total_tokens: resolved.reduce(
        (sum, item) => sum + (item.mode === 'inline' ? item.tokens : referenceTokens(item)),
        0,
      ),
    },
  };
}

function selectUpstream(
  outputs: readonly UpstreamOutput[],
  selector: ContextUpstream,
): readonly UpstreamOutput[] {
  if (selector === 'none') return [];
  if (selector === 'all') return outputs;
  return outputs.filter((output) => selector.includes(output.job));
}

function resolveEntry(entry: ContextEntry, origin: Origin, options: AssembleOptions): Resolved[] {
  if (entry.kind === 'text') {
    return [
      {
        origin,
        kind: 'text',
        content: entry.text,
        tokens: estimateTokens(entry.text),
        pinned: true,
        mode: 'inline',
      },
    ];
  }

  const out: Resolved[] = [];

  for (const path of expandPaths(entry.path, options.workspace)) {
    const relativePath = toRelative(path, options.workspace);

    const denied = matchesAnyGlob(relativePath, options.deny);
    if (denied !== undefined) {
      options.onDenied?.(relativePath, denied);
      continue;
    }

    if (matchesAnyGlob(relativePath, options.exclude) !== undefined) continue;

    let content: string;
    try {
      content = readFileSync(path, 'utf8');
    } catch (error) {
      throw new ScarpError(`Не удалось прочитать файл контекста: ${relativePath}`, {
        file: path,
        cause: error,
      });
    }

    const tokens = estimateTokens(content);
    const pinned = entry.mode === 'inline';
    const mode: 'inline' | 'reference' =
      entry.mode === 'reference'
        ? 'reference'
        : pinned || tokens <= options.inlineThreshold
          ? 'inline'
          : 'reference';

    out.push({ origin, kind: 'path', path: relativePath, content, tokens, pinned, mode });
  }

  return out;
}

/** Раскрытие глоба идёт с сортировкой: порядок должен быть воспроизводимым. */
function expandPaths(pattern: string, workspace: string): string[] {
  const absolute = isAbsolute(pattern) ? pattern : resolvePath(workspace, pattern);

  if (!/[*?[]/.test(pattern)) {
    return [absolute];
  }

  const matches = globSync(pattern, { cwd: workspace }) as string[];
  return matches
    .map((match) => (isAbsolute(match) ? match : resolvePath(workspace, match)))
    .filter((path) => {
      try {
        return statSync(path).isFile();
      } catch {
        return false;
      }
    })
    .sort();
}

function toRelative(path: string, workspace: string): string {
  const rel = relative(workspace, path);
  return rel === '' || rel.startsWith('..') ? path : rel.replace(/\\/g, '/');
}

/** Ссылка стоит примерно строку с путём — считаем её честно, а не нулём. */
function referenceTokens(item: Resolved): number {
  return estimateTokens(item.path ?? '') + 8;
}

/**
 * Уложиться в предел: сначала понижаем записи режима `auto` от самой крупной,
 * и только если это не помогло — отказываем шагу. Понижение не теряет данные,
 * файл остаётся доступен агенту по пути; усечение содержимого дало бы неверный
 * результат, выглядящий нормальным.
 */
function applyBudget(resolved: Resolved[], options: AssembleOptions): void {
  const total = (): number =>
    resolved.reduce(
      (sum, item) => sum + (item.mode === 'inline' ? item.tokens : referenceTokens(item)),
      0,
    );

  if (total() <= options.maxTokens) return;

  const downgradable = resolved
    .filter((item) => item.mode === 'inline' && !item.pinned && item.kind === 'path')
    .sort((left, right) => right.tokens - left.tokens);

  for (const item of downgradable) {
    item.mode = 'reference';
    options.onDowngraded?.(item.path ?? '', item.tokens);
    if (total() <= options.maxTokens) return;
  }

  const biggest = [...resolved]
    .sort((left, right) => right.tokens - left.tokens)
    .slice(0, 3)
    .map((item) => `${item.path ?? 'текст'} (${formatTokens(item.tokens)})`);

  throw new ScarpError(
    `Контекст шага превышает предел: ${formatTokens(total())} против ${formatTokens(options.maxTokens)}`,
    {
      hint: `Крупнейшие записи: ${biggest.join(', ')}. Поднимите context_max_tokens или сузьте контекст`,
    },
  );
}

function render(resolved: readonly Resolved[], workspace: string): string {
  const blocks: string[] = [];
  let lastOrigin: Origin | undefined;

  for (const item of resolved) {
    if (item.origin !== lastOrigin) {
      blocks.push(`## ${ORIGIN_TITLE[item.origin]}`);
      lastOrigin = item.origin;
    }

    if (item.kind === 'text') {
      blocks.push(item.content.trimEnd());
      continue;
    }

    if (item.mode === 'reference') {
      blocks.push(`Файл ${item.path} — прочитай сам, если понадобится.`);
      continue;
    }

    blocks.push(`### ${item.path}\n\n${item.content.trimEnd()}`);
  }

  if (blocks.length === 0) return '';
  return `${blocks.join('\n\n')}\n\nРабочая директория: ${workspace}\n`;
}

const ORIGIN_TITLE: Record<Origin, string> = {
  upstream: 'Результаты предыдущих работ',
  pipeline: 'Контекст пайплайна',
  job: 'Контекст работы',
  step: 'Контекст шага',
};
