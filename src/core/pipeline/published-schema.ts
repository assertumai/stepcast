import { z } from 'zod';
// Тот же валидатор, что проверяет значение предиката при разборе документа
// (`expand.ts`): «пригодна» здесь значит именно «примет ajv при разборе».
import { Ajv2020 } from 'ajv/dist/2020.js';

import { buildDocumentSchemas } from './schema.js';
import { contributionOwner, type Registry } from '../plugins/registry.js';

/**
 * Печать JSON Schema документов пайплайна и работы — общий код для схемы
 * пакета (пустой перечень, `scripts/generate-schema.ts`) и схемы проекта
 * (перечень предикатов действующего реестра, `stepcast schema`). Схема
 * значения печатается вложением в уже напечатанный JSON, а не построением: у
 * `z.toJSONSchema` о JSON Schema плагина знания нет (design.md, решение 2).
 */

/** Плагинный предикат для печати: имя, схема значения и внёсший его плагин. */
export interface PluginPredicateEntry {
  readonly name: string;
  readonly schema: Readonly<Record<string, unknown>>;
  readonly owner: string;
}

/** Схема значения, которую нельзя вложить в документ, — с причиной. */
export interface PublishedSchemaNote {
  readonly predicate: string;
  readonly plugin: string;
  readonly reason: string;
}

export interface PublishedSchemas {
  readonly pipeline: Record<string, unknown>;
  readonly job: Record<string, unknown>;
  readonly notes: readonly PublishedSchemaNote[];
}

const ajv = new Ajv2020({ allErrors: true, strict: false });

/**
 * Ключи, которыми схема перестаёт быть самодостаточной: и прямые ссылки
 * (`$ref`, `$dynamicRef`, `$recursiveRef`), и цели ссылок вместе с базой их
 * разрешения (`$id`, `$anchor`, `$dynamicAnchor`, `$recursiveAnchor`), и
 * объявление диалекта (`$schema`). Автономно такая схема компилируется, а в
 * чужом документе разрешается от другого корня — то есть молча значит не то.
 */
const FORBIDDEN_KEYS = [
  '$ref',
  '$id',
  '$schema',
  '$anchor',
  '$dynamicRef',
  '$dynamicAnchor',
  '$recursiveRef',
  '$recursiveAnchor',
] as const;

/**
 * Ключ, который в схеме значения разрешался бы от чужого корня документа, —
 * на любом уровне, а не только в корне: ссылка на втором уровне ломает ровно
 * так же (design.md, решение 3).
 */
