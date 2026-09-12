import { parseDuration } from '../../plugin.js';
import type { StepKindContribution, StepKindInput, StepKindOutcome } from '../../plugin.js';

import { DECISION_FIELDS_SCHEMA, DECISION_OUTPUT_SCHEMA, lintDecisionFields, normalizedOutcomes, type DecisionFields } from './fields.js';

/**
 * Вид шага `decision` (`user-decision-steps`, design.md решение 1): первый
 * плагинный вид в поставке. Написан только через `stepcast/plugin` и соседей
 * этого каталога — тот же контракт, что видит сторонний автор плагина, и
 * потому проверка контракта настоящим вкладом, а не предположением.
 *
 * Исполнитель — три строки: прочитать поля, позвать `decision.request`, отдать
 * исход. Судьбу прогона (continue/reject/restart) решает движок; вклад несёт
 * только форму полей и вопрос.
 */
export const stepDecisionContribution: StepKindContribution = {
  name: 'decision',
  title: 'Решение',
  fields: DECISION_FIELDS_SCHEMA,
  output: DECISION_OUTPUT_SCHEMA,
  waits: true,
  lint: lintDecisionFields,
  async execute(input: StepKindInput): Promise<StepKindOutcome> {
    const fields = input.fields as DecisionFields;
    if (input.decision === undefined) {
      // Недостижимо на практике: способность даётся движком только виду,
      // объявившему `waits: true`, а `decision` объявляет его как раз здесь.
      throw new Error('Движок не дал шагу decision способность ожидания');
    }

    const result = await input.decision.request({
      outcomes: normalizedOutcomes(fields),
      prompt: fields.prompt,
      ...(fields.deadline === undefined ? {} : { deadlineMs: parseDuration(fields.deadline) }),
      ...(fields.on_expire === undefined ? {} : { onExpire: fields.on_expire }),
    });

    // Достигнуто только эффектом continue: reject и restart отдаются отказом
    // обещания движка раньше, чем управление вернётся сюда.
    return {
      structured: {
        outcome: result.outcome,
        effect: result.effect,
        by: result.by,
        ...(result.reason === undefined ? {} : { reason: result.reason }),
        ...(result.restartFrom === undefined ? {} : { restart_from: result.restartFrom }),
      },
    };
  },
};
