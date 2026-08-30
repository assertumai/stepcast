import { createHash } from 'node:crypto';
import { join } from 'node:path';

import { StepcastError } from '../errors.js';
import { createGitAnchorer, diffWithPrefix, isOwnWorktreeRoot } from './git.js';
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

export interface CompositeAnchorId {
  readonly fingerprint: string;
  readonly root: string;
  /** Части в порядке канонического состава этого якоря. */
  readonly parts: readonly string[];
}

/**
 * Разобрать идентификатор составного якоря обратно на отпечаток и части.
 * Единственное место движка, знающее форму записи (design.md, решение 2):
 * внутренний `parseOwn` и наложение по репозиториям (`run/apply.ts`) зовут
 * этот же разбор, второго в движке нет. Разбор отвечает только за форму
 * записи; принадлежность идентификатора действующему составу проверяет
 * `checkCompositeComposition` — сверкой с отпечатком самого якоря.
 */
export function splitCompositeAnchorId(id: string): CompositeAnchorId | undefined {
  const segments = id.split('+');
  if (segments.length < 2) return undefined;
  const [fingerprint, root, ...parts] = segments;
  if (fingerprint === undefined || !/^[0-9a-f]{12}$/.test(fingerprint)) return undefined;
  if (root === undefined || root === '') return undefined;
  if (parts.some((part) => part === '')) return undefined;
  return { fingerprint, root, parts };
}

export type CompositeCompositionCheck =
  | { readonly ok: true; readonly parsed: CompositeAnchorId }
  | { readonly ok: false; readonly reason: string };

/**
 * Разобрать идентификатор **в действующий состав**, а не просто в форму
 * записи.
 *
 * Сверка ведётся с отпечатком, которым состав склеен в id (`fingerprintOf`),
 * а не между двумя чужими идентификаторами: два состояния другого состава
 * равны по отпечатку друг другу и разошлись бы только с сегодняшним. Без этой
 * сверки oid части чужого состава ушёл бы в `diff-tree`/`checkout`/`git
 * apply` сегодняшней части — то есть исключением из git или, при общей базе
 * объектов, молча неверным результатом. Действующий состав приводится к
 * каноническому порядку здесь же, вызывающему коду сортировать не нужно.
 */
export function checkCompositeComposition(
  id: string,
  nested: readonly string[],
): CompositeCompositionCheck {
  const parsed = splitCompositeAnchorId(id);
  if (parsed === undefined) {
    return { ok: false, reason: `идентификатор ${id} не в форме составного якоря` };
  }
  const canonical = [...nested].sort();
  const fingerprint = fingerprintOf(canonical);
  if (parsed.fingerprint !== fingerprint || parsed.parts.length !== canonical.length) {
    return {
      ok: false,
      reason: `состав вложенных репозиториев состояния ${id} не совпадает с действующим (${
        canonical.length === 0 ? '(нет)' : canonical.join(', ')
      })`,
    };
  }
  return { ok: true, parsed };
}

export function createCompositeAnchorer(options: CompositeAnchorerOptions): TreeAnchorer {
  const { dir, stateDir } = options;
  const scope = options.scope ?? 'run';
  // Порядок объявления не влияет на идентификатор: он определяется составом,
  // а не тем, в каком порядке его перечислили в конфигурации.
  const nested = [...options.nested].sort();
  const fingerprint = fingerprintOf(nested);

  const root = createGitAnchorer({ dir, indexFile: join(stateDir, `${scope}.index`) });

  /**
   * Якорь части заводится по требованию, а не при создании составного.
   *
   * `createGitAnchorer` отказывает уже в конструкторе, если каталога части
   * нет или он не рабочее дерево git, — и отказывает не о том: его сообщение
   * зовёт хеш-манифест и ничего не говорит ни о вложенных репозиториях, ни об
   * их собственных базах объектов. Отложенное заведение оставляет первое
   * слово за проверками самого составного якоря (`restore`), которые называют
   * часть и причину.
   */
  const parts = new Map<string, TreeAnchorer>();
  const partOf = (relDir: string): TreeAnchorer => {
    const known = parts.get(relDir);
    if (known !== undefined) return known;
    const anchorer = createGitAnchorer({
      dir: join(dir, relDir),
      indexFile: join(stateDir, `${scope}.${nested.indexOf(relDir)}.index`),
    });
    parts.set(relDir, anchorer);
    return anchorer;
  };
  // Самый длинный объявленный каталог выигрывает при маршрутизации пути —
  // так объявленные друг в друге части (`a`, `a/b`) не путаются.
  const byLengthDesc = [...nested].sort((a, b) => b.length - a.length);

  /** Разобрать идентификатор в действующий состав этого якоря — тонкая обёртка над экспортом. */
  const parseOwn = (id: string): CompositeCompositionCheck => checkCompositeComposition(id, nested);

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
      const partAnchors = nested.map((relDir) => partOf(relDir).capture());
      const id = [fingerprint, rootAnchor.id, ...partAnchors.map((anchor) => anchor.id)].join('+');
      return { kind: 'composite', id };
    },

    restore(anchor: Anchor): void {
      if (anchor.kind !== 'composite') {
        throw new StepcastError('Состояние снято не составным способом и восстановлению этим способом не подлежит');
      }
      const check = parseOwn(anchor.id);
      if (!check.ok) throw new StepcastError(check.reason);
      const parsed = check.parsed;

      // Объекты каждой части лежат в базе её собственного репозитория — у
      // каталога, где часть не является рабочим деревом этого репозитория,
      // такой базы нет вовсе, и привести его к составному состоянию нечем.
      // Проверка идёт до первой записи: наполовину приведённого дерева не
      // остаётся, если откажет часть, а не первая по порядку.
      for (const relDir of nested) {
        if (isOwnWorktreeRoot(join(dir, relDir))) continue;
        throw new StepcastError(
          `Состояние ${anchor.id} снято составным способом, а часть ${relDir} в этом каталоге не является рабочим деревом своего репозитория`,
          {
            hint: 'Объекты частей лежат в их собственных базах, которых у свежего каталога нет — восстановите отдельные пути через restorePaths на дереве, где части заведены',
          },
        );
      }

      // Корень, затем части: выкладка корня может двигать запись gitlink, и
      // заканчивать хочется состоянием частей, а не записью о них
      // (design.md, решение 9).
      root.restore({ kind: 'git', id: parsed.root });
      for (let index = 0; index < nested.length; index += 1) {
        const relDir = nested[index]!;
        partOf(relDir).restore({ kind: 'git', id: parsed.parts[index]! });
      }
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
        partOf(relDir).restorePaths({ kind: 'git', id: parsed.parts[index]! }, rest);
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
        const partComparison = partOf(relDir).changedPaths(
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
