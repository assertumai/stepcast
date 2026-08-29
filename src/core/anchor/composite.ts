import { createHash } from 'node:crypto';
import { join } from 'node:path';

import { StepcastError } from '../errors.js';
import { createGitAnchorer, diffWithPrefix } from './git.js';
import type { Anchor, AnchorComparison, TreeAnchorer } from './types.js';

/**
 * Фиксация составного состояния — корень плюс объявленные вложенные
 * репозитории (`project.nested_repos`).
 *
 * Каждая часть — собственный `createGitAnchorer` в своей базе объектов
 * (вложенный репозиторий — свой собственный) и со своим индексным файлом:
 * `<scope>.index` у корня, `<scope>.<n>.index` у части номер `n` в порядке
 * канонического состава. Файл не повторяет работу с git — он держит по одному
 * `TreeAnchorer` на каждую часть и склеивает их ответы, как описано в
 * openspec/changes/nested-repo-anchor/design.md (решение 3).
 */
export interface CompositeAnchorerOptions {
  readonly dir: string;
  readonly stateDir: string;
  readonly scope?: string;
  /** Объявленный состав. Порядок не важен — здесь он приводится к каноническому. */
  readonly nested: readonly string[];
}

/** Первые 12 знаков sha256 от состава, склеенного переводами строк. */
function fingerprintOf(nested: readonly string[]): string {
  return createHash('sha256').update(nested.join('\n')).digest('hex').slice(0, 12);
}

interface ParsedId {
  readonly fingerprint: string;
  readonly root: string;
  /** Части в порядке канонического состава этого якоря. */
  readonly parts: readonly string[];
}

/**
 * Разобрать идентификатор составного якоря обратно на отпечаток и части.
 * Разбор отвечает только за форму записи; принадлежность разобранного
 * идентификатора действующему составу проверяет `parseOwn` — сверкой с
 * отпечатком самого якоря (см. design.md, решение 4).
 */
function parseId(id: string): ParsedId | undefined {
  const segments = id.split('+');
  if (segments.length < 2) return undefined;
  const [fingerprint, root, ...parts] = segments;
  if (fingerprint === undefined || !/^[0-9a-f]{12}$/.test(fingerprint)) return undefined;
  if (root === undefined || root === '') return undefined;
  if (parts.some((part) => part === '')) return undefined;
  return { fingerprint, root, parts };
}

