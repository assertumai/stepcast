import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { checkCompositeComposition, createAnchorer, type AnchorKind } from '../anchor/index.js';
import { StepcastError } from '../errors.js';
import { readManifest, readStatus } from '../journal/reader.js';
import type { RunPaths } from '../journal/paths.js';
import type { JobRecord, RunManifest } from '../journal/schema.js';

/**
 * Возврат результата изолированного прогона в текущее дерево.
 *
 * Накладывается **дифф**, а не копируются файлы. Разница принципиальна: копия
 * молча затирает правки, сделанные пользователем после запуска прогона, а дифф
 * в той же ситуации даёт конфликт — то есть вопрос, а не потерю.
 *
 * Изменение вычисляется из якорей, а не из состояния каталога прогона на
 * момент вызова: каталог мог быть тронут, якоря — нет.
 */
export interface ApplyOptions {
  readonly paths: RunPaths;
  /** Дерево, на которое накладывается результат. */
  readonly cwd: string;
  /** Ограничить наложение одной работой. */
  readonly job?: string;
  /** Ограничить наложение одной дорожкой — взаимоисключимо с `job`. */
  readonly lane?: string;
  /**
   * Объявленный состав вложенных репозиториев дерева (`project.nested_repos`)
   * — только для прогонов составного способа фиксации. Читает конфигурацию
   * вызывающая команда, а не это ядро (design.md, решение 3).
   */
  readonly nestedRepos?: readonly string[];
}

export type ApplyOutcome =
  | { readonly kind: 'applied'; readonly jobs: readonly string[] }
  | { readonly kind: 'already-in-place' }
  | { readonly kind: 'nothing-to-apply' };

