import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { groupProjects, type PipelineLike, type RunLike } from '../src/ui/grouping.js';

/** Найденный файл пайплайна: разобранный, если не сказано иное. */
function pipeline(file: string, name: string, error?: string): PipelineLike {
  return {
    projectKey: 'proj',
    projectPath: '/дом/proj',
    file,
    name,
    ...(error === undefined ? {} : { error }),
  };
}

function run(runId: string, options: Partial<RunLike> = {}): RunLike {
  return { runId, pipeline: 'demo', ...options };
}

function project(runs: readonly RunLike[]): { key: string; path: string; runs: readonly RunLike[] } {
  return { key: 'proj', path: '/дом/proj', runs };
}

describe('ui-grouping: прогоны под своими пайплайнами', () => {
  it('кладёт прогон под пайплайн по файлу, которым он запущен', () => {
    const groups = groupProjects(
      [pipeline('stepcast.yml', 'demo')],
      [project([run('a', { pipelineFile: 'stepcast.yml' })])],
    );

    assert.equal(groups.length, 1);
    assert.deepEqual(
      groups[0]?.pipelines[0]?.runs.map((item) => item.runId),
      ['a'],
    );
    assert.deepEqual(groups[0]?.orphanRuns, []);
  });

  // Находка ревью: у неразбираемого файла вместо имени стоит путь, и склейка
  // по имени уводила бы его прогоны в группу «пайплайн не найден» — при том
  // что файл как раз найден и показан своей карточкой.
  it('неразбираемый пайплайн сохраняет свои прогоны', () => {
    const groups = groupProjects(
      [pipeline('stepcast.yml', 'stepcast.yml', 'не разбирается: нет jobs')],
      [project([run('a', { pipeline: 'demo', pipelineFile: 'stepcast.yml' })])],
    );

    assert.deepEqual(
      groups[0]?.pipelines[0]?.runs.map((item) => item.runId),
      ['a'],
      'прогоны файла, переставшего разбираться, остаются под его карточкой',
    );
    assert.deepEqual(groups[0]?.orphanRuns, [], 'и не дублируются отдельной группой');
  });

  it('два файла с одним именем делят прогоны по файлам, а не поровну', () => {
    const groups = groupProjects(
      [pipeline('stepcast.yml', 'demo'), pipeline('.stepcast/pipelines/копия.yml', 'demo')],
      [
        project([
          run('a', { pipelineFile: 'stepcast.yml' }),
          run('b', { pipelineFile: '.stepcast/pipelines/копия.yml' }),
        ]),
      ],
    );

    assert.deepEqual(
      groups[0]?.pipelines.map((group) => group.runs.map((item) => item.runId)),
      [['a'], ['b']],
    );
  });

  it('прогон исчезнувшего файла идёт отдельной группой, а не к тёзке', () => {
    const groups = groupProjects(
      [pipeline('stepcast.yml', 'demo')],
      [project([run('a', { pipeline: 'demo', pipelineFile: '.stepcast/pipelines/удалён.yml' })])],
    );

    assert.deepEqual(groups[0]?.pipelines[0]?.runs, []);
    assert.deepEqual(
      groups[0]?.orphanRuns.map((item) => item.runId),
      ['a'],
    );
  });

  it('прогон с непрочитанным манифестом находит пайплайн по имени', () => {
    const groups = groupProjects(
      [pipeline('stepcast.yml', 'demo')],
      [project([run('a', { pipeline: 'demo' })])],
    );

    assert.deepEqual(
      groups[0]?.pipelines[0]?.runs.map((item) => item.runId),
      ['a'],
    );
  });

  it('запасное правило по имени обходит стороной неразбираемые файлы', () => {
    // Имя такого файла — его путь: совпадение с ним было бы случайным.
    const groups = groupProjects(
      [pipeline('demo', 'demo', 'не разбирается')],
      [project([run('a', { pipeline: 'demo' })])],
    );

    assert.deepEqual(groups[0]?.pipelines[0]?.runs, []);
    assert.deepEqual(
      groups[0]?.orphanRuns.map((item) => item.runId),
      ['a'],
    );
  });

  it('прогоны идут новейшими первыми, без отметки старта — в конце', () => {
    const groups = groupProjects(
      [pipeline('stepcast.yml', 'demo')],
      [
        project([
          run('старый', { pipelineFile: 'stepcast.yml', startedAt: '2026-08-01T00:00:00.000Z' }),
          run('без-отметки', { pipelineFile: 'stepcast.yml' }),
          run('новый', { pipelineFile: 'stepcast.yml', startedAt: '2026-08-20T00:00:00.000Z' }),
        ]),
      ],
    );

    assert.deepEqual(
      groups[0]?.pipelines[0]?.runs.map((item) => item.runId),
      ['новый', 'старый', 'без-отметки'],
    );
  });

  it('пайплайн без прогонов остаётся на экране с пустым списком', () => {
    const groups = groupProjects([pipeline('stepcast.yml', 'demo')], []);

    assert.equal(groups.length, 1);
    assert.equal(groups[0]?.projectPath, '/дом/proj');
    assert.deepEqual(groups[0]?.pipelines[0]?.runs, []);
  });

  it('проект с прогонами, но без найденных файлов, с экрана не пропадает', () => {
    const groups = groupProjects([], [project([run('a', { pipelineFile: 'stepcast.yml' })])]);

    assert.deepEqual(groups[0]?.pipelines, []);
    assert.deepEqual(
      groups[0]?.orphanRuns.map((item) => item.runId),
      ['a'],
    );
  });

  it('проект без пути в указателе остаётся без пути, а не выдумывает его', () => {
    const groups = groupProjects([], [{ key: 'proj', runs: [run('a')] }]);

    assert.equal(groups[0]?.projectPath, undefined);
    assert.equal(Object.prototype.hasOwnProperty.call(groups[0], 'projectPath'), false);
  });
});
