import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createAnchorer } from '../anchor/index.js';
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

/**
 * Наложить дорожку одним диффом: от `tree_before` первого шага дорожки до
 * последнего непустого `tree_id` — в отличие от `--job`, который накладывает
 * каждую работу отдельным диффом, здесь диффов ровно один, и по нему проходит
 * ровно одно `git apply --3way`.
 */
function applyLane(paths: RunPaths, cwd: string, manifest: RunManifest, lane: string): ApplyOutcome {
  const jobs = laneIsolatedJobs(paths, lane);
  if (jobs.length === 0) return { kind: 'nothing-to-apply' };

  const steps = jobs.flatMap((job) => job.steps);
  const from = steps[0]?.tree_before;
  const to = [...steps].reverse().find((step) => step.tree_id !== undefined)?.tree_id;

  if (from === undefined || to === undefined) return { kind: 'nothing-to-apply' };

  // Составной прогон снят в git, но `diff.patch` дорожки склеен из патчей
  // разных баз объектов (по одному на репозиторий) — накладывать его надо по
  // репозиторию, а не одним `git apply` в корне. Отказ «прогон снят вне git»
  // ниже — про другую причину и притворяться объяснением для составного не
  // должен (design.md, решение 10).
  if (manifest.anchor_kind === 'composite') {
    throw new StepcastError(
      `Дорожка ${lane} снята составным способом фиксации: патч склеен из патчей разных баз объектов`,
      {
        hint: 'Наложение составного результата по репозиториям не реализовано — см. merge-lanes-per-repo. Пути рабочих деревьев — в выводе stepcast run',
      },
    );
  }
  if (manifest.anchor_kind !== 'git') {
    throw new StepcastError(`Дорожка ${lane} снята вне git: накладывать нечего`, {
      hint: 'Объектов деревьев нет, поэтому дифф не вычислить.',
    });
  }

  if (from === to) return { kind: 'nothing-to-apply' };

  const stateDir = mkdtempSync(join(tmpdir(), 'stepcast-apply-'));
  const anchorer = createAnchorer({ dir: cwd, stateDir, kind: 'git', scope: 'apply' });
  const before = anchorer.capture();

  try {
    const patch = git(cwd, ['diff', '--binary', from, to]);
    if (patch === '') return { kind: 'nothing-to-apply' };

    const patchFile = join(stateDir, `lane-${lane}.patch`);
    writeFileSync(patchFile, patch);

    try {
      git(cwd, ['apply', '--3way', patchFile]);
    } catch (error) {
      const output = String((error as { stderr?: string }).stderr ?? '');
      const paths_ = conflictingPaths(output);
      throw new StepcastError(`Наложение дорожки ${lane} не сошлось с текущим деревом`, {
        hint:
          paths_.length === 0
            ? 'Текущее дерево изменилось несовместимо с результатом прогона'
            : `Конфликтующие пути:\n${paths_.map((path) => `  ${path}`).join('\n')}\nЗакоммитьте или отложите свои правки в этих файлах и повторите`,
        cause: error,
      });
    }
  } catch (error) {
    anchorer.restore(before);
    throw error;
  } finally {
    anchorer.dispose();
  }

  return { kind: 'applied', jobs: jobs.map((job) => job.id) };
}

export function applyRun(options: ApplyOptions): ApplyOutcome {
  const { paths, cwd } = options;
  const manifest = readManifest(paths);

  if (options.lane !== undefined) return applyLane(paths, cwd, manifest, options.lane);

  const jobs = isolatedJobs(paths, options.job);

  if (jobs.length === 0) return { kind: 'already-in-place' };

  if (manifest.anchor_kind === 'composite') {
    const where = jobs.map((job) => `  ${job.id}: ${job.workspace?.path}`).join('\n');
    throw new StepcastError(
      'Прогон снят составным способом фиксации: патч склеен из патчей разных баз объектов, и накладывать его нужно по репозиторию',
      {
        hint: `Наложение составного результата по репозиториям не реализовано — см. merge-lanes-per-repo. Результат лежит здесь:\n${where}`,
      },
    );
  }
  if (manifest.anchor_kind !== 'git') {
    const where = jobs.map((job) => `  ${job.id}: ${job.workspace?.path}`).join('\n');
    throw new StepcastError('Прогон снят вне git: накладывать нечего', {
      hint: `Объектов деревьев нет, поэтому дифф не вычислить. Результат лежит здесь:\n${where}`,
    });
  }

  // Состояние текущего дерева до наложения: если наложение не сойдётся, дерево
  // возвращается ровно в него. Частично наложенный результат недопустим.
  const stateDir = mkdtempSync(join(tmpdir(), 'stepcast-apply-'));
  const anchorer = createAnchorer({ dir: cwd, stateDir, kind: 'git', scope: 'apply' });
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
      if (from === to) continue;

      const patch = git(cwd, ['diff', '--binary', from, to]);
      if (patch === '') continue;

      const patchFile = join(stateDir, `${job.id}.patch`);
      writeFileSync(patchFile, patch);

      try {
        git(cwd, ['apply', '--3way', patchFile]);
      } catch (error) {
        const output = String((error as { stderr?: string }).stderr ?? '');
        const paths_ = conflictingPaths(output);
        throw new StepcastError(
          `Наложение работы ${job.id} не сошлось с текущим деревом`,
          {
            hint:
              paths_.length === 0
                ? 'Текущее дерево изменилось несовместимо с результатом прогона'
                : `Конфликтующие пути:\n${paths_.map((path) => `  ${path}`).join('\n')}\nЗакоммитьте или отложите свои правки в этих файлах и повторите`,
            cause: error,
          },
        );
      }
      applied.push(job.id);
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
