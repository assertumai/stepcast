import type { Permissions } from '../pipeline/model.js';

/**
 * Политика, с которой шаг уходит в бэкенд.
 *
 * Списки и режим не складываются между уровнями: ближайшее объявление
 * побеждает целиком (`expand.ts` уже свёл шаг с работой). А вот `enforce` —
 * не часть списка, а граница, объявленная над ним: базовый режим бэкенда
 * применяется и к шагу, который объявил `permissions`, но своего `enforce` не
 * назвал. Иначе любой блок `permissions` — а он есть почти у каждого
 * агентского шага — молча снимал бы проектную границу, то есть давал ровно то
 * тихое послабление, ради устранения которого режим и заведён.
 *
 * Ослабление остаётся возможным, но только явное: `enforce: inherit` на шаге
 * побеждает `strict` из конфигурации, потому что названо.
 */
export function effectivePermissions(
  declared: Permissions | undefined,
  base: Permissions | undefined,
): Permissions | undefined {
  const policy = declared ?? base;
  if (policy === undefined) return undefined;

  const enforce = declared?.enforce ?? base?.enforce;
  if (enforce === undefined || enforce === policy.enforce) return policy;
  return { ...policy, enforce };
}
