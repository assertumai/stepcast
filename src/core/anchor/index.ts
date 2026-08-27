import { join } from 'node:path';

import { createGitAnchorer, isGitWorktree } from './git.js';
import { createManifestAnchorer } from './manifest.js';
import type { AnchorKind, TreeAnchorer } from './types.js';

export type { Anchor, AnchorComparison, AnchorKind, TreeAnchorer } from './types.js';
export { restorable, sameAnchor } from './types.js';
export { isGitWorktree } from './git.js';
export { loadIgnoreRules } from './ignore.js';

/**
 * Способ фиксации выбирается один раз на прогон по факту наличия репозитория и
 * записывается в манифест: якоря разных способов несравнимы, и знать, каким
 * способом снят каждый, нужно постороннему читателю журнала тоже.
 */
/** Где лежат тела манифестов для указанного каталога состояния якоря. */
export function manifestStore(stateDir: string): string {
  return join(stateDir, 'manifests');
}

export function detectAnchorKind(dir: string): AnchorKind {
  return isGitWorktree(dir) ? 'git' : 'manifest';
}

export interface AnchorerOptions {
  readonly dir: string;
  /** Каталог для служебных файлов якоря: индекс git или тела манифестов. */
  readonly stateDir: string;
  /** Способ фиксации. По умолчанию определяется по каталогу. */
  readonly kind?: AnchorKind;
  /** Различает служебные файлы разных работ в пределах прогона. */
  readonly scope?: string;
  /**
   * Репозиторий прогона. Нужен рабочей копии (`copy`) внутри репозитория:
   * сама копия рабочим деревом git не является, а способ фиксации выбран на
   * прогон и одинаков для всех его работ.
   */
  readonly repoDir?: string;
  /** Хранилища тел манифестов от других прогонов: только для чтения. */
  readonly readStores?: readonly string[];
}

export function createAnchorer(options: AnchorerOptions): TreeAnchorer {
  const kind = options.kind ?? detectAnchorKind(options.dir);
  const scope = options.scope ?? 'run';

  if (kind === 'git') {
    return createGitAnchorer({
      dir: options.dir,
      indexFile: join(options.stateDir, `${scope}.index`),
      ...(options.repoDir === undefined ? {} : { repoDir: options.repoDir }),
    });
  }

  // Тела манифестов общие на прогон, а не на работу: сравнивать состояния
  // приходится через границы работ и прогонов.
  return createManifestAnchorer({
    dir: options.dir,
    store: manifestStore(options.stateDir),
    ...(options.readStores === undefined ? {} : { readStores: options.readStores }),
  });
}
