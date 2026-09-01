import { globSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve as resolvePath } from 'node:path';

import { StepcastError } from '../errors.js';
import { formatTokens } from '../units.js';
import type { ContextEntry, ContextMode, ContextUpstream } from '../pipeline/model.js';
import type { KnowledgeEntry, KnowledgeSelector } from '../knowledge/types.js';
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

/**
 * Разрешение записи знания. Передаётся сборке колбэком, а не источником:
 * сборка не должна знать ни про конфигурацию, ни про запуск подпроцессов, а
 * тест должен уметь подставить сюда заглушку и не заводить репозиторий.
 *
 * Отсутствие колбэка при объявленной записи — внутренняя ошибка: линт
 * отклоняет такой документ раньше, и досюда он доехать не может.
 */
export type KnowledgeResolver = (
  selector: KnowledgeSelector,
  budget: number | undefined,
) => readonly KnowledgeEntry[];

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
  /** Источник знания. Объявляется только тем, у кого записи `knowledge:` возможны. */
  readonly knowledge?: KnowledgeResolver;
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
  /**
   * Идентификатор единицы знания, если запись пришла от источника. Отчёт
   * называет им запись вместо пути: путь у знания есть не всегда, а разобрать
   * состав контекста постфактум надо в любом случае.
   */
  readonly knowledgeId?: string;
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
        kind: item.knowledgeId === undefined ? item.kind : ('knowledge' as const),
        ...(item.knowledgeId === undefined ? {} : { id: item.knowledgeId }),
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
  if (entry.kind === 'knowledge') {
    resolveKnowledge(entry, origin, options, resolved, registry, denied);
    return;
  }

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

  const paths = expandPaths(entry.path, options.workspace);

  // Требование совпадений проверяется до отсева: `deny` и `context_exclude` —
  // осознанное решение автора, о котором движок и так сообщает событием, а
  // здесь речь о другом — о записи, не нашедшей вообще ничего.
  if (entry.required === true && paths.length === 0) {
    throw new StepcastError(`Обязательная запись контекста не дала ни одного файла: ${entry.path}`, {
      hint: 'Запись объявлена required: true — проверьте путь или снимите требование',
    });
  }

  for (const path of paths) {
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

/**
 * Разрешение записи знания. Отобранное источником проходит ровно тот же путь,
 * что файловая запись: `context.deny`, порог вставки, общий предел, склейку
 * повторов по пути. Иначе объявление `knowledge:` стало бы законным обходом
 * запрета — источник вернул бы `.env`, и запрет, действующий на глоб автора
 * пайплайна, на него бы не подействовал.
 *
 * `context_exclude` к записям знания не применяется: он исключает **пути**,
 * а знание объявляется селектором, и отбор его по путям означал бы, что
 * автор исключает то, о чём не знает.
 */
function resolveKnowledge(
  entry: Extract<ContextEntry, { kind: 'knowledge' }>,
  origin: Origin,
  options: AssembleOptions,
  resolved: Resolved[],
  registry: Map<string, Resolved>,
  denied: Set<string>,
): void {
  if (options.knowledge === undefined) {
    throw new StepcastError('Запись контекста knowledge объявлена без источника знания', {
      hint: 'Объявите project.knowledge в .stepcast/config.yml',
    });
  }

  for (const item of options.knowledge(entry.selector, entry.budget)) {
    if (item.path === undefined) {
      // Знание без файла склеивается по идентификатору — тем же правилом,
      // каким файловая запись склеивается по пути. Тождество здесь есть, в
      // отличие от записи `text`: одна и та же единица, названная пайплайном
      // и работой, — это промах адресации, а не осознанное повторение. Без
      // склейки оглавление, объявленное на двух уровнях, уезжало бы агенту
      // дважды и стоило бы вдвое.
      const key = `knowledge:${item.id}`;
      const existing = registry.get(key);
      if (existing !== undefined) {
        mergeDeclaration(existing, origin, 'auto', options.inlineThreshold);
        continue;
      }

      const entry: Resolved = {
        origin,
        origins: [origin],
        kind: 'text',
        knowledgeId: item.id,
        content: item.text ?? '',
        tokens: item.tokens,
        pinned: true,
        mode: 'inline',
      };
      resolved.push(entry);
      registry.set(key, entry);
      continue;
    }

    const absolute = resolvePath(options.workspace, item.path);
    const relativePath = toRelative(absolute, options.workspace);
    const key = registryKey(absolute, options.workspace);

    const denialPattern = matchesAnyGlob(relativePath, options.deny);
    if (denialPattern !== undefined) {
      if (!denied.has(key)) {
        denied.add(key);
        options.onDenied?.(relativePath, denialPattern);
      }
      continue;
    }

    const existing = registry.get(key);
    if (existing !== undefined) {
      mergeDeclaration(existing, origin, 'auto', options.inlineThreshold);
      continue;
    }

    let content: string;
    try {
      content = readFileSync(absolute, 'utf8');
    } catch (error) {
      throw new StepcastError(`Источник знания назвал нечитаемый файл: ${relativePath}`, {
        file: absolute,
        cause: error,
      });
    }

    const tokens = estimateTokens(content);
    const item_: Resolved = {
      origin,
      origins: [origin],
      kind: 'path',
      path: relativePath,
      knowledgeId: item.id,
      content,
      tokens,
      pinned: false,
      mode: tokens <= options.inlineThreshold ? 'inline' : 'reference',
    };
    resolved.push(item_);
    registry.set(key, item_);
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
