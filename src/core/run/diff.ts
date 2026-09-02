import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { AnchorKind, TreeAnchorer } from '../anchor/index.js';
import { StepcastError } from '../errors.js';
import { findStepDir, readManifest, readStatus } from '../journal/reader.js';
import type { RunPaths } from '../journal/paths.js';
import type { RunManifest, RunStatus, StepRecord } from '../journal/schema.js';

/**
 * Сравнение двух прогонов.
 *
 * Работает **только по журналам**: ни пайплайн, ни бэкенды не нужны. Поэтому
 * сравнить можно и прогоны, снятые на разных версиях проекта, — лишь бы
 * совпал способ фиксации состояния дерева.
 *
 * Основной сценарий: фича не взлетела со второго захода, и надо увидеть, чем
 * второй прогон отличался от первого.
 */
export type StepCategory = 'same' | 'changed' | 'only-a' | 'only-b';

export interface SourceDiff {
  /** Что сравнивается: промпт, контекст, проверки, дерево. */
  readonly source: string;
  /** Источник отсутствует у одного из прогонов — это не пустота, а отсутствие. */
  readonly missing?: 'a' | 'b' | 'both';
  readonly lines: readonly string[];
  readonly note?: string;
}

export interface StepComparison {
  readonly job: string;
  readonly step: string;
  readonly category: StepCategory;
  readonly sources: readonly SourceDiff[];
}

export interface RunComparison {
  readonly a: string;
  readonly b: string;
  readonly steps: readonly StepComparison[];
  /** Пометки о несравнимых частях: разные пайплайны, разные способы фиксации. */
  readonly notes: readonly string[];
  readonly identical: boolean;
}

export interface DiffOptions {
  readonly a: RunPaths;
  readonly b: RunPaths;
  /** Якорь для сравнения деревьев. Без него деревья не сравниваются. */
  readonly anchorer?: TreeAnchorer;
}

export function diffRuns(options: DiffOptions): RunComparison {
  const a = load(options.a);
  const b = load(options.b);

  if (a.manifest.project_root !== b.manifest.project_root) {
    throw new StepcastError('Прогоны относятся к разным проектам и несравнимы', {
      hint: `${a.manifest.project_root}\n${b.manifest.project_root}`,
    });
  }

  const notes: string[] = [];
  if (a.manifest.pipeline !== b.manifest.pipeline) {
    notes.push(
      `пайплайны различаются: ${a.manifest.pipeline} и ${b.manifest.pipeline} — сравнение по шагам приблизительно`,
    );
  }

  // Состав плагинов входит в заметки, а не в ключ шага: семантика вклада не
  // отпечатывается, и два прогона с одним ключом, но разными плагинами —
  // ровно тот случай, когда «одинаковые шаги» значат разное.
  const pluginsNote = describePluginDifference(a.manifest.plugins, b.manifest.plugins);
  if (pluginsNote !== undefined) notes.push(pluginsNote);

  // Разный способ фиксации — несравнимо по действующему правилу; тот же
  // способ, но разный состав вложенных репозиториев (`composite`) — тоже:
  // якорь другого состава несёт другой отпечаток, и складывать их пути в
  // одно сравнение значило бы сравнивать разные деревья молча.
  //
  // Третий случай — способ обоих прогонов совпал, но сегодняшнее дерево
  // фиксируется другим: `stepcast diff` строит якорь сравнения по
  // *сегодняшней* конфигурации, и два составных прогона, разбираемые там, где
  // `project.nested_repos` уже не объявлен, получили бы git-якорь, которому
  // составной идентификатор не значит ничего.
  const treesIncomparableReason =
    a.manifest.anchor_kind !== b.manifest.anchor_kind
      ? 'состояния деревьев сняты разными способами и несравнимы: сравниваются только промпт, контекст и проверки'
      : !sameNestedRepos(a.manifest.nested_repos, b.manifest.nested_repos)
        ? `состав вложенных репозиториев различается: ${describeComposition(a.manifest.nested_repos)} и ${describeComposition(b.manifest.nested_repos)} — деревья несравнимы`
        : options.anchorer !== undefined &&
            a.manifest.anchor_kind !== undefined &&
            options.anchorer.kind !== a.manifest.anchor_kind
          ? `состояния деревьев сняты способом ${a.manifest.anchor_kind}, а сегодняшнее дерево фиксируется способом ${options.anchorer.kind} — деревья несравнимы`
          : undefined;
  if (treesIncomparableReason !== undefined) notes.push(treesIncomparableReason);
  const treesComparable = treesIncomparableReason === undefined;

  const steps: StepComparison[] = [];
  for (const address of orderedAddresses(a.status, b.status)) {
    const left = stepOf(a.status, address);
    const right = stepOf(b.status, address);

    if (left === undefined || right === undefined) {
      steps.push({
        job: address.job,
        step: address.step,
        category: left === undefined ? 'only-b' : 'only-a',
        sources: [],
      });
      continue;
    }

    if (left.key === right.key) {
      steps.push({ job: address.job, step: address.step, category: 'same', sources: [] });
      continue;
    }

    steps.push({
      job: address.job,
      step: address.step,
      category: 'changed',
      sources: compareSources({
        a: options.a,
        b: options.b,
        address,
        left,
        right,
        treesComparable,
        ...(treesIncomparableReason === undefined ? {} : { treesIncomparableReason }),
        ...(options.anchorer === undefined ? {} : { anchorer: options.anchorer }),
        ...(a.manifest.anchor_kind === undefined ? {} : { anchorKind: a.manifest.anchor_kind }),
      }),
    });
  }

  return {
    a: a.manifest.run_id,
    b: b.manifest.run_id,
    steps,
    notes,
    identical: steps.every((step) => step.category === 'same'),
  };
}

