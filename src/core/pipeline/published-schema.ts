import { z } from 'zod';
// Тот же валидатор, что проверяет значение предиката при разборе документа
// (`expand.ts`): «пригодна» здесь значит именно «примет ajv при разборе».
import { Ajv2020 } from 'ajv/dist/2020.js';

import { buildDocumentSchemas, DEFAULT_NATIVE_PREDICATES, DEFAULT_NATIVE_STEP_KINDS, isDefaultNativePredicates, isDefaultNativeStepKinds, STEP_COMMON_KEYS } from './schema.js';
import { hasPredicateEvaluator, hasStepExecutor, type PredicateContribution, type StepKindContribution } from '../plugins/contract.js';
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

/**
 * Вид шага для печати: имя, занятые им ключи документа и схема документа —
 * объявленная (`document.schema`) либо синтезированная из имени и `fields`
 * (design.md изменения `step-kind-document-contract`, Решение 1) — и внёсший
 * его плагин.
 */
export interface PluginStepKindEntry {
  readonly name: string;
  readonly keys: readonly string[];
  readonly schema: Readonly<Record<string, unknown>>;
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
 * Узел-метка вида шага (`user-decision-steps`, design.md решение 12;
 * design.md изменения `step-kind-document-contract`, Решение 3): в отличие от
 * предиката, вид шага делит объект с общей частью шага (`id`, `expect`,
 * `timeout`, …) — узел опознаётся не единственным лишним свойством, а набором
 * свойств *сверх* общей части, совпадающим (без учёта порядка) с занятыми
 * ключами ровно одного вида из перечня, — каждое такое свойство несёт пустую
 * схему.
 */
function stepKindLabelName(node: unknown, keysByName: ReadonlyMap<string, readonly string[]>): string | undefined {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) return undefined;
  const obj = node as Record<string, unknown>;
  if (obj['type'] !== 'object' || obj['additionalProperties'] !== false) return undefined;

  const properties = obj['properties'];
  if (properties === null || typeof properties !== 'object' || Array.isArray(properties)) return undefined;
  const propsRecord = properties as Record<string, unknown>;
  const commonKeys = new Set<string>(STEP_COMMON_KEYS);
  const extra = new Set(Object.keys(propsRecord).filter((key) => !commonKeys.has(key)));
  if (extra.size === 0) return undefined;

  const isEmptySchema = (key: string): boolean => {
    const value = propsRecord[key];
    return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0;
  };

  for (const [name, keys] of keysByName) {
    if (keys.length !== extra.size || !keys.every((key) => extra.has(key))) continue;
    if (!keys.every(isEmptySchema)) continue;
    return name;
  }
  return undefined;
}