function findForbiddenKey(node: unknown): string | undefined {
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findForbiddenKey(item);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (node === null || typeof node !== 'object') return undefined;
  const obj = node as Record<string, unknown>;
  for (const key of FORBIDDEN_KEYS) {
    if (key in obj) return key;
  }
  for (const value of Object.values(obj)) {
    const found = findForbiddenKey(value);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** Причина, по которой схему значения нельзя вложить, либо ничего — пригодна. */
function unusableReason(schema: Readonly<Record<string, unknown>>): string | undefined {
  const forbidden = findForbiddenKey(schema);
  if (forbidden !== undefined) {
    return `схема значения содержит ${forbidden}, а он разрешался бы от чужого корня документа`;
  }
  try {
    ajv.compile(schema as object);
    return undefined;
  } catch (error) {
    return `схема значения не принимается ajv: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/**
 * Узел-метка плагинного предиката в напечатанном документе (design.md,
 * решение 2): единственное свойство, оно же единственное обязательное, имя —
 * из перечня плагинных предикатов, значение — пустая схема. Совпасть
 * случайно этому узлу не с чем: пустая схема значения печатается только в
 * этой ветви (`z.unknown()` в моделях документа больше нигде не стоит).
 */
function labelName(node: unknown, names: ReadonlySet<string>): string | undefined {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) return undefined;
  const obj = node as Record<string, unknown>;
  if (obj['type'] !== 'object' || obj['additionalProperties'] !== false) return undefined;

  const properties = obj['properties'];
  if (properties === null || typeof properties !== 'object' || Array.isArray(properties)) return undefined;
  const keys = Object.keys(properties as Record<string, unknown>);
  const name = keys.length === 1 ? keys[0] : undefined;
  if (name === undefined || !names.has(name)) return undefined;

  const required = obj['required'];
  if (!Array.isArray(required) || required.length !== 1 || required[0] !== name) return undefined;

  const value = (properties as Record<string, unknown>)[name];
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  if (Object.keys(value).length !== 0) return undefined;

  return name;
}

/** Заменить узлы-метки схемами значений — рекурсивно, во всех точках сразу. */
function inlineValues(node: unknown, names: ReadonlySet<string>, values: ReadonlyMap<string, unknown>): void {
  if (Array.isArray(node)) {
    for (const item of node) inlineValues(item, names, values);
    return;
  }
  if (node === null || typeof node !== 'object') return;

  const name = labelName(node, names);
  if (name !== undefined) {
    // Имени нет в карте — значение остаётся неограниченным: так печатается и
    // предикат с непригодной схемой значения (design.md, решение 3).
    const obj = node as { properties: Record<string, unknown> };
    obj.properties = { ...obj.properties, [name]: values.get(name) ?? {} };
    return;
  }

  for (const value of Object.values(node as Record<string, unknown>)) inlineValues(value, names, values);
}

/** Строка в description корня, называющая отличие от поставляемой схемы. */
function describeExtension(predicates: readonly PluginPredicateEntry[]): string {
  const parts = [...predicates]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((entry) => `${entry.name} (${entry.owner})`);
  return `Проект дополнительно знает предикаты плагинов: ${parts.join(', ')}.`;
}

function printDocument(schema: z.ZodType, title: string): Record<string, unknown> {
  // Тот же вызов и тот же порядок ключей, что в `scripts/generate-schema.ts`:
  // расхождение здесь сделало бы схему пакета и схему проекта разными
  // преобразованиями одного документа (design.md, Context).
  return { title, ...z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) };
}

interface Documents {
  readonly pipeline: Record<string, unknown>;
  readonly job: Record<string, unknown>;
}

/** Напечатать оба документа и вложить в них названные схемы значений. */
function assemble(names: readonly string[], values: ReadonlyMap<string, unknown>): Documents {
  const { PipelineDocumentSchema, JobDocumentSchema } = buildDocumentSchemas(names);
  const pipeline = printDocument(PipelineDocumentSchema, 'stepcast pipeline');
  const job = printDocument(JobDocumentSchema, 'stepcast job');
  if (names.length > 0) {
    const nameSet = new Set(names);
    inlineValues(pipeline, nameSet, values);
    inlineValues(job, nameSet, values);
  }
  return { pipeline, job };
}

/**
 * Причина, по которой собранный документ не компилируется, либо ничего.
 *
 * Пригодности схемы значения самой по себе мало: вложенная в документ, она
 * проверяется ещё раз — целиком, вместе с ним. Схема, которую валидатор не
 * принимает, редактором отвергается вся, и подсказка пропадает не по одному
 * предикату, а по всему документу — ровно та тихая деградация, против которой
 * заведено решение 3 design.md.
 */
function documentReason(documents: Documents): string | undefined {
  // Новый экземпляр на проверку: у общего накапливались бы схемы прошлых
  // сборок, и ошибка одной перетекала бы в другую.
  const validator = new Ajv2020({ allErrors: true, strict: false });
  for (const document of [documents.pipeline, documents.job]) {
    try {
      validator.compile(document);
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }
  return undefined;
}

/**
 * Перечень плагинных предикатов действующего реестра — общий для команды
 * `stepcast schema` и для сверки линта. Две копии этой сборки разошлись бы по
 * любому полю, и линт либо вечно звал бы перегенерировать свежий файл, либо
 * молчал бы о настоящем устаревании.
 */
export function pluginPredicateEntries(registry: Registry): PluginPredicateEntry[] {
  return [...registry.predicates.entries()].map(([name, contribution]) => ({
    name,
    schema: contribution.schema,
    owner: contributionOwner(registry, 'predicates', name) ?? name,
  }));
}

/**
 * Печатает JSON Schema документов пайплайна и работы по перечню плагинных
 * предикатов. Пустой перечень даёт в точности то, что поставляет пакет
 * (design.md, решение 4): фабрика `buildDocumentSchemas` при пустом перечне
 * возвращает встроенный набор без объединения, и подставлять нечего —
 * `description` при этом не заводится вовсе.
 */
export function buildPublishedSchemas(predicates: readonly PluginPredicateEntry[] = []): PublishedSchemas {
  const names = predicates.map((entry) => entry.name);

  if (predicates.length === 0) {
    const { pipeline, job } = assemble(names, new Map());
    return { pipeline, job, notes: [] };
  }

  // Вложена только пригодная схема; имени в карте нет — значение остаётся
  // неограниченным. Невложимая схема не отменяет генерации: ключ предиката
  // всё равно признан (design.md, решение 3).
  const values = new Map<string, unknown>();
  const notes: PublishedSchemaNote[] = [];
  const owner = (name: string): string =>
    predicates.find((entry) => entry.name === name)?.owner ?? name;

  for (const entry of predicates) {
    const reason = unusableReason(entry.schema);
    if (reason === undefined) values.set(entry.name, entry.schema);
    else notes.push({ predicate: entry.name, plugin: entry.owner, reason });
  }

  let documents = assemble(names, values);
  if (documentReason(documents) !== undefined) {
    // Виновника ищем поимённо: одна схема, ломающая сборку, не должна лишать
    // проверки значения все остальные предикаты.
    for (const name of [...values.keys()]) {
      const alone = new Map([[name, values.get(name)]]);
      const reason = documentReason(assemble(names, alone));
      if (reason === undefined) continue;
      values.delete(name);
      notes.push({ predicate: name, plugin: owner(name), reason: `собранная схема документа не компилируется: ${reason}` });
    }
    documents = assemble(names, values);
    const together = documentReason(documents);
    if (together !== undefined) {
      // Порознь каждая вкладывается, вместе — нет: печатаем ключи без формы
      // значения, но печатаем.
      for (const name of [...values.keys()]) {
        values.delete(name);
        notes.push({
          predicate: name,
          plugin: owner(name),
          reason: `собранная схема документа не компилируется, пока вложены схемы значений нескольких предикатов сразу: ${together}`,
        });
      }
      documents = assemble(names, values);
    }
  }

  const description = describeExtension(predicates);
  documents.pipeline['description'] = description;
  documents.job['description'] = description;

  return { pipeline: documents.pipeline, job: documents.job, notes };
}
