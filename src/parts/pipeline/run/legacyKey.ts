import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, sep } from 'node:path';
import { parse } from 'yaml';

import { jobLockHash, jobToPlain, pipelineToPlain } from '../document/lock.js';
import type { Job, Pipeline } from '../document/model.js';
import { enginePackageRoot, packageResourcesIn, resourceFingerprint } from '../document/packagePaths.js';
import { computeStepKey, type StepKeyInput } from './stepKey.js';

/**
 * Совместимость возобновления с прогонами, записанными до переносимой формы
 * путей поставки (`document/packagePaths.ts`).
 *
 * Ключи шагов таких прогонов посчитаны от абсолютных путей выпуска, которым
 * они исполнялись (`~/.stepcast/releases/<ts>-<sha>/schema/…`). Сам ключ —
 * хеш, нормализовать его нельзя; зато можно посчитать ключ так, как его
 * посчитал бы прежний выпуск: те же пути, но с корнем того выпуска. Корень
 * берётся из `pipeline.lock.yml` исходного прогона, а ключ «по-старому»
 * допускается, только если каждый ресурс поставки, на который ссылается
 * работа, по содержимому совпадает в старом и в нынешнем корне. Удалённый
 * каталог старого выпуска сравнить не с чем — тогда шаг пересчитывается.
 */

/** Каталоги ресурсов поставки в виде сегмента пути — для поиска корня в старом замке. */
const RESOURCE_MARKERS: readonly string[] = ['schema', join('src', 'builtin'), 'dist'].map(
  (dir) => `${sep}${dir}${sep}`,
);

/**
 * Корни пакета, от которых исходный прогон разрешал ресурсы поставки: префиксы
 * абсолютных путей его замка перед каталогом ресурсов, у которых есть
 * `package.json`. Нечитаемый замок корней не даёт.
 */
export function legacyPackageRoots(lockPath: string): readonly string[] {
  let document: unknown;
  try {
    document = parse(readFileSync(lockPath, 'utf8'));
  } catch {
    return [];
  }

  const roots = new Set<string>();
  const visit = (item: unknown): void => {
    if (typeof item === 'string') {
      if (!isAbsolute(item)) return;
      for (const marker of RESOURCE_MARKERS) {
        const index = item.indexOf(marker);
        if (index > 0) roots.add(item.slice(0, index));
      }
    } else if (Array.isArray(item)) {
      item.forEach(visit);
    } else if (item !== null && typeof item === 'object') {
      Object.values(item).forEach(visit);
    }
  };
  visit(document);
  return [...roots].filter((root) => existsSync(join(root, 'package.json'))).sort();
}

/**
 * Ключи шага, какими их посчитал бы прежний выпуск с корнем из `roots`, — по
 * одному на корень, чьи ресурсы совпадают с нынешними по содержимому. Работа,
 * не ссылающаяся на поставку, ключей не даёт: её ключ от выпуска не зависел.
 */
export function legacyStepKeys(
  pipeline: Pipeline,
  job: Job,
  input: Omit<StepKeyInput, 'lockHash' | 'packagePaths'>,
  roots: readonly string[],
  currentRoot: string = enginePackageRoot(),
): readonly string[] {
  const { jobs: _jobs, ...shared } = pipelineToPlain(pipeline);
  const resources = packageResourcesIn({ shared, job: jobToPlain(job), step: input.step }, currentRoot);
  if (resources.length === 0) return [];

  const keys: string[] = [];
  for (const root of roots) {
    const same = resources.every((resource) => {
      const current = join(currentRoot, resource);
      const previous = join(root, resource);
      // Каталог отпечатка не даёт: совпадением считается то, что он есть в
      // обоих корнях, — его файлы, если на них ссылаются, сравниваются сами.
      return (
        existsSync(current) &&
        existsSync(previous) &&
        resourceFingerprint(current) === resourceFingerprint(previous)
      );
    });
    if (!same) continue;

    const form = { kind: 'relocated', from: currentRoot, to: root } as const;
    keys.push(
      computeStepKey({ ...input, lockHash: jobLockHash(pipeline, job, form), packagePaths: form }),
    );
  }
  return keys;
}
