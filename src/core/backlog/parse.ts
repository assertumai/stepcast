import { StepcastError } from '../errors.js';
import { BACKLOG_STATUSES, BacklogItemSchema, type BacklogItem, type BacklogRecord } from './schema.js';

/**
 * Разбор текста очереди в пункты — без ввода-вывода: на входе строка, на
 * выходе значения. Заголовок второго уровня начинает пункт, всё до первого
 * заголовка — преамбула и разбору не подлежит; пустые строки внутри пункта
 * пропускаются, прочие разбираются как «ключ: значение».
 */

const HEADING = /^##\s+(.+?)\s*$/;
const FIELD = /^([a-z][a-z0-9_]*):\s*(.*)$/;
/** Огораживание блока кода — по правилам Markdown: ``` либо ~~~, до трёх пробелов отступа. */
const FENCE = /^ {0,3}(?:```|~~~)/;

export interface BacklogFieldPosition {
  /** Номер строки в тексте, с нуля. */
  readonly line: number;
  readonly value: string;
}

export interface BacklogEntry {
  readonly slug: string;
  readonly headingLine: number;
  /** Строка последнего поля пункта — новое поле дописывается сразу за ней. */
  readonly lastFieldLine: number;
  readonly fields: ReadonlyMap<string, BacklogFieldPosition>;
  /** Поля пункта, проверенные схемой. */
  readonly data: BacklogItem;
}

interface RawEntry {
  slug: string;
  headingLine: number;
  lastFieldLine: number;
  fields: Map<string, BacklogFieldPosition>;
}

export function parse(text: string): readonly BacklogEntry[] {
  const lines = text.split('\n');
  const raw: RawEntry[] = [];
  let current: RawEntry | undefined;
  let fenced = false;

  for (const [index, line] of lines.entries()) {
    // Огороженный блок кода в преамбуле не разбирается вовсе: пример пункта,
    // приведённый во вводном тексте очереди (`docs/backlog.md` показывает
    // ровно такой), не имеет права стать пунктом. Внутри пункта огораживание
    // не отслеживается — полям там места нет, и строка, не разбираемая как
    // поле, остаётся отказом.
    if (current === undefined) {
      if (FENCE.test(line)) {
        fenced = !fenced;
        continue;
      }
      if (fenced) continue;
    }

    const heading = HEADING.exec(line);
    if (heading !== null) {
      const slug = heading[1] as string;
      if (raw.some((entry) => entry.slug === slug)) {
        throw new StepcastError(`пункт «${slug}» встречается дважды`, { at: slug });
      }
      current = { slug, headingLine: index, lastFieldLine: index, fields: new Map() };
      raw.push(current);
      continue;
    }

    if (current === undefined || line.trim() === '') continue;

    const field = FIELD.exec(line);
    if (field === null) {
      throw new StepcastError(
        `пункт «${current.slug}», строка ${index + 1}: ожидалось поле вида «ключ: значение»`,
        { at: current.slug },
      );
    }
    current.fields.set(field[1] as string, { line: index, value: (field[2] as string).trim() });
    current.lastFieldLine = index;
  }

  return raw.map(toEntry);
}

function toEntry(raw: RawEntry): BacklogEntry {
  const candidate: Record<string, unknown> = { slug: raw.slug };
  for (const [name, position] of raw.fields) candidate[name] = position.value;

  const parsed = BacklogItemSchema.safeParse(candidate);
  if (!parsed.success) {
    throw describeFailure(raw, candidate, parsed.error.issues[0]);
  }

  return {
    slug: raw.slug,
    headingLine: raw.headingLine,
    lastFieldLine: raw.lastFieldLine,
    fields: raw.fields,
    data: parsed.data,
  };
}

/** Достаточно от issue безопасного разбора zod, чтобы не тянуть его внутренний тип. */
interface SchemaIssue {
  readonly path: readonly PropertyKey[];
  readonly code: string;
  readonly message: string;
}

/**
 * Диагностика первой ошибки схемы: слаг пункта, причина и, где позиция
 * известна (поле разобрано на конкретной строке), — номер строки.
 */
function describeFailure(
  raw: RawEntry,
  candidate: Record<string, unknown>,
  issue: SchemaIssue | undefined,
): StepcastError {
  if (issue === undefined) {
    return new StepcastError(`пункт «${raw.slug}» не соответствует формату очереди`, { at: raw.slug });
  }

  const field = typeof issue.path[0] === 'string' ? issue.path[0] : undefined;

  if (field === 'slug') {
    return new StepcastError(
      `заголовок «${raw.slug}» не является слагом в kebab-case: очередь состоит только из пунктов`,
      { at: raw.slug },
    );
  }

  const line = field === undefined ? undefined : raw.fields.get(field)?.line;
  const suffix = line === undefined ? '' : ` (строка ${line + 1})`;

  if (issue.code === 'invalid_type') {
    return new StepcastError(
      `пункт «${raw.slug}»: отсутствует обязательное поле «${String(field)}»${suffix}`,
      { at: raw.slug },
    );
  }

  if (field === 'status') {
    return new StepcastError(
      `пункт «${raw.slug}»: неизвестный status «${String(candidate.status)}», ожидался один из ${BACKLOG_STATUSES.join(', ')}${suffix}`,
      { at: raw.slug },
    );
  }

  if (field === 'track') {
    return new StepcastError(
      `пункт «${raw.slug}»: вес «${String(candidate.track)}» не является слагом в kebab-case${suffix}`,
      { at: raw.slug },
    );
  }

  if (field === 'group') {
    return new StepcastError(
      `пункт «${raw.slug}»: группа «${String(candidate.group)}» не является слагом в kebab-case${suffix}`,
      { at: raw.slug },
    );
  }

  return new StepcastError(`пункт «${raw.slug}»: поле «${String(field)}» некорректно: ${issue.message}${suffix}`, {
    at: raw.slug,
  });
}

/** Действующая группа пункта: объявленное значение `group` либо слаг пункта. */
export function effectiveGroup(entry: BacklogEntry): string {
  return entry.data.group ?? entry.slug;
}

/** Публикуемая запись пункта — форма, которую видят `list` и `pick`. */
export function toRecord(entry: BacklogEntry): BacklogRecord {
  return {
    slug: entry.slug,
    title: entry.data.title,
    why: entry.data.why,
    done_when: entry.data.done_when,
    group: effectiveGroup(entry),
    // Пункт без поля — пустая метка: словаря весов у очереди нет, см.
    // BacklogTrackSchema.
    track: entry.data.track ?? '',
    // Поле repos уже разобрано схемой (RepoListSchema) в перечень имён;
    // отсутствие поля — пустой перечень, то есть корень дерева.
    repos: entry.data.repos ?? [],
  };
}
