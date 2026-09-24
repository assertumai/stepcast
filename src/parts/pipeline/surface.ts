import { StepcastError } from '../../kernel/errors.js';
import type { Context } from '../../kernel/context.js';
import type { PipelineContext } from './contract.js';

/**
 * Публичная поверхность для авторов доменного вклада:
 * `import … from 'stepcast/pipeline'` (`plugin-surface-split`, design.md,
 * Решение 2, Решение 9).
 *
 * Модуль этой строки — `pipeline`, той самой, что заводит служебные сервисы
 * `backends`/`predicates`/`steps` (`src/parts/pipeline/row.ts`): заменяя
 * строку своей, пользователь заменяет и то, и другое, а не наследует чужую
 * поверхность.
 *
 * Ядерных имён здесь нет ни одного (`StepcastError`, `parseDuration`,
 * `runProcess` и подобные — подпуть `stepcast/plugin`): домен не публикует
 * ядро, иначе вопрос «откуда это имя» перестал бы иметь однозначный ответ
 * (design.md, Решение 9).
 */

export type {
  BackendContribution,
  DecisionEffect,
  DecisionOutcome,
  LintSite,
  PipelineCommandEnv,
  PipelineContext,
  /**
   * Доменная форма плагина: ядерные ключи плюс `backends`/`predicates`/`steps`.
   * Публикуется наравне с хелпером `definePipelinePlugin`, потому что хелпер
   * необязателен (docs/plugins.md, «Хелперы объявления»): автор, пишущий
   * декларативный доменный плагин объектным литералом с аннотацией, аннотирует
   * его этим именем — ядерный `StepcastPlugin` доменные ключи отвергает.
   */
  PipelinePlugin,
  PredicateContribution,
  PredicateRegistrar,
  StepKindContribution,
  StepKindDecisionRequest,
  StepKindDecisionResult,
  StepKindDecisions,
  StepKindDocumentForm,
  StepKindInput,
  StepKindLog,
  StepKindOutcome,
  StepKindRegistrar,
} from './contract.js';

/**
 * Хелперы объявления вклада пайплайна (design.md, Решение 8): каждый в
 * рантайме тождество, ни один не проверяет вклад и не регистрирует его.
 * `definePipelinePlugin`/`defineBackend` проверяют литерал на лишние и
 * опечатанные поля; `definePredicate<T>` и `defineStepKind<F>` сверх этого
 * типизируют вход вычислителя объявленным типом.
 */
export {
  defineBackend,
  definePipelinePlugin,
  definePredicate,
  defineStepKind,
} from './contract.js';

export type {
  AgentInvocation,
  BackendAdapter,
  BackendCapabilities,
  BackendEffort,
  BackendEvent,
  BackendModel,
  BackendRefusal,
  BackendRefusalClass,
  LaunchSpec,
  ModelDiscovery,
  PermissionDenial,
  ProbeOutput,
} from './backend/types.js';

export { describeRefusal, emptyUsage, mergeUsage, sumUsage } from './backend/types.js';

/**
 * Правила слияния политики доступа шага с политикой из конфигурации бэкенда.
 * Понадобились адаптеру Codex: без экспорта плагин переписал бы их у себя, и
 * второй бэкенд применял бы `enforce` иначе, чем встроенный.
 */
export { effectivePermissions } from './backend/permissions.js';
/** Формы объявлений, которые `AgentInvocation` несёт адаптеру: политика и MCP-серверы. */
export type { McpServer, McpServers, Permissions } from './document/model.js';

export type { BackendConfig, Config } from './config/resolve.js';
export type { EvaluationInput } from './expect/evaluate.js';
export type { PredicateResult, Usage } from './run/journal/schema.js';

export type { Registry } from '../../kernel/registry.js';

/** Имена служебных сервисов пайплайна — те, что заводит строка `pipeline`. */
export type PipelineService = 'backends' | 'predicates' | 'steps';

const PIPELINE_SERVICES: readonly PipelineService[] = ['backends', 'predicates', 'steps'];

/**
 * Сужение контекста ядра к доменному — проверка, а не приведение
 * (design.md, Решение 5): тело, объявившее зависимость от `backends`,
 * `predicates` или `steps` обратным вызовом `ctx.inject([...], (ctx) => …)`,
 * не вправе аннотировать его параметр `PipelineContext` напрямую — параметр
 * функции проверяется контравариантно, и `(ctx: PipelineContext) => void` не
 * подходит под `(ctx: Context) => void`. `pipelineContext(ctx)` даёт то же
 * сужение вызовом: убеждается, что сервисы разрешаются, и иначе отказывает
 * названно.
 *
 * Проверяется ровно то, что автор назвал: без второго параметра — все три
 * сервиса, а `pipelineContext(ctx, ['backends'])` — один, и тип результата
 * несёт тот же один. Иначе тело, объявившее `ctx.inject(['backends'], …)` —
 * документированный образец, — не смогло бы сузить контекст в составе, где
 * строка `pipeline` заменена своей, отдающей лишь часть сервисов: сужение
 * отказывало бы на сервисах, которых тело не просило и которых в этом составе
 * нет вовсе.
 */
export function pipelineContext(ctx: Context): PipelineContext;
export function pipelineContext<K extends PipelineService>(
  ctx: Context,
  needed: readonly K[],
): Context & Pick<PipelineContext, K>;
export function pipelineContext(
  ctx: Context,
  needed: readonly PipelineService[] = PIPELINE_SERVICES,
): PipelineContext {
  const missing = needed.filter((name) => ctx.get(name) === undefined);
  if (missing.length > 0) {
    throw new StepcastError(
      `Контекст не несёт сервис${missing.length > 1 ? 'ы' : ''} пайплайна: ${missing.join(', ')}`,
      {
        // Два разных случая, и подсказка обязана различать их: зависимость,
        // которую тело не объявило, лечится `inject`; состав, в котором имени
        // не заводит ни одна строка, — нет, и `inject` на такое имя оставит
        // область плагина ждать навсегда, а не даст названный отказ.
        hint:
          `Объявите зависимость от них: ctx.inject(${JSON.stringify(missing)}, (ctx) => …). ` +
          'Если состав этих имён не заводит вовсе (строка pipeline отключена или заменена), ' +
          'зависимость от них объявлять не следует: назовите в pipelineContext(ctx, [...]) только те сервисы, которые вносит ваш вклад',
      },
    );
  }
  return ctx as unknown as PipelineContext;
}