interface Loaded {
  readonly manifest: RunManifest;
  readonly status: RunStatus;
}

function load(paths: RunPaths): Loaded {
  return { manifest: readManifest(paths), status: readStatus(paths) };
}

interface Address {
  readonly job: string;
  readonly step: string;
}

/** Порядок вывода повторяет порядок исполнения, а не порядок обнаружения. */
function orderedAddresses(a: RunStatus, b: RunStatus): Address[] {
  const seen = new Set<string>();
  const result: Address[] = [];

  for (const status of [a, b]) {
    for (const job of status.jobs) {
      for (const step of job.steps) {
        const key = `${job.id}/${step.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        result.push({ job: job.id, step: step.id });
      }
    }
  }

  return result;
}

function stepOf(status: RunStatus, address: Address): StepRecord | undefined {
  return status.jobs
    .find((job) => job.id === address.job)
    ?.steps.find((step) => step.id === address.step);
}

interface CompareOptions {
  readonly a: RunPaths;
  readonly b: RunPaths;
  readonly address: Address;
  readonly left: StepRecord;
  readonly right: StepRecord;
  readonly treesComparable: boolean;
  readonly treesIncomparableReason?: string;
  readonly anchorer?: TreeAnchorer;
  readonly anchorKind?: AnchorKind;
}

/**
 * Различие в составе плагинов двух прогонов. Прогон прежней версии поля не
 * несёт вовсе — молчать о нём вернее, чем объявлять «плагинов не было»:
 * второе было бы утверждением, которого журнал не делал.
 */
function describePluginDifference(
  a: RunManifest['plugins'],
  b: RunManifest['plugins'],
): string | undefined {
  if (a === undefined || b === undefined) return undefined;

  const describe = (plugins: NonNullable<RunManifest['plugins']>): string =>
    plugins.length === 0
      ? 'без плагинов'
      : plugins
          .map((plugin) => `${plugin.name}${plugin.version === undefined ? '' : `@${plugin.version}`}`)
          .sort()
          .join(', ');

  const left = describe(a);
  const right = describe(b);
  return left === right ? undefined : `состав плагинов различается: ${left} и ${right}`;
}

function sameNestedRepos(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  const left = a ?? [];
  const right = b ?? [];
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function describeComposition(nestedRepos: readonly string[] | undefined): string {
  return nestedRepos === undefined || nestedRepos.length === 0
    ? '(без вложенных репозиториев)'
    : nestedRepos.join(', ');
}

/**
 * Различия группируются по источнику: изменение промпта не должно смешиваться
 * с изменением дерева, иначе по выводу нельзя понять, что именно поменяли.
 */
function compareSources(options: CompareOptions): SourceDiff[] {
  const { a, b, address } = options;
  const sources: SourceDiff[] = [];

  for (const [name, file] of [
    ['промпт', 'prompt.txt'],
    ['контекст', 'context.json'],
    ['проверки', 'expect.json'],
  ] as const) {
    const left = readStepFile(a, address, file);
    const right = readStepFile(b, address, file);

    if (left === undefined && right === undefined) {
      sources.push({ source: name, missing: 'both', lines: [] });
      continue;
    }
    if (left === undefined || right === undefined) {
      sources.push({ source: name, missing: left === undefined ? 'a' : 'b', lines: [] });
      continue;
    }
    if (left === right) continue;

    sources.push({ source: name, lines: lineDiff(left, right) });
  }

  sources.push(compareTrees(options));
  return sources;
}

function compareTrees(options: CompareOptions): SourceDiff {
  const { left, right, treesComparable, treesIncomparableReason, anchorer, anchorKind } = options;

  if (!treesComparable) {
    return { source: 'дерево', lines: [], note: treesIncomparableReason ?? 'способы фиксации различаются — несравнимо' };
  }
  if (left.tree_id === undefined || right.tree_id === undefined) {
    return {
      source: 'дерево',
      missing: left.tree_id === undefined ? 'a' : 'b',
      lines: [],
    };
  }
  if (left.tree_id === right.tree_id) return { source: 'дерево', lines: [] };
  if (anchorer === undefined || anchorKind === undefined) {
    return { source: 'дерево', lines: [], note: 'сравнение деревьев недоступно' };
  }

  const comparison = anchorer.changedPaths(
    { kind: anchorKind, id: left.tree_id },
    { kind: anchorKind, id: right.tree_id },
  );

  return comparison.comparable
    ? { source: 'дерево', lines: comparison.paths.map((path) => `  ${path}`) }
    : { source: 'дерево', lines: [], note: comparison.reason };
}

function readStepFile(paths: RunPaths, address: Address, name: string): string | undefined {
  const dir = findStepDir(paths, address.job, address.step);
  if (dir === undefined) return undefined;
  const file = join(dir, name);
  return existsSync(file) ? readFileSync(file, 'utf8') : undefined;
}

/**
 * Построчное сравнение по наибольшей общей подпоследовательности. Внешней
 * зависимости здесь не заводится: пары сотен строк хватает, а лишний пакет в
 * инструменте, который должен ставиться одной командой, стоит дороже.
 */
export function lineDiff(before: string, after: string): string[] {
  const left = before.split('\n');
  const right = after.split('\n');
  const table: number[][] = Array.from({ length: left.length + 1 }, () =>
    new Array<number>(right.length + 1).fill(0),
  );

  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) {
      (table[i] as number[])[j] =
        left[i] === right[j]
          ? ((table[i + 1] as number[])[j + 1] as number) + 1
          : Math.max((table[i + 1] as number[])[j] as number, (table[i] as number[])[j + 1] as number);
    }
  }

  const lines: string[] = [];
  let i = 0;
  let j = 0;

  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) {
      i += 1;
      j += 1;
    } else if (
      ((table[i + 1] as number[])[j] as number) >= ((table[i] as number[])[j + 1] as number)
    ) {
      lines.push(`  - ${left[i] as string}`);
      i += 1;
    } else {
      lines.push(`  + ${right[j] as string}`);
      j += 1;
    }
  }

  while (i < left.length) lines.push(`  - ${left[i++] as string}`);
  while (j < right.length) lines.push(`  + ${right[j++] as string}`);

  return lines;
}

/** Человекочитаемый отчёт. */
export function describeComparison(comparison: RunComparison): string[] {
  const lines: string[] = [];
  for (const note of comparison.notes) lines.push(`примечание: ${note}`);

  if (comparison.identical) {
    lines.push('различий нет: все шаги совпали по ключам');
    return lines;
  }

  for (const step of comparison.steps) {
    const address = `${step.job}/${step.step}`;
    if (step.category === 'same') continue;

    if (step.category === 'only-a') {
      lines.push(`${address}: есть только в ${comparison.a.slice(-6)}`);
      continue;
    }
    if (step.category === 'only-b') {
      lines.push(`${address}: есть только в ${comparison.b.slice(-6)}`);
      continue;
    }

    lines.push(`${address}: различается`);
    for (const source of step.sources) {
      if (source.missing !== undefined) {
        const where = source.missing === 'both' ? 'обоих прогонов' : `прогона ${source.missing}`;
        lines.push(`  ${source.source}: отсутствует у ${where}`);
        continue;
      }
      if (source.note !== undefined) {
        lines.push(`  ${source.source}: ${source.note}`);
        continue;
      }
      if (source.lines.length === 0) continue;
      lines.push(`  ${source.source}:`);
      for (const line of source.lines) lines.push(`  ${line}`);
    }
  }

  return lines;
}
