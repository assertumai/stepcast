import { z } from 'zod';
// Тот же валидатор, что проверяет значение предиката при разборе документа
// (`expand.ts`): «пригодна» здесь значит именно «примет ajv при разборе».
import { Ajv2020 } from 'ajv/dist/2020.js';

import { buildDocumentSchemas, STEP_COMMON_KEYS } from './schema.js';
import { isBuiltinStepKind, type StepKindContribution } from '../plugins/contract.js';
import { BUILTIN_OWNER } from '../plugins/kernel.js';
import { contributionOwner, type Registry } from '../plugins/registry.js';

/**
 * Печать JSON Schema документов пайплайна и работы — общий код для схемы
 * пакета (пустой перечень, `scripts/generate-schema.ts`) и схемы проекта
 * (перечень предикатов и видов шага действующего реестра, `stepcast schema`).
 * Схема значения печатается вложением в уже напечатанный JSON, а не
 * построением: у `z.toJSONSchema` о JSON Schema плагина знания нет
 * (design.md, решение 2). Ветвь вида шага (`user-decision-steps`, design.md
 * решение 12) вкладывается тем же приёмом узла-метки, каким вкладывается
 * схема значения предиката, — отличие только в форме узла: у предиката это
 * единственное свойство, у шага — своё имя рядом с общей частью шага.
 */

/** Плагинный предикат для печати: имя, схема значения и внёсший его плагин. */
export interface PluginPredicateEntry {
  readonly name: string;
  readonly schema: Readonly<Record<string, unknown>>;
  readonly owner: string;
}

/** Плагинный вид шага для печати: имя, JSON Schema полей и внёсший его плагин. */
export interface PluginStepKindEntry {
  readonly name: string;
  readonly fields: Readonly<Record<string, unknown>>;
  readonly owner: string;
  /**
   * Вид, внесённый встроенной строкой дерева (`decision`): печатается он так
   * же, как плагинный, но отличием проекта от поставляемой схемы не является —
   * поставляемая схема его уже знает. Иначе строка «Проект дополнительно
   * знает…» стояла бы в самой поставляемой схеме, называя её отличием от себя.
   */
  readonly builtin?: boolean;
}

/** Схема значения, которую нельзя вложить в документ, — с причиной. */
export interface PublishedSchemaNote {
  /** Различает предикат и вид шага — оба вкладываются одним и тем же приёмом узла-метки. */
  readonly kind: 'predicate' | 'step_kind';
  readonly name: string;
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
function predicateLabelName(node: unknown, names: ReadonlySet<string>): string | undefined {
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

/**
 * Узел-метка плагинного вида шага (`user-decision-steps`, design.md решение
 * 12): в отличие от предиката, вид шага делит объект с общей частью шага
 * (`id`, `expect`, `timeout`, …) — узел опознаётся не единственным свойством,
 * а ровно одним свойством *сверх* общей части, чьё имя — из перечня видов
 * шага и чья схема пуста.
 */
function stepKindLabelName(node: unknown, names: ReadonlySet<string>): string | undefined {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) return undefined;
  const obj = node as Record<string, unknown>;
  if (obj['type'] !== 'object' || obj['additionalProperties'] !== false) return undefined;

  const properties = obj['properties'];
  if (properties === null || typeof properties !== 'object' || Array.isArray(properties)) return undefined;
  const commonKeys = new Set<string>(STEP_COMMON_KEYS);
  const extra = Object.keys(properties as Record<string, unknown>).filter((key) => !commonKeys.has(key));
  const name = extra.length === 1 ? extra[0] : undefined;
  if (name === undefined || !names.has(name)) return undefined;

  const value = (properties as Record<string, unknown>)[name];
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  if (Object.keys(value).length !== 0) return undefined;

  return name;
}

/** Заменить узлы-метки схемами значений и полей — рекурсивно, во всех точках сразу. */
function inlineValues(
  node: unknown,
  predicateNames: ReadonlySet<string>,
  predicateValues: ReadonlyMap<string, unknown>,
  stepKindNames: ReadonlySet<string>,
  stepKindValues: ReadonlyMap<string, unknown>,
): void {
  if (Array.isArray(node)) {
    for (const item of node) inlineValues(item, predicateNames, predicateValues, stepKindNames, stepKindValues);
    return;
  }
  if (node === null || typeof node !== 'object') return;

  const predicateName = predicateLabelName(node, predicateNames);
  if (predicateName !== undefined) {
    // Имени нет в карте — значение остаётся неограниченным: так печатается и
    // предикат с непригодной схемой значения (design.md, решение 3).
    const obj = node as { properties: Record<string, unknown> };
    obj.properties = { ...obj.properties, [predicateName]: predicateValues.get(predicateName) ?? {} };
    return;
  }

  const stepName = stepKindLabelName(node, stepKindNames);
  if (stepName !== undefined) {
    const obj = node as { properties: Record<string, unknown> };
    obj.properties = { ...obj.properties, [stepName]: stepKindValues.get(stepName) ?? {} };
    return;
  }

  for (const value of Object.values(node as Record<string, unknown>)) {
    inlineValues(value, predicateNames, predicateValues, stepKindNames, stepKindValues);
  }
}

/**
 * Строка в description корня, называющая отличие от поставляемой схемы, либо
 * ничего, если отличия нет. Виды шага встроенных строк дерева отличием не
 * считаются: они есть и в поставляемой схеме, и назвать их значило бы написать
 * в поставляемой схеме, чем она отличается от себя самой.
 */
function describeExtension(
  predicates: readonly PluginPredicateEntry[],
  stepKinds: readonly PluginStepKindEntry[],
): string | undefined {
  const parts: string[] = [];
  if (predicates.length > 0) {
    const list = [...predicates]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((entry) => `${entry.name} (${entry.owner})`);
    parts.push(`предикаты плагинов: ${list.join(', ')}`);
  }
  const fromPlugins = stepKinds.filter((entry) => entry.builtin !== true);
  if (fromPlugins.length > 0) {
    const list = [...fromPlugins]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((entry) => `${entry.name} (${entry.owner})`);
    parts.push(`виды шага плагинов: ${list.join(', ')}`);
  }
  if (parts.length === 0) return undefined;
  return `Проект дополнительно знает ${parts.join('; ')}.`;
}

function printDocument(schema: z.ZodType, title: string): Record<string, unknown> {
  // Тот же вызов и тот же порядок ключей, что в `scripts/generate-schema.ts`:
  // расхождение здесь сделало бы схему пакета и схему проекта разными
  // преобразованиями одного документа (design.md, Context).
  const printed = { title, ...z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) };
  if (title === 'stepcast pipeline') {
    printed['allOf'] = [
      {
        if: {
          required: ['workspace'],
          properties: {
            workspace: {
              anyOf: [
                { required: ['source'] },
                { required: ['preserve_local_changes'] },
                { required: ['live_files'] },
              ],
            },
          },
        },
        then: {
          properties: {
            workspace: { properties: { mode: { const: 'worktree' } } },
            jobs: {
              additionalProperties: {
                properties: { workspace: { properties: { mode: { const: 'worktree' } } } },
              },
            },
          },
        },
      },
      {
        if: {
          required: ['workspace'],
          properties: { workspace: { required: ['live_files'] } },
        },
        then: {
          properties: {
            workspace: {
              required: ['preserve_local_changes'],
              properties: { preserve_local_changes: { const: true } },
            },
          },
        },
      },
    ];
  }
  return printed;
}