function git(dir: string, args: readonly string[]): string {
  // `core.quotePath=false`: иначе git экранирует не-ASCII пути в выводе
  // C-последовательностями, и предикат границ, объяснение инвалидации и
  // сравнение прогонов начинают показывать «\321\201...» вместо имени файла.
  return execFileSync('git', ['-C', dir, '-c', 'core.quotePath=false', ...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/**
 * Пути, вокруг которых наложение не сошлось.
 *
 * Формы, которыми git сообщает о неудаче, перечислены явно: разбирать его
 * вывод наугад — значит однажды показать пользователю пустой список вместо
 * имени файла, из-за которого всё встало.
 */
const CONFLICT_PATTERNS: readonly RegExp[] = [
  /^error: patch failed: (.+):\d+$/,
  /^error: (.+): patch does not apply$/,
  // Трёхстороннее наложение требует, чтобы затронутые файлы совпадали с
  // индексом: незакоммиченная правка пользователя блокирует его целиком.
  /^error: (.+): does not match index$/,
  /^error: (.+): does not exist in index$/,
  /^error: (.+): No such file or directory$/,
];

function conflictingPaths(output: string): string[] {
  const paths = new Set<string>();

  for (const line of output.split('\n')) {
    for (const pattern of CONFLICT_PATTERNS) {
      const match = pattern.exec(line.trim());
      if (match?.[1] !== undefined) paths.add(match[1]);
    }
  }

  return [...paths].sort();
}

/** Наложить готовый патч в каталоге `dir`, разбирая конфликт тем же путём, что и раньше. */
function applyPatch(dir: string, patch: string, patchFile: string, conflictMessage: string): void {
  writeFileSync(patchFile, patch);
  try {
    git(dir, ['apply', '--3way', patchFile]);
  } catch (error) {
    const output = String((error as { stderr?: string }).stderr ?? '');
    const paths_ = conflictingPaths(output);
    throw new StepcastError(conflictMessage, {
      hint:
        paths_.length === 0
          ? 'Текущее дерево изменилось несовместимо с результатом прогона'
          : `Конфликтующие пути:\n${paths_.map((path) => `  ${path}`).join('\n')}\nЗакоммитьте или отложите свои правки в этих файлах и повторите`,
      cause: error,
    });
  }
}

/**
 * Пути корневого патча, совпадающие с записью gitlink объявленного вложенного
 * репозитория (путь равен самому объявленному каталогу — design.md, решение
 * 5). Такую запись двигает коммит внутри части, которого дорожка не делает:
 * патч, задевающий её, пришёл из состояния, которого движок не порождает.
 * Проверяется до сборки полного `--binary`-патча и до первого `git apply`.
 */
function gitlinkPathsTouched(cwd: string, from: string, to: string, nestedRepos: readonly string[]): string[] {
  if (nestedRepos.length === 0) return [];
  const declared = new Set(nestedRepos);
  return git(cwd, ['diff', '--name-only', from, to])
    .split('\n')
    .filter((name) => name !== '' && declared.has(name));
}

interface DiffByRepoOptions {
  readonly cwd: string;
  readonly kind: AnchorKind;
  /** Объявленный состав. Игнорируется на `kind !== 'composite'`. */
  readonly nestedRepos: readonly string[];
  readonly from: string;
  readonly to: string;
  readonly stateDir: string;
  /** Различает файлы патчей разных вызовов в пределах одного `stateDir`. */
  readonly patchLabel: string;
  /** Название вклада для сообщений об отказе — «дорожка a» / «работа job1». */
  readonly subject: string;
}

/**
 * Наложить дифф между двумя состояниями по репозиториям — один помощник на
 * все три входа `apply` (`applyLane`, наложение прогона целиком, `--job`).
 *
 * На `git`-якоре — прежние один `git diff --binary` и один `git apply --3way`
 * в `cwd`. На составном — по вызову на корень и на каждую часть, чьи oid до и
 * после различаются: каждый `git -C <каталог части>`, путями от корня самой
 * части и без приставки каталога (design.md, решения 3–4). Отпечатки обоих
 * состояний сверяются с действующим составом (`checkCompositeComposition`) до
 * первой правки дерева — расхождение отказывает названной причиной, а не
 * накладывает oid чужой части в сегодняшнюю.
 *
 * Возвращает, лёг ли дифф хоть в один репозиторий.
 */
function applyDiffByRepo(options: DiffByRepoOptions): boolean {
  const { cwd, kind, nestedRepos, from, to, stateDir, patchLabel, subject } = options;

  if (from === to) return false;

  if (kind !== 'composite') {
    const patch = git(cwd, ['diff', '--binary', from, to]);
    if (patch === '') return false;
    applyPatch(cwd, patch, join(stateDir, `${patchLabel}.patch`), `Наложение ${subject} не сошлось с текущим деревом`);
    return true;
  }

  const fromCheck = checkCompositeComposition(from, nestedRepos);
  if (!fromCheck.ok) throw new StepcastError(fromCheck.reason);
  const toCheck = checkCompositeComposition(to, nestedRepos);
  if (!toCheck.ok) throw new StepcastError(toCheck.reason);

  const canonical = [...nestedRepos].sort();
  let applied = false;

  if (fromCheck.parsed.root !== toCheck.parsed.root) {
    const gitlinkPaths = gitlinkPathsTouched(cwd, fromCheck.parsed.root, toCheck.parsed.root, canonical);
    if (gitlinkPaths.length > 0) {
      throw new StepcastError(
        `Вклад ${subject} двигает запись gitlink объявленного каталога ${gitlinkPaths.join(', ')}`,
        {
          hint: 'Запись gitlink меняет коммит внутри части, которого дорожка не делает — наложить такой патч в корень значило бы записать ссылку на несуществующий в базе корня коммит',
        },
      );
    }
    const rootPatch = git(cwd, ['diff', '--binary', fromCheck.parsed.root, toCheck.parsed.root]);
    if (rootPatch !== '') {
      applyPatch(
        cwd,
        rootPatch,
        join(stateDir, `${patchLabel}.root.patch`),
        `Наложение ${subject} не сошлось с текущим деревом (репозиторий: .)`,
      );
      applied = true;
    }
  }

  for (let index = 0; index < canonical.length; index += 1) {
    const relDir = canonical[index]!;
    const partFrom = fromCheck.parsed.parts[index]!;
    const partTo = toCheck.parsed.parts[index]!;
    if (partFrom === partTo) continue;

    const partDir = join(cwd, relDir);
    const partPatch = git(partDir, ['diff', '--binary', partFrom, partTo]);
    if (partPatch === '') continue;

    applyPatch(
      partDir,
      partPatch,
      join(stateDir, `${patchLabel}.${index}.patch`),
      `Наложение ${subject} не сошлось с текущим деревом (репозиторий: ${relDir})`,
    );
    applied = true;
  }

  return applied;
}

function isolatedJobs(paths: RunPaths, only: string | undefined): JobRecord[] {
  const status = readStatus(paths);
  const jobs = status.jobs.filter((job) => job.workspace !== undefined && job.workspace.mode !== 'cwd');

  // Работа, ещё идущая, в наложение «всего прогона» не входит: каталог она
  // уже завела и записала (перечень нужен уборке прогона, оборванного до
  // конца), но исхода не записала, и накладывать по ней нечего. Отказ «нет
  // якорей состояния» на ней превратил бы наложение до конца прогона —
  // работающее по уже отчитавшимся работам — в отказ целиком. Названная
  // поимённо работа (`--job`) этого послабления не получает: спросили про
  // неё — и ответ про её якоря честнее молчания.
  if (only === undefined) return jobs.filter((job) => job.status !== 'running' && job.status !== 'pending');

  const found = jobs.find((job) => job.id === only);
  if (found === undefined) {
    const known = jobs.map((job) => job.id).join(', ');
    throw new StepcastError(`В прогоне нет изолированной работы ${only}`, {
      hint: known === '' ? 'Все работы прогона исполнялись в каталоге запуска' : `Есть: ${known}`,
    });
  }
  return [found];
}

/** Изолированные работы дорожки, в порядке графа (уже — порядок `status.jobs`). */
function laneIsolatedJobs(paths: RunPaths, lane: string): JobRecord[] {
  const status = readStatus(paths);
  return status.jobs.filter(
    (job) => job.lane === lane && job.workspace !== undefined && job.workspace.mode !== 'cwd',
  );
}

export interface LaneAnchorRange {
  readonly from: string;
  readonly to: string;
}

/**
 * Пара состояний, между которыми наложится вклад дорожки: `tree_before`
 * первого шага дорожки и последний непустой `tree_id`. Та же пара, которую
 * вычисляет `applyLane` — сведение (`lanes/merge.ts`) берёт её тем же
 * способом, чтобы затронутые репозитории (`merge-lanes-per-repo`) считались
 * из тех же состояний, которые затем действительно накладываются.
 */
export function laneAnchorRange(paths: RunPaths, lane: string): LaneAnchorRange | undefined {
  const jobs = laneIsolatedJobs(paths, lane);
  if (jobs.length === 0) return undefined;

  const steps = jobs.flatMap((job) => job.steps);
  const from = steps[0]?.tree_before;
  const to = [...steps].reverse().find((step) => step.tree_id !== undefined)?.tree_id;
  if (from === undefined || to === undefined) return undefined;

  return { from, to };
}

/**
 * Наложить дорожку одним диффом: от `tree_before` первого шага дорожки до
 * последнего непустого `tree_id` — в отличие от `--job`, который накладывает
 * каждую работу отдельным диффом, здесь диффов ровно один. На составном
 * якоре «одним диффом» значит по одному вызову на каждый затронутый
 * репозиторий (`applyDiffByRepo`), но так же ровно один проход дорожки.
 */
function applyLane(
  paths: RunPaths,
  cwd: string,
  manifest: RunManifest,
  lane: string,
  nestedRepos: readonly string[],
): ApplyOutcome {
  const jobs = laneIsolatedJobs(paths, lane);
  if (jobs.length === 0) return { kind: 'nothing-to-apply' };

  const range = laneAnchorRange(paths, lane);
  if (range === undefined) return { kind: 'nothing-to-apply' };
  const { from, to } = range;

  if (manifest.anchor_kind !== 'git' && manifest.anchor_kind !== 'composite') {
    throw new StepcastError(`Дорожка ${lane} снята вне git: накладывать нечего`, {
      hint: 'Объектов деревьев нет, поэтому дифф не вычислить.',
    });
  }

  if (from === to) return { kind: 'nothing-to-apply' };

  const stateDir = mkdtempSync(join(tmpdir(), 'stepcast-apply-'));
  const anchorer = createAnchorer({
    dir: cwd,
    stateDir,
    kind: manifest.anchor_kind,
    scope: 'apply',
    ...(manifest.anchor_kind === 'composite' ? { nested: nestedRepos } : {}),
  });
  const before = anchorer.capture();

  let applied: boolean;
  try {
    applied = applyDiffByRepo({
      cwd,
      kind: manifest.anchor_kind,
      nestedRepos,
      from,
      to,
      stateDir,
      patchLabel: `lane-${lane}`,
      subject: `дорожки ${lane}`,
    });
  } catch (error) {
    anchorer.restore(before);
    throw error;
  } finally {
    anchorer.dispose();
  }

  if (!applied) return { kind: 'nothing-to-apply' };
  return { kind: 'applied', jobs: jobs.map((job) => job.id) };
}

export function applyRun(options: ApplyOptions): ApplyOutcome {
  const { paths, cwd } = options;
  const manifest = readManifest(paths);
  const nestedRepos = options.nestedRepos ?? [];

  if (options.lane !== undefined) return applyLane(paths, cwd, manifest, options.lane, nestedRepos);

  const jobs = isolatedJobs(paths, options.job);

  if (jobs.length === 0) return { kind: 'already-in-place' };

  if (manifest.anchor_kind !== 'git' && manifest.anchor_kind !== 'composite') {
    const where = jobs.map((job) => `  ${job.id}: ${job.workspace?.path}`).join('\n');
    throw new StepcastError('Прогон снят вне git: накладывать нечего', {
      hint: `Объектов деревьев нет, поэтому дифф не вычислить. Результат лежит здесь:\n${where}`,
    });
  }

  // Состояние текущего дерева до наложения: если наложение не сойдётся, дерево
  // возвращается ровно в него. Частично наложенный результат недопустим.
  const stateDir = mkdtempSync(join(tmpdir(), 'stepcast-apply-'));
  const anchorer = createAnchorer({
    dir: cwd,
    stateDir,
    kind: manifest.anchor_kind,
    scope: 'apply',
    ...(manifest.anchor_kind === 'composite' ? { nested: nestedRepos } : {}),
  });
  const before = anchorer.capture();

  const applied: string[] = [];

  try {
    for (const job of jobs) {
      const steps = job.steps;
      const from = steps[0]?.tree_before;
      const to = [...steps].reverse().find((step) => step.tree_id !== undefined)?.tree_id;

      if (from === undefined || to === undefined) {
        throw new StepcastError(`У работы ${job.id} нет якорей состояния`, {
          hint: 'Прогон снят до введения якоря либо фиксация не удалась — см. events.ndjson',
        });
      }

      const jobApplied = applyDiffByRepo({
        cwd,
        kind: manifest.anchor_kind,
        nestedRepos,
        from,
        to,
        stateDir,
        patchLabel: job.id,
        subject: `работы ${job.id}`,
      });
      if (jobApplied) applied.push(job.id);
    }
  } catch (error) {
    // Возврат к исходному состоянию: пользователь получает вопрос, а не
    // наполовину наложенный результат.
    anchorer.restore(before);
    throw error;
  } finally {
    anchorer.dispose();
  }

  return applied.length === 0 ? { kind: 'nothing-to-apply' } : { kind: 'applied', jobs: applied };
}
