import { globSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve as resolvePath } from 'node:path';

import { StepcastError } from '../errors.js';
import { formatTokens } from '../units.js';
import type { ContextEntry, ContextMode, ContextUpstream } from '../pipeline/model.js';
import type { ContextEntryReport, ContextReport } from './report.js';
import { matchesAnyGlob } from './glob.js';

/**
 * Сборка контекста агентского шага.
 *
 * Записи склеиваются сверху вниз: выходы предшественников, пайплайн, работа,
 * шаг. Порядок нужен не для кеша — им управляет бэкенд, — а для детерминизма:
 * одинаковый вход должен давать посимвольно одинаковый промпт, иначе ключ шага
 * плавает, а `stepcast diff` показывает шум вместо разницы.
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
  /**
   * Предел, в который движок обязан уложить формируемые им самим записи.
   * Объявляется только когда такая запись в контексте есть: шага без неё
   * противоречие между двумя пределами не касается.
   */
  readonly noteMaxTokens?: number;
  readonly onDenied?: (path: string, pattern: string) => void;
  readonly onDowngraded?: (path: string, tokens: number) => void;
}

export interface AssembledContext {
  readonly text: string;
  readonly report: ContextReport;
}

interface Resolved {
  /** Уровень места записи: где склеенная запись фактически стоит в промпте. */
  readonly origin: Origin;
  /** Уровни объявления в каноническом порядке, без повторов внутри уровня. */
  readonly origins: Origin[];
  readonly kind: 'path' | 'text';
  readonly path?: string;
  readonly content: string;
  readonly tokens: number;
  /** Явное указание не понижается: иначе оно перестаёт что-либо значить. */
  pinned: boolean;
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
  // Тождество записей — разрешённый абсолютный путь. Реестр наполняется тем
  // же проходом, что и `resolved`, поэтому повтор находит своё место без
  // второго чтения файла: см. Решение 2 в design.md изменения context-dedup.
  const registry = new Map<string, Resolved>();
  // Отклонённые пути в реестр не попадают, но событие об отказе — такой же
  // след одного файла, как и запись: путь под `context.deny`, названный на
  // двух уровнях, обязан дать одно событие, а не по одному на объявление.
  const denied = new Set<string>();

  for (const output of selectUpstream(options.upstream, options.contextUpstream)) {
    const key = registryKey(output.path, options.workspace);
    if (registry.has(key)) continue;

    const content = JSON.stringify(output.value, null, 2);
    const item: Resolved = {
      origin: 'upstream',
      origins: ['upstream'],
      kind: 'path',
      path: output.path,
      content,
      tokens: estimateTokens(content),
      pinned: false,
      mode: 'inline',
    };
    resolved.push(item);
    registry.set(key, item);
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
      resolveEntry(entry, origin, options, resolved, registry, denied);
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
        ...(item.origins.length > 1 ? { declared_in: item.origins } : {}),
      })),
      total_tokens: resolved.reduce(
        (sum, item) => sum + (item.mode === 'inline' ? item.tokens : referenceTokens(item)),
        0,
      ),
    },
  };
}

/**
 * Ключ тождества: нормализованный абсолютный путь, независимо от формы, в
 * которой он объявлен. Относительный путь якорится на рабочей директории шага —
 * той же, что `expandPaths`, иначе относительно объявленный выход
 * предшественника тихо разошёлся бы с ключом уровня и склейка бы не сработала.
 */
function registryKey(path: string, workspace: string): string {
  return resolvePath(workspace, path);
}

/**
 * Сила объявления способа передачи: явный `inline` сильнее вставки,
 * полученной из `auto` по порогу, а вставка сильнее передачи путём. Решение 3
 * в design.md изменения context-dedup.
 */
function declarationStrength(mode: ContextMode, tokens: number, inlineThreshold: number): number {
  if (mode === 'inline') return 2;
  if (mode === 'reference') return 0;
  return tokens <= inlineThreshold ? 1 : 0;
}