interface Documents {
  readonly pipeline: Record<string, unknown>;
  readonly job: Record<string, unknown>;
}

/** Напечатать оба документа и вложить в них названные схемы значений и полей. */
function assemble(
  predicateNames: readonly string[],
  predicateValues: ReadonlyMap<string, unknown>,
  stepKindNames: readonly string[],
  stepKindValues: ReadonlyMap<string, unknown>,
): Documents {
  const { PipelineDocumentSchema, JobDocumentSchema } = buildDocumentSchemas(predicateNames, stepKindNames);
  const pipeline = printDocument(PipelineDocumentSchema, 'stepcast pipeline');
  const job = printDocument(JobDocumentSchema, 'stepcast job');
  if (predicateNames.length > 0 || stepKindNames.length > 0) {
    const predicateNameSet = new Set(predicateNames);
    const stepKindNameSet = new Set(stepKindNames);
    inlineValues(pipeline, predicateNameSet, predicateValues, stepKindNameSet, stepKindValues);
    inlineValues(job, predicateNameSet, predicateValues, stepKindNameSet, stepKindValues);
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
 * Перечень плагинных (не встроенных) видов шага действующего реестра — общий
 * для команды `stepcast schema` и для сверки линта, тем же образцом, что и
 * `pluginPredicateEntries`. Встроенные виды (`agent`, `run`, `script`,
 * `uses`, `decision`) уже описаны публикуемой схемой напрямую и сюда не
 * попадают — `isBuiltinStepKind` отличает форму `document` от настоящего
 * вклада, но не отличает встроенную СТРОКУ от плагинной: `decision` формой
 * `document` не обладает и потому виден здесь как обычный плагинный вид.
 * Печать это не портит — вложенная схема его полей ровно то, что нужно
 * поставляемой схеме пакета (design.md, решение 12).
 */
export function pluginStepKindEntries(registry: Registry): PluginStepKindEntry[] {
  return [...registry.steps.entries()]
    .filter((entry): entry is [string, StepKindContribution] => !isBuiltinStepKind(entry[1]))
    .map(([name, contribution]) => {
      const owner = contributionOwner(registry, 'steps', name) ?? name;
      return {
        name,
        fields: contribution.fields,
        owner,
        // Вклад встроенной строки дерева внесён на корневой области ядра и
        // потому числится за «встроенным» владельцем (`kernel.ts`): печатается
        // он наравне с плагинным, но отличием проекта от поставляемой схемы не
        // считается — та его уже знает.
        ...(owner === BUILTIN_OWNER ? { builtin: true } : {}),
      };
    });
}

/**
 * Печатает JSON Schema документов пайплайна и работы по перечню плагинных
 * предикатов и видов шага. Оба перечня пустые дают в точности то, что
 * поставляет пакет (design.md, решение 4): фабрика `buildDocumentSchemas` без
 * имён возвращает встроенный набор без объединения, и подставлять нечего —
 * `description` при этом не заводится вовсе.
 */
export function buildPublishedSchemas(
  predicates: readonly PluginPredicateEntry[] = [],
  stepKinds: readonly PluginStepKindEntry[] = [],
): PublishedSchemas {
  const predicateNames = predicates.map((entry) => entry.name);
  const stepKindNames = stepKinds.map((entry) => entry.name);

  if (predicates.length === 0 && stepKinds.length === 0) {
    const { pipeline, job } = assemble([], new Map(), [], new Map());
    return { pipeline, job, notes: [] };
  }

  // Вложена только пригодная схема; имени в карте нет — значение остаётся
  // неограниченным. Невложимая схема не отменяет генерации: ключ предиката
  // или вида шага всё равно признан (design.md, решение 3).
  const predicateValues = new Map<string, unknown>();
  const stepKindValues = new Map<string, unknown>();
  const notes: PublishedSchemaNote[] = [];
  const predicateOwner = (name: string): string => predicates.find((entry) => entry.name === name)?.owner ?? name;
  const stepKindOwner = (name: string): string => stepKinds.find((entry) => entry.name === name)?.owner ?? name;

  for (const entry of predicates) {
    const reason = unusableReason(entry.schema);
    if (reason === undefined) predicateValues.set(entry.name, entry.schema);
    else notes.push({ kind: 'predicate', name: entry.name, plugin: entry.owner, reason });
  }
  for (const entry of stepKinds) {
    const reason = unusableReason(entry.fields);
    if (reason === undefined) stepKindValues.set(entry.name, entry.fields);
    else notes.push({ kind: 'step_kind', name: entry.name, plugin: entry.owner, reason });
  }

  const assembleWith = (predicateSet: ReadonlyMap<string, unknown>, stepKindSet: ReadonlyMap<string, unknown>): Documents =>
    assemble(predicateNames, predicateSet, stepKindNames, stepKindSet);

  let documents = assembleWith(predicateValues, stepKindValues);
  if (documentReason(documents) !== undefined) {
    // Виновника ищем поимённо: одна схема, ломающая сборку, не должна лишать
    // проверки значения все остальные предикаты и виды шага.
    for (const name of [...predicateValues.keys()]) {
      const alone = new Map([[name, predicateValues.get(name)]]);
      const reason = documentReason(assembleWith(alone, new Map()));
      if (reason === undefined) continue;
      predicateValues.delete(name);
      notes.push({
        kind: 'predicate',
        name,
        plugin: predicateOwner(name),
        reason: `собранная схема документа не компилируется: ${reason}`,
      });
    }
    for (const name of [...stepKindValues.keys()]) {
      const alone = new Map([[name, stepKindValues.get(name)]]);
      const reason = documentReason(assembleWith(new Map(), alone));
      if (reason === undefined) continue;
      stepKindValues.delete(name);
      notes.push({
        kind: 'step_kind',
        name,
        plugin: stepKindOwner(name),
        reason: `собранная схема документа не компилируется: ${reason}`,
      });
    }

    documents = assembleWith(predicateValues, stepKindValues);
    const together = documentReason(documents);
    if (together !== undefined) {
      // Порознь каждая вкладывается, вместе — нет: печатаем ключи без формы
      // значения/полей, но печатаем.
      for (const name of [...predicateValues.keys()]) {
        predicateValues.delete(name);
        notes.push({
          kind: 'predicate',
          name,
          plugin: predicateOwner(name),
          reason: `собранная схема документа не компилируется, пока вложены схемы значений нескольких предикатов и видов шага сразу: ${together}`,
        });
      }
      for (const name of [...stepKindValues.keys()]) {
        stepKindValues.delete(name);
        notes.push({
          kind: 'step_kind',
          name,
          plugin: stepKindOwner(name),
          reason: `собранная схема документа не компилируется, пока вложены схемы значений нескольких предикатов и видов шага сразу: ${together}`,
        });
      }
      documents = assembleWith(predicateValues, stepKindValues);
    }
  }

  const description = describeExtension(predicates, stepKinds);
  if (description !== undefined) {
    documents.pipeline['description'] = description;
    documents.job['description'] = description;
  }

  return { pipeline: documents.pipeline, job: documents.job, notes };
}