export function createCompositeAnchorer(options: CompositeAnchorerOptions): TreeAnchorer {
  const { dir, stateDir } = options;
  const scope = options.scope ?? 'run';
  // Порядок объявления не влияет на идентификатор: он определяется составом,
  // а не тем, в каком порядке его перечислили в конфигурации.
  const nested = [...options.nested].sort();
  const fingerprint = fingerprintOf(nested);

  const root = createGitAnchorer({ dir, indexFile: join(stateDir, `${scope}.index`) });
  const parts = new Map<string, TreeAnchorer>(
    nested.map((relDir, index) => [
      relDir,
      createGitAnchorer({
        dir: join(dir, relDir),
        indexFile: join(stateDir, `${scope}.${index}.index`),
      }),
    ]),
  );
  // Самый длинный объявленный каталог выигрывает при маршрутизации пути —
  // так объявленные друг в друге части (`a`, `a/b`) не путаются.
  const byLengthDesc = [...nested].sort((a, b) => b.length - a.length);

  const describeComposition = (): string => (nested.length === 0 ? '(нет)' : nested.join(', '));

  /**
   * Разобрать идентификатор **в действующий состав**.
   *
   * Сверка ведётся с отпечатком самого якоря, а не между двумя чужими
   * идентификаторами: два состояния другого состава равны по отпечатку друг
   * другу и разошлись бы только с сегодняшним. Без этой сверки oid части
   * чужого состава ушёл бы в `diff-tree`/`checkout` сегодняшней части — то
   * есть исключением из git или, при общей базе объектов, молча неверным
   * перечнем путей с неверным префиксом.
   */
  const parseOwn = (id: string): { ok: true; parsed: ParsedId } | { ok: false; reason: string } => {
    const parsed = parseId(id);
    if (parsed === undefined) {
      return { ok: false, reason: `идентификатор ${id} не в форме составного якоря` };
    }
    if (parsed.fingerprint !== fingerprint || parsed.parts.length !== nested.length) {
      return {
        ok: false,
        reason: `состав вложенных репозиториев состояния ${id} не совпадает с действующим (${describeComposition()})`,
      };
    }
    return { ok: true, parsed };
  };

  const foreignKindReason = (kind: string): string =>
    `состояния сняты способом ${kind}, а действующий якорь — составной`;

  /** Маршрутизировать путь в часть по самому длинному совпавшему префиксу. */
  const routeOf = (path: string): { readonly dir: string | undefined; readonly rest: string } => {
    for (const declared of byLengthDesc) {
      if (path === declared) return { dir: undefined, rest: path }; // gitlink — правит корень
      if (path.startsWith(`${declared}/`)) return { dir: declared, rest: path.slice(declared.length + 1) };
    }
    return { dir: undefined, rest: path };
  };

  return {
    kind: 'composite',

    capture(): Anchor {
      const rootAnchor = root.capture();
      const partAnchors = nested.map((relDir) => parts.get(relDir)!.capture());
      const id = [fingerprint, rootAnchor.id, ...partAnchors.map((anchor) => anchor.id)].join('+');
      return { kind: 'composite', id };
    },

    restore(anchor: Anchor): void {
      // Объекты вложенного репозитория лежат в его собственной базе — у
      // чужого каталога такой базы нет вовсе, и привести его к составному
      // состоянию нечем. По образцу отказа хеш-манифеста (anchor/manifest.ts).
      throw new StepcastError(
        `Состояние ${anchor.id} снято составным способом и восстановлению целиком не подлежит`,
        {
          hint: 'Объекты вложенных репозиториев лежат в их собственных базах, которых у свежей копии нет — восстановите отдельные пути через restorePaths на том же дереве',
        },
      );
    },

    restorePaths(anchor: Anchor, paths: readonly string[]): void {
      if (paths.length === 0) return;
      if (anchor.kind !== 'composite') {
        throw new StepcastError('Состояние снято не составным способом и восстановлению этим способом не подлежит');
      }
      const check = parseOwn(anchor.id);
      if (!check.ok) throw new StepcastError(check.reason);
      const parsed = check.parsed;

      const rootPaths: string[] = [];
      const partPaths = new Map<string, string[]>();
      for (const path of paths) {
        const { dir: routedDir, rest } = routeOf(path);
        if (routedDir === undefined) {
          rootPaths.push(rest);
          continue;
        }
        const list = partPaths.get(routedDir) ?? [];
        list.push(rest);
        partPaths.set(routedDir, list);
      }

      if (rootPaths.length > 0) root.restorePaths({ kind: 'git', id: parsed.root }, rootPaths);
      for (const [relDir, rest] of partPaths) {
        if (rest.length === 0) continue;
        const index = nested.indexOf(relDir);
        parts.get(relDir)!.restorePaths({ kind: 'git', id: parsed.parts[index]! }, rest);
      }
    },

    changedPaths(from: Anchor, to: Anchor): AnchorComparison {
      if (from.kind !== to.kind) {
        return {
          comparable: false,
          reason: `состояния сняты разными способами: ${from.kind} и ${to.kind}`,
        };
      }
      if (from.id === to.id) return { comparable: true, paths: [] };
      if (from.kind !== 'composite') {
        return { comparable: false, reason: foreignKindReason(from.kind) };
      }

      const fromCheck = parseOwn(from.id);
      if (!fromCheck.ok) return { comparable: false, reason: fromCheck.reason };
      const toCheck = parseOwn(to.id);
      if (!toCheck.ok) return { comparable: false, reason: toCheck.reason };
      const fromParsed = fromCheck.parsed;
      const toParsed = toCheck.parsed;

      const rootComparison = root.changedPaths(
        { kind: 'git', id: fromParsed.root },
        { kind: 'git', id: toParsed.root },
      );
      if (!rootComparison.comparable) return rootComparison;

      const paths = [...rootComparison.paths];
      for (let index = 0; index < nested.length; index += 1) {
        const relDir = nested[index]!;
        const partComparison = parts.get(relDir)!.changedPaths(
          { kind: 'git', id: fromParsed.parts[index]! },
          { kind: 'git', id: toParsed.parts[index]! },
        );
        if (!partComparison.comparable) return partComparison;
        for (const path of partComparison.paths) paths.push(`${relDir}/${path}`);
      }

      return { comparable: true, paths: paths.sort() };
    },

    diff(from: Anchor, to: Anchor): string | undefined {
      if (from.kind !== to.kind || from.id === to.id) return undefined;
      if (from.kind !== 'composite') return undefined;

      const fromCheck = parseOwn(from.id);
      const toCheck = parseOwn(to.id);
      if (!fromCheck.ok || !toCheck.ok) return undefined;
      const fromParsed = fromCheck.parsed;
      const toParsed = toCheck.parsed;

      const patches: string[] = [];
      const rootPatch = root.diff({ kind: 'git', id: fromParsed.root }, { kind: 'git', id: toParsed.root });
      if (rootPatch !== undefined) patches.push(rootPatch);

      for (let index = 0; index < nested.length; index += 1) {
        const relDir = nested[index]!;
        const partPatch = diffWithPrefix(
          join(dir, relDir),
          fromParsed.parts[index]!,
          toParsed.parts[index]!,
          relDir,
        );
        if (partPatch !== undefined) patches.push(partPatch);
      }

      return patches.length === 0 ? undefined : patches.join('');
    },

    dispose(): void {
      root.dispose();
      for (const part of parts.values()) part.dispose();
    },
  };
}
