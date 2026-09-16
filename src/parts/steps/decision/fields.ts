import { parseDuration } from '../../../plugin.js';
import type { DecisionEffect, DecisionOutcome, LintSite, PluginDiagnostic } from '../../../plugin.js';

/**
 * Поля вида шага `decision` (design.md изменения `user-decision-steps`,
 * решения 1, 6, 7): вопрос, допустимые исходы, необязательный срок и исход по
 * истечении. Написан только импортами из `stepcast/plugin`, соседей этого
 * каталога и встроенных модулей Node — та же дистанция, что у плагина Codex.
 */

/** Форма одного исхода в документе: короткая (имя эффекта) либо полная (эффект и подпись). */
export type RawOutcome = DecisionEffect | { readonly effect: DecisionEffect; readonly label?: string };

export interface DecisionFields {
  readonly prompt: string;
  readonly outcomes: Readonly<Record<string, RawOutcome>>;
  readonly deadline?: string;
  readonly on_expire?: string;
}

/** Закрытый набор эффектов — тот же, что у движка (`DecisionEffect`). */
export const EFFECTS: readonly DecisionEffect[] = ['continue', 'reject', 'restart'];

const EFFECT_SCHEMA = { type: 'string', enum: [...EFFECTS] };

/** JSON Schema полей — та же поверхность, что у любого плагинного вида шага. */
export const DECISION_FIELDS_SCHEMA: Readonly<Record<string, unknown>> = {
  type: 'object',
  properties: {
    prompt: { type: 'string', description: 'Вопрос, показываемый человеку' },
    outcomes: {
      type: 'object',
      description: 'Допустимые исходы: имя → эффект (continue|reject|restart) либо { effect, label }',
      additionalProperties: {
        oneOf: [
          EFFECT_SCHEMA,
          {
            type: 'object',
            properties: { effect: EFFECT_SCHEMA, label: { type: 'string' } },
            required: ['effect'],
            additionalProperties: false,
          },
        ],
      },
    },
    deadline: { type: 'string', description: 'Срок ожидания длительностью, например 4h — считается от начала ожидания' },
    on_expire: { type: 'string', description: 'Исход по истечении срока — имя из outcomes, не restart' },
  },
  required: ['prompt', 'outcomes'],
  additionalProperties: false,
};

/** Схема структурированного выхода — движок проверяет ей `outcome.structured`. */
export const DECISION_OUTPUT_SCHEMA: Readonly<Record<string, unknown>> = {
  type: 'object',
  properties: {
    outcome: { type: 'string' },
    effect: EFFECT_SCHEMA,
    by: { type: 'string', enum: ['user', 'deadline'] },
    reason: { type: 'string' },
    restart_from: { type: 'string' },
  },
  required: ['outcome', 'effect', 'by'],
  additionalProperties: false,
};

/** Нормализовать исход к полной форме — короткая запись эффектом-строкой равна `{ effect }` без подписи. */
export function normalizeOutcome(raw: RawOutcome): DecisionOutcome {
  return typeof raw === 'string' ? { effect: raw } : raw;
}

/** Все исходы поля в нормализованной форме, по имени. */
export function normalizedOutcomes(fields: DecisionFields): Readonly<Record<string, DecisionOutcome>> {
  return Object.fromEntries(
    Object.entries(fields.outcomes).map(([name, raw]) => [name, normalizeOutcome(raw)]),
  );
}

/**
 * Статическая проверка объявления (design.md, решение 7): пустой перечень
 * исходов, исход с эффектом вне закрытого набора, негодная длительность срока,
 * исход по истечении срока вне объявленного перечня, исход по истечении
 * `restart` (крутил бы прогон по кругу без человека) и срок без объявленного
 * исхода по истечении.
 *
 * Проверки повторяют то, что схема полей уже описывает формой (эффект,
 * длительность): схема отказывает при разборе документа, а хук — там же, но
 * своим текстом, называющим шаг и исход; главное же, что оба отказа случаются
 * до захода, а не посреди прогона. Разбор срока — единственный способ
 * поймать `4hh` заранее: в исполнителе он упал бы исключением после того, как
 * все вышележащие работы уже исполнены.
 */
export function lintDecisionFields(fields: unknown, site: LintSite): readonly PluginDiagnostic[] {
  if (typeof fields !== 'object' || fields === null) return [];
  const value = fields as Partial<DecisionFields>;
  const diagnostics: PluginDiagnostic[] = [];

  const outcomeNames = Object.keys(value.outcomes ?? {});
  if (outcomeNames.length === 0) {
    diagnostics.push({
      severity: 'error',
      message: `Шаг decision (${site.at}) объявляет пустой перечень outcomes`,
      hint: 'Объявите хотя бы один исход',
    });
  }

  for (const [name, raw] of Object.entries(value.outcomes ?? {})) {
    const effect = typeof raw === 'string' ? raw : (raw as { effect?: unknown } | null)?.effect;
    if (typeof effect === 'string' && (EFFECTS as readonly string[]).includes(effect)) continue;
    diagnostics.push({
      severity: 'error',
      message: `Исход ${name} шага decision (${site.at}) объявляет эффект ${JSON.stringify(effect ?? null)}, которого нет`,
      hint: `Допустимы: ${EFFECTS.join(', ')}`,
    });
  }

  if (value.deadline !== undefined) {
    try {
      parseDuration(value.deadline);
    } catch (error) {
      diagnostics.push({
        severity: 'error',
        message: `deadline шага decision (${site.at}): ${error instanceof Error ? error.message : String(error)}`,
        hint: 'Срок объявляется длительностью — 30m, 4h, 2d',
      });
    }
  }

  if (value.on_expire !== undefined) {
    if (!outcomeNames.includes(value.on_expire)) {
      diagnostics.push({
        severity: 'error',
        message: `on_expire шага decision (${site.at}) называет исход «${value.on_expire}», которого нет в outcomes`,
        hint: `Объявлены: ${outcomeNames.join(', ') || 'нет'}`,
      });
    } else {
      const spec = normalizeOutcome((value.outcomes as Record<string, RawOutcome>)[value.on_expire] as RawOutcome);
      if (spec.effect === 'restart') {
        diagnostics.push({
          severity: 'error',
          message: `on_expire шага decision (${site.at}) не вправе быть исходом с эффектом restart`,
          hint: 'Прогон, перезапускающий себя по истечении срока, крутился бы без участия человека — выберите continue или reject',
        });
      }
    }
  }

  if (value.deadline !== undefined && value.on_expire === undefined) {
    diagnostics.push({
      severity: 'error',
      message: `Шаг decision (${site.at}) объявляет deadline без on_expire`,
      hint: 'Срок без исхода не решает ничего — назовите on_expire',
    });
  }

  return diagnostics;
}