/** Заменить узлы-метки схемами значений и полей — рекурсивно, во всех точках сразу. */
function inlineValues(
  node: unknown,
  predicateNames: ReadonlySet<string>,
  predicateValues: ReadonlyMap<string, unknown>,
  stepKindKeysByName: ReadonlyMap<string, readonly string[]>,
  stepKindValues: ReadonlyMap<string, StepKindOverlay>,
): void {
  if (Array.isArray(node)) {
    for (const item of node) inlineValues(item, predicateNames, predicateValues, stepKindKeysByName, stepKindValues);
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

  const stepName = stepKindLabelName(node, stepKindKeysByName);
  if (stepName !== undefined) {
    // Имени нет в карте — все ключи вида остаются неограниченными, тем же
    // правилом, что и у непригодной схемы предиката.
    const overlay = stepKindValues.get(stepName);
    if (overlay === undefined) return;

    const obj = node as { properties: Record<string, unknown>; required?: unknown; allOf?: unknown };
    obj.properties = { ...obj.properties, ...overlay.properties };
    if (overlay.required.length > 0) {
      // Узел уже требует один из занятых ключей — тот, которым собрана эта
      // ветвь объединения (`PluginStepSchema`); схема документа добавляет к
      // нему остальные обязательные, не трогая общую часть шага.
      const current = Array.isArray(obj.required) ? (obj.required as readonly unknown[]) : [];
      obj.required = [...current, ...overlay.required.filter((key) => !current.includes(key))];
    }
    if (overlay.rest !== undefined) {
      const current = Array.isArray(obj.allOf) ? (obj.allOf as readonly unknown[]) : [];
      obj.allOf = [...current, overlay.rest];
    }
    return;
  }

  for (const value of Object.values(node as Record<string, unknown>)) {
    inlineValues(value, predicateNames, predicateValues, stepKindKeysByName, stepKindValues);
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
  stepKinds: readonly { readonly name: string; readonly keys: readonly string[] }[],
  stepKindValues: ReadonlyMap<string, StepKindOverlay>,
  nativeStepKinds: readonly string[],
  nativePredicates: readonly string[],
): Documents {
  const { PipelineDocumentSchema, JobDocumentSchema } = buildDocumentSchemas(predicateNames, stepKinds, nativeStepKinds, nativePredicates);
  const pipeline = printDocument(PipelineDocumentSchema, 'stepcast pipeline');
  const job = printDocument(JobDocumentSchema, 'stepcast job');
  if (predicateNames.length > 0 || stepKinds.length > 0) {
    const predicateNameSet = new Set(predicateNames);
    const stepKindKeysByName = new Map(stepKinds.map((kind) => [kind.name, kind.keys]));
    inlineValues(pipeline, predicateNameSet, predicateValues, stepKindKeysByName, stepKindValues);
    inlineValues(job, predicateNameSet, predicateValues, stepKindKeysByName, stepKindValues);
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
  return [...registry.predicates.entries()]
    .filter((entry): entry is [string, PredicateContribution] => hasPredicateEvaluator(entry[1]))
    .map(([name, contribution]) => ({
      name,
      schema: contribution.schema,
      owner: contributionOwner(registry, 'predicates', name) ?? name,
    }));
}

/**
 * Перечень видов шага действующего реестра, приносящих свою ветвь схемы
 * документа, — общий для команды `stepcast schema` и для сверки линта, тем же
 * образцом, что и `pluginPredicateEntries`. Виды с внутренней формой (`agent`,
 * `run`, `script`, `uses`) уже описаны публикуемой схемой напрямую и сюда не
 * попадают — `hasStepExecutor` спрашивает именно это, а не происхождение
 * вклада (design.md изменения `step-kind-document-contract`, Решение 4):
 * `decision`, внесённый встроенной строкой дерева, виден здесь наравне с
 * плагинным, потому что у него есть `execute`, — печать это не портит,
 * вложенная схема его формы ровно то, что нужно поставляемой схеме пакета
 * (design.md, решение 12).
 */
export function pluginStepKindEntries(registry: Registry): PluginStepKindEntry[] {
  return [...registry.steps.entries()]
    .filter((entry): entry is [string, StepKindContribution] => hasStepExecutor(entry[1]))
    .map(([name, contribution]) => {
      const owner = contributionOwner(registry, 'steps', name) ?? name;
      const keys = contribution.document?.keys ?? [name];
      const schema =
        contribution.document?.schema ?? { properties: { [name]: contribution.fields }, required: [name] };
      return {
        name,
        keys,
        schema,
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
 * Ключи схемы документа, описывающие **состав** ключей объекта. В узле-метке
 * они значили бы другое: узел — это весь шаг, и рядом с ключами вида в нём
 * лежит общая часть (`id`, `expect`, `timeout`, …), которой схема вклада не
 * знает и знать не обязана. `patternProperties`, `propertyNames` и счётчики
 * свойств поэтому отбрасываются с названной причиной (`notes`).
 */
const KEY_SET_KEYWORDS = ['patternProperties', 'propertyNames', 'minProperties', 'maxProperties'] as const;

/**
 * Что вкладывается в узел-метку вида шага: подсхемы занятых ключей, их
 * обязательность и остаток схемы документа целиком.
 */
interface StepKindOverlay {
  /** Подсхема каждого занятого ключа из `document.schema.properties`. */
  readonly properties: Readonly<Record<string, unknown>>;
  /** Занятые ключи, объявленные схемой документа обязательными. */
  readonly required: readonly string[];
  /** Остаток схемы документа — уходит в узел отдельным членом `allOf`. */
  readonly rest?: Readonly<Record<string, unknown>>;
}

function plainObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Разложить схему документа вклада на вложимое в узел-метку и отброшенное.
 *
 * `properties` и `required` переносятся в сам узел — по занятым ключам: так
 * ветвь синтезированной формы (`fields`) печатается ровно тем же, чем
 * печаталась всегда. Всё остальное содержание схемы — `oneOf`, `if`/`then`,
 * `dependentRequired` и любые другие применители — переносится целиком одним
 * членом `allOf`: терять его молча значило бы печатать схему, которая не
 * ограничивает ничего, не назвав ни одной причины.
 *
 * Отбрасываются двое: `type: object` и `additionalProperties` /
 * `unevaluatedProperties` — узел и так объект, чей состав ключей закрыт
 * строже (общая часть шага плюс занятые ключи, `additionalProperties: false`),
 * так что вместе с ними не теряется ничего, — и ключи состава
 * (`KEY_SET_KEYWORDS`), которые в узле увидели бы общую часть шага; вот они
 * называются причиной в `notes`.
 */
function stepKindOverlay(entry: PluginStepKindEntry): {
  readonly overlay: StepKindOverlay;
  readonly dropped: readonly string[];
} {
  const schema = entry.schema as Record<string, unknown>;
  const declared = new Set(entry.keys);
  const propsRecord = plainObject(schema['properties']) ?? {};
  const properties = Object.fromEntries(entry.keys.map((key) => [key, propsRecord[key] ?? {}]));
  const required = Array.isArray(schema['required'])
    ? (schema['required'] as readonly unknown[]).filter(
        (key): key is string => typeof key === 'string' && declared.has(key),
      )
    : [];
  const dropped = KEY_SET_KEYWORDS.filter((keyword) => keyword in schema);
  const silent = new Set<string>(['properties', 'required', 'additionalProperties', 'unevaluatedProperties']);
  const rest = Object.fromEntries(
    Object.entries(schema).filter(
      ([key, value]) =>
        !silent.has(key) &&
        !(dropped as readonly string[]).includes(key) &&
        !(key === 'type' && value === 'object'),
    ),
  );
  return {
    overlay: { properties, required, ...(Object.keys(rest).length === 0 ? {} : { rest }) },
    dropped,
  };
}

/**
 * Печатает JSON Schema документов пайплайна и работы по перечню плагинных
 * предикатов и видов шага, а также по составу видов и предикатов внутренней
 * формы (`builtin-step-kinds-as-rows`, design.md, Решение 7;
 * `builtin-predicates-as-row`, design.md, Решение 4) — тем же третьим и
 * четвёртым параметром, что и `buildDocumentSchemas`, с теми же умолчаниями:
 * оба в каноническом порядке. Четыре пустых/дефолтных аргумента дают в
 * точности то, что поставляет пакет (design.md, решение 4): фабрика
 * `buildDocumentSchemas` без имён возвращает встроенный набор без
 * объединения, и подставлять нечего — `description` при этом не заводится
 * вовсе.
 */
export function buildPublishedSchemas(
  predicates: readonly PluginPredicateEntry[] = [],
  stepKinds: readonly PluginStepKindEntry[] = [],
  nativeStepKinds: readonly string[] = DEFAULT_NATIVE_STEP_KINDS,
  nativePredicates: readonly string[] = DEFAULT_NATIVE_PREDICATES,
): PublishedSchemas {
  const predicateNames = predicates.map((entry) => entry.name);
  const stepKindDescriptors = stepKinds.map((entry) => ({ name: entry.name, keys: entry.keys }));

  if (
    predicates.length === 0 &&
    stepKinds.length === 0 &&
    isDefaultNativeStepKinds(nativeStepKinds) &&
    isDefaultNativePredicates(nativePredicates)
  ) {
    const { pipeline, job } = assemble([], new Map(), [], new Map(), nativeStepKinds, nativePredicates);
    return { pipeline, job, notes: [] };
  }

  // Вложена только пригодная схема; имени в карте нет — значение остаётся
  // неограниченным. Невложимая схема не отменяет генерации: ключи вида шага
  // всё равно признаны (design.md, решение 3).
  const predicateValues = new Map<string, unknown>();
  const stepKindValues = new Map<string, StepKindOverlay>();
  const notes: PublishedSchemaNote[] = [];
  const predicateOwner = (name: string): string => predicates.find((entry) => entry.name === name)?.owner ?? name;
  const stepKindOwner = (name: string): string => stepKinds.find((entry) => entry.name === name)?.owner ?? name;

  for (const entry of predicates) {
    const reason = unusableReason(entry.schema);
    if (reason === undefined) predicateValues.set(entry.name, entry.schema);
    else notes.push({ kind: 'predicate', name: entry.name, plugin: entry.owner, reason });
  }
  for (const entry of stepKinds) {
    const reason = unusableReason(entry.schema);
    if (reason !== undefined) {
      notes.push({ kind: 'step_kind', name: entry.name, plugin: entry.owner, reason });
      continue;
    }
    const { overlay, dropped } = stepKindOverlay(entry);
    stepKindValues.set(entry.name, overlay);
    if (dropped.length > 0) {
      notes.push({
        kind: 'step_kind',
        name: entry.name,
        plugin: entry.owner,
        reason: `схема документа вложена без ${dropped.join(', ')}: рядом с ключами вида в шаге лежит общая часть (id, expect, timeout, …), и там эти ключи значили бы другое`,
      });
    }
  }

  const assembleWith = (
    predicateSet: ReadonlyMap<string, unknown>,
    stepKindSet: ReadonlyMap<string, StepKindOverlay>,
  ): Documents => assemble(predicateNames, predicateSet, stepKindDescriptors, stepKindSet, nativeStepKinds, nativePredicates);

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
      const alone = new Map([[name, stepKindValues.get(name)!]]);
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
