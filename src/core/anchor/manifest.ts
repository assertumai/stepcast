import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import { StepcastError } from '../errors.js';
import { loadIgnoreRules } from './ignore.js';
import type { Anchor, AnchorComparison, TreeAnchorer } from './types.js';

/**
 * Фиксация состояния хеш-манифестом — для деревьев вне git.
 *
 * Манифест — построчный перечень «путь, режим, хеш содержимого»,
 * отсортированный по пути; якорь — sha256 от него. Форма выбрана ради одного
 * свойства: манифесты сравнимы построчно, поэтому «какие пути различаются»
 * отвечается без git и без хранения самих деревьев. Именно этот ответ нужен
 * предикату границ изменений и сравнению прогонов.
 *
 * Восстановления манифест не умеет и не притворяется, что умеет: содержимого
 * файлов он не хранит. Ограничение объявлено отказом в `restore`, а не тихой
 * работой на неверном дереве.
 */
export interface ManifestAnchorerOptions {
  readonly dir: string;
  /** Куда складывать тела манифестов: директория прогона, не рабочее дерево. */
  readonly store: string;
  /**
   * Дополнительные хранилища только для чтения. Через них план возобновления
   * добирается до тел, записанных прошлым прогоном: без них сравнить его
   * состояние с сегодняшним нечем.
   */
  readonly readStores?: readonly string[];
}

const MODE_FILE = '100644';
const MODE_EXECUTABLE = '100755';

function walk(root: string): string[] {
  const rules = loadIgnoreRules(root);
  const found: string[] = [];

  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      const rel = relative(root, full).split('\\').join('/');
      if (rules.ignores(rel, entry.isDirectory())) continue;

      if (entry.isDirectory()) visit(full);
      else if (entry.isFile()) found.push(rel);
    }
  };

  visit(root);
  return found.sort();
}

function buildManifest(root: string): string {
  return walk(root)
    .map((rel) => {
      const full = join(root, rel);
      const mode = (statSync(full).mode & 0o111) === 0 ? MODE_FILE : MODE_EXECUTABLE;
      const hash = createHash('sha256').update(readFileSync(full)).digest('hex');
      return `${mode} ${hash} ${rel}`;
    })
    .join('\n');
}

function pathsOf(manifest: string): Map<string, string> {
  const entries = new Map<string, string>();
  for (const line of manifest.split('\n')) {
    if (line === '') continue;
    const separator = line.indexOf(' ', line.indexOf(' ') + 1);
    entries.set(line.slice(separator + 1), line.slice(0, separator));
  }
  return entries;
}

export function createManifestAnchorer(options: ManifestAnchorerOptions): TreeAnchorer {
  const { dir, store } = options;
  mkdirSync(store, { recursive: true, mode: 0o700 });

  const bodyPath = (id: string): string => join(store, `${id}.manifest`);

  const read = (anchor: Anchor): string | undefined => {
    for (const base of [store, ...(options.readStores ?? [])]) {
      const path = join(base, `${anchor.id}.manifest`);
      if (existsSync(path)) return readFileSync(path, 'utf8');
    }
    return undefined;
  };

  return {
    kind: 'manifest',

    capture(): Anchor {
      const manifest = buildManifest(dir);
      const id = createHash('sha256').update(manifest).digest('hex').slice(0, 40);
      const path = bodyPath(id);
      if (!existsSync(path)) writeFileSync(path, manifest, { mode: 0o600 });
      return { kind: 'manifest', id };
    },

    restore(anchor: Anchor): void {
      throw new StepcastError(
        `Состояние ${anchor.id} снято хеш-манифестом и восстановлению не подлежит`,
        {
          hint: 'Манифест отвечает, изменилось ли дерево, но содержимого файлов не хранит; вне git возобновление возможно только на уцелевшем каталоге',
        },
      );
    },

    restorePaths(anchor: Anchor): void {
      throw new StepcastError(
        `Состояние ${anchor.id} снято хеш-манифестом и восстановлению не подлежит`,
        {
          hint: 'Манифест содержимого файлов не хранит; вне git возобновление возможно только на уцелевшем каталоге',
        },
      );
    },

    changedPaths(from: Anchor, to: Anchor): AnchorComparison {
      if (from.kind !== to.kind) {
        return {
          comparable: false,
          reason: `состояния сняты разными способами: ${from.kind} и ${to.kind}`,
        };
      }
      if (from.id === to.id) return { comparable: true, paths: [] };

      const before = read(from);
      const after = read(to);
      if (before === undefined || after === undefined) {
        return { comparable: false, reason: 'тело манифеста недоступно' };
      }

      const left = pathsOf(before);
      const right = pathsOf(after);
      const paths = new Set<string>();

      for (const [path, entry] of left) {
        if (right.get(path) !== entry) paths.add(path);
      }
      for (const path of right.keys()) {
        if (!left.has(path)) paths.add(path);
      }

      return { comparable: true, paths: [...paths].sort() };
    },

    diff(): string | undefined {
      // Патча манифест дать не может: содержимого файлов у него нет.
      return undefined;
    },

    dispose(): void {
      // Тела манифестов не удаляются: они — часть журнала, и по ним сравнивают
      // состояния между прогонами. Удалить их значило бы лишить `resume` и
      // `diff` предмета сравнения сразу после окончания работы.
    },
  };
}
