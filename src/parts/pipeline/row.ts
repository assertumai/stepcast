import type { Fiber } from 'cordis';

import { assertStepKindNameAvailable } from '../../core/pipeline/schema.js';
import type { BackendContribution, PredicateKind, StepKind } from '../../core/plugins/pipeline-contract.js';
import { ContributionService } from '../../core/plugins/kernel.js';
import { isBuiltinRowFiber } from '../../core/plugins/load.js';
import { partRow } from './services.js';

/**
 * Строка `pipeline` — поставщик, и только (design.md `pipeline-owns-services`,
 * Решение 1). Заводит три служебных сервиса движка пайплайнов на своей
 * области и не вносит ни одного вклада — бэкенды, предикаты и виды шага
 * приносят соседние строки-потребители (`src/parts/backends/claude/row.ts`,
 * `src/parts/expect/row.ts`, строки видов шага в `src/parts/steps`).
 *
 * Проверка имени вида шага (`assertStepKindNameAvailable`) — доменное знание,
 * которое ядро принимало параметром сборки (`kernel-domain-free-imports`,
 * Решение 1); после переезда она подаётся прямо конструктору сервиса `steps`,
 * рядом со словом для его текстов отказа.
 */
export const row = partRow('pipeline', [], (ctx) => {
  // Признак встроенности сервисов пайплайна — по образцу `commands` в ядре
  // (`core/plugins/kernel.ts`, `createKernel`): идентичность области этой
  // строки (в синхронной сборке умолчания это корневая область — все строки
  // применяются прямо на ней, `applyRowOnRoot`) ИЛИ пометка `rowScope` у
  // строки-потребителя со своей областью (design.md изменения
  // `cli-commands-as-rows`, Решение 7).
  const isPipelineFiber = (fiber: Fiber): boolean => fiber === ctx.fiber || isBuiltinRowFiber(fiber);
  new ContributionService<BackendContribution>(ctx, 'backends', 'бэкенда', isPipelineFiber);
  new ContributionService<PredicateKind>(ctx, 'predicates', 'предиката', isPipelineFiber);
  new ContributionService<StepKind>(ctx, 'steps', 'вида шага', isPipelineFiber, assertStepKindNameAvailable);
});