/** Сила уже разрешённой записи, восстановленная из её текущих `mode`/`pinned`. */
function strengthOf(item: Resolved): number {
  if (item.mode === 'reference') return 0;
  return item.pinned ? 2 : 1;
}

/**
 * Повторное объявление того же пути: дописывает уровень в `declared_in` и
 * поднимает способ передачи, только если новое объявление строго сильнее —
 * иначе исход не зависел бы от порядка обхода уровней.
 */
function mergeDeclaration(
  existing: Resolved,
  origin: Origin,
  mode: ContextMode,
  inlineThreshold: number,
): void {
  if (!existing.origins.includes(origin)) existing.origins.push(origin);

  const strength = declarationStrength(mode, existing.tokens, inlineThreshold);
  if (strength > strengthOf(existing)) {
    existing.pinned = strength === 2;
    existing.mode = strength === 0 ? 'reference' : 'inline';
  }
}

function selectUpstream(
  outputs: readonly UpstreamOutput[],
  selector: ContextUpstream,
): readonly UpstreamOutput[] {
  if (selector === 'none') return [];
  if (selector === 'all') return outputs;
  return outputs.filter((output) => selector.includes(output.job));
}

function resolveEntry(
  entry: ContextEntry,
  origin: Origin,
  options: AssembleOptions,
  resolved: Resolved[],
  registry: Map<string, Resolved>,
  denied: Set<string>,
): void {
  if (entry.kind === 'text') {
    // `text` не участвует в склейке: у записи нет пути, а совпадение
    // содержимого на двух уровнях — осознанное повторение, а не промах
    // адресации (Non-Goals в design.md изменения context-dedup).
    resolved.push({
      origin,
      origins: [origin],
      kind: 'text',
      content: entry.text,
      tokens: estimateTokens(entry.text),
      pinned: true,
      mode: 'inline',
    });
    return;
  }

  for (const path of expandPaths(entry.path, options.workspace)) {
    const relativePath = toRelative(path, options.workspace);
    const key = registryKey(path, options.workspace);

    const denialPattern = matchesAnyGlob(relativePath, options.deny);
    if (denialPattern !== undefined) {
      if (!denied.has(key)) {
        denied.add(key);
        options.onDenied?.(relativePath, denialPattern);
      }
      continue;
    }

    if (matchesAnyGlob(relativePath, options.exclude) !== undefined) continue;

    const existing = registry.get(key);
    if (existing !== undefined) {
      mergeDeclaration(existing, origin, entry.mode, options.inlineThreshold);
      continue;
    }

    let content: string;
    try {
      content = readFileSync(path, 'utf8');
    } catch (error) {
      throw new StepcastError(`Не удалось прочитать файл контекста: ${relativePath}`, {
        file: path,
        cause: error,
      });
    }

    const tokens = estimateTokens(content);
    const strength = declarationStrength(entry.mode, tokens, options.inlineThreshold);
    const item: Resolved = {
      origin,
      origins: [origin],
      kind: 'path',
      path: relativePath,
      content,
      tokens,
      pinned: strength === 2,
      mode: strength === 0 ? 'reference' : 'inline',
    };
    resolved.push(item);
    registry.set(key, item);
  }
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
  // Заведомо противоречивая настройка: движок обещает уложить свои записи в
  // noteMaxTokens, но предел контекста шага этого даже теоретически не
  // допускает. Ловим это раньше, чем реальный размер — иначе отказ выглядел
  // бы как случайное превышение, а не как ошибка настройки.
  if (options.noteMaxTokens !== undefined && options.maxTokens < options.noteMaxTokens) {
    throw new StepcastError(
      `Предел контекста шага меньше предела выдержки: ${formatTokens(options.maxTokens)} против ${formatTokens(options.noteMaxTokens)}`,
      {
        hint: 'Поднимите context_max_tokens или снизьте context.note_max_tokens',
      },
    );
  }

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

  throw new StepcastError(
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
