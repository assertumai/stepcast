import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';

/**
 * Разбор `pipeline.lock.yml` для витрины.
 *
 * Мягкий намеренно: обратного парсера лока в проекте нет — есть только
 * сериализатор `pipelineToPlain`. Заводить строгую схему ради интерфейса,
 * который только показывает уже записанное, значит расширять его задачу.
 * Отсутствующий файл и неожиданная форма поля дают пустоту в интерфейсе, а не
 * отказ демона: строгую проверку по-прежнему дают `lint` и `status`.
 */

export interface LockStep {
  readonly id: string;
  readonly kind: 'agent' | 'run';
  /** Бэкенд агентского шага. */
  readonly agent?: string;
  /** Модель, если шаг её назвал; иначе действует модель бэкенда. */
  readonly model?: string;
  /** Промпт агентского шага целиком — лок хранит его раскрытым. */
  readonly prompt?: string;
  /** Команда командного шага, как она записана: строкой или списком argv. */
  readonly command?: string;
  readonly context: readonly string[];
}

export interface LockJob {
  readonly id: string;
  readonly description?: string;
  readonly needs: readonly string[];
  /** Условие исполнения работы, как записано в определении. */
  readonly if?: string;
  /** Исход предшественников, при котором работа запускается. */
  readonly on: 'success' | 'failure' | 'always';
  /** Работа объявляет выход — значит, у неё может быть `artifacts/<id>.json`. */
  readonly publishesOutput: boolean;
  /**
   * Подпись работы, как объявлена: шаблоны нераскрыты. Раскрывает их снимок,
   * против данных, опубликованных работами этого прогона.
   */
  readonly display?: Readonly<Record<string, string>>;
  readonly context: readonly string[];
  readonly steps: readonly LockStep[];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** Подпись лока: карта строк в строки. Всё, что не строка, отбрасывается. */
function displayMap(value: unknown): Record<string, string> | undefined {
  const record = asRecord(value);
  if (record === undefined) return undefined;
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(record)) {
    if (typeof item === 'string') out[key] = item;
  }
  return Object.keys(out).length === 0 ? undefined : out;
}

/** Записи контекста лока разнородны: строка, `{ path }` или `{ text }`. */
function contextLabels(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry === 'string') {
      out.push(entry);
      continue;
    }
    const record = asRecord(entry);
    if (record === undefined) continue;
    const path = asString(record.path);
    if (path !== undefined) {
      out.push(path);
      continue;
    }
    const text = asString(record.text);
    if (text !== undefined) out.push(`текст: ${text.trim().split('\n')[0] ?? ''}`);
  }
  return out;
}

/** Команда шага: в локе она либо строкой, либо списком argv. */
function commandLabel(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.filter((part) => typeof part === 'string').join(' ');
  return undefined;
}

function toStep(value: unknown): LockStep | undefined {
  const record = asRecord(value);
  if (record === undefined) return undefined;
  const id = asString(record.id);
  if (id === undefined) return undefined;

  const prompt = asString(record.prompt);
  const command = commandLabel(record.run);
  const agent = asString(record.agent);
  const model = asString(record.model);

  return {
    id,
    // Вид шага определяется тем, какое из двух взаимоисключающих полей есть:
    // в локе `agent` и `run` не встречаются вместе.
    kind: prompt !== undefined ? 'agent' : 'run',
    ...(agent === undefined ? {} : { agent }),
    ...(model === undefined ? {} : { model }),
    ...(prompt === undefined ? {} : { prompt }),
    ...(command === undefined ? {} : { command }),
    context: contextLabels(record.context),
  };
}

function toJob(value: unknown): LockJob | undefined {
  const record = asRecord(value);
  if (record === undefined) return undefined;
  const id = asString(record.id);
  if (id === undefined) return undefined;

  const needsRaw = record.needs;
  const needs =
    needsRaw === 'all'
      ? ['all']
      : Array.isArray(needsRaw)
        ? needsRaw.filter((item): item is string => typeof item === 'string')
        : [];

  const steps = Array.isArray(record.steps)
    ? record.steps.map(toStep).filter((step): step is LockStep => step !== undefined)
    : [];

  const description = asString(record.description);
  const condition = asString(record.if);
  const on = asString(record.on);
  const display = displayMap(record.display);

  return {
    id,
    ...(description === undefined ? {} : { description }),
    needs,
    ...(condition === undefined ? {} : { if: condition }),
    on: on === 'failure' || on === 'always' ? on : 'success',
    publishesOutput: asRecord(record.output) !== undefined,
    ...(display === undefined ? {} : { display }),
    context: contextLabels(record.context),
    steps,
  };
}

/** Работы из лока. Нечитаемый или отсутствующий файл даёт пустой список. */
export function readLockJobs(path: string): LockJob[] {
  let document: unknown;
  try {
    document = parseYaml(readFileSync(path, 'utf8'));
  } catch {
    return [];
  }

  const jobs = asRecord(document)?.jobs;
  if (!Array.isArray(jobs)) return [];
  return jobs.map(toJob).filter((job): job is LockJob => job !== undefined);
}
