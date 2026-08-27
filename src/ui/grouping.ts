/**
 * Раскладка прогонов по пайплайнам для первого экрана витрины.
 *
 * Живёт рядом с `routes.ts` и по той же причине: правило, по которому прогон
 * находит свой пайплайн, — не оформление, а смысл экрана, и проверяться оно
 * должно обычным тестом, а не глазами в браузере. Модуль чист: ни React, ни
 * `window`, ни чтения диска — витрина импортирует его относительным путём из
 * `ui/`, тест — как любой модуль `src/`.
 *
 * Прогон находит свой пайплайн по файлу, которым был запущен
 * (`RunOverview.pipelineFile` против `PipelineView.file`), а не по имени. Имя
 * для этого не годится дважды: два файла одного проекта могут объявить одно
 * имя, а у файла, который не разбирается, имени нет вовсе — вместо него
 * `src/ui/pipelines.ts` подставляет путь файла, и склейка по имени уводила бы
 * прогоны такого пайплайна в чужую группу. Имя остаётся запасным правилом
 * ровно для прогонов, чей манифест не прочитался и файла не сообщил, и
 * применяется только к разобранным пайплайнам.
 *
 * Типы здесь описаны структурно, а не импортированы из `overview.ts` и
 * `pipelines.ts`: между витриной и демоном лежит JSON (см. `ui/src/api.ts`), и
 * модулю нужны от обеих сторон лишь те поля, по которым он и складывает.
 */

/** Прогон обзора — в объёме, нужном для склейки. */
export interface RunLike {
  readonly runId: string;
  readonly pipeline: string;
  readonly pipelineFile?: string;
  readonly startedAt?: string;
}

/** Найденный файл пайплайна — в объёме, нужном для склейки. */
export interface PipelineLike {
  readonly projectKey: string;
  readonly projectPath: string;
  readonly file: string;
  readonly name: string;
  /** Файл не разбирается: его `name` — путь файла, а не объявленное имя. */
  readonly error?: string;
}

/** Проект обзора со своими прогонами. */
export interface ProjectRunsLike<R extends RunLike> {
  readonly key: string;
  readonly path?: string;
  readonly runs: readonly R[];
}

export interface PipelineGroup<P extends PipelineLike, R extends RunLike> {
  readonly pipeline: P;
  /** Прогоны этого пайплайна, новейшими первыми. */
  readonly runs: readonly R[];
}

export interface ProjectGroup<P extends PipelineLike, R extends RunLike> {
  readonly projectKey: string;
  readonly projectPath?: string;
  readonly pipelines: readonly PipelineGroup<P, R>[];
  /**
   * Прогоны, чьего файла пайплайна среди найденных нет: файл удалён,
   * переименован или лежит вне известных мест. С экрана они не пропадают.
   */
  readonly orphanRuns: readonly R[];
}

/** Новейшими первыми; прогон без отметки старта уходит в конец. */
function newestFirst<R extends RunLike>(runs: readonly R[]): R[] {
  const at = (run: R): number => {
    const value = run.startedAt === undefined ? Number.NaN : new Date(run.startedAt).getTime();
    return Number.isNaN(value) ? 0 : value;
  };
  return [...runs].sort((a, b) => at(b) - at(a));
}

function findOwner<P extends PipelineLike, R extends RunLike>(
  pipelines: readonly P[],
  run: R,
): P | undefined {
  // Файл известен — он и решает. Совпадения нет: файла среди найденных больше
  // нет, и прогон честно остаётся без пайплайна, а не приписывается тёзке.
  if (run.pipelineFile !== undefined) {
    return pipelines.find((pipeline) => pipeline.file === run.pipelineFile);
  }
  return pipelines.find((pipeline) => pipeline.error === undefined && pipeline.name === run.pipeline);
}

/**
 * Пайплайны проектов с их прогонами. Проекты берутся из обоих источников:
 * проект, у которого файлы пайплайнов нашлись, но прогонов ещё нет, и проект,
 * у которого есть прогоны, но файлов не нашлось, одинаково остаются на экране.
 */
export function groupProjects<P extends PipelineLike, R extends RunLike>(
  pipelines: readonly P[],
  projects: readonly ProjectRunsLike<R>[],
): ProjectGroup<P, R>[] {
  const pathByProject = new Map<string, string | undefined>();
  const runsByProject = new Map<string, readonly R[]>();
  for (const project of projects) {
    pathByProject.set(project.key, project.path);
    runsByProject.set(project.key, project.runs);
  }
  for (const pipeline of pipelines) {
    if (!pathByProject.has(pipeline.projectKey)) {
      pathByProject.set(pipeline.projectKey, pipeline.projectPath);
    }
  }

  return [...pathByProject.keys()].map((projectKey) => {
    const runs = runsByProject.get(projectKey) ?? [];
    const projectPipelines = pipelines.filter((pipeline) => pipeline.projectKey === projectKey);
    const claimed = new Map<P, R[]>(projectPipelines.map((pipeline) => [pipeline, []]));
    const orphanRuns: R[] = [];

    for (const run of runs) {
      const owner = findOwner(projectPipelines, run);
      const bucket = owner === undefined ? undefined : claimed.get(owner);
      if (bucket === undefined) orphanRuns.push(run);
      else bucket.push(run);
    }

    const projectPath = pathByProject.get(projectKey);
    return {
      projectKey,
      ...(projectPath === undefined ? {} : { projectPath }),
      pipelines: projectPipelines.map((pipeline) => ({
        pipeline,
        runs: newestFirst(claimed.get(pipeline) ?? []),
      })),
      orphanRuns: newestFirst(orphanRuns),
    };
  });
}
