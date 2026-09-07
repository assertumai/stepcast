import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { buildBacklog } from '../src/ui/backlog.js';
import { buildOverview } from '../src/ui/overview.js';
import { projectKey } from '../src/core/journal/paths.js';
import { makeJournalBed, seedRun } from './helpers.js';

/**
 * Фикстуры очереди — тот же приём, что в `test/backlog.test.ts`: заголовок
 * второго уровня плюс плоские поля.
 */
function item(slug: string, fields: Readonly<Record<string, string>>): string {
  const body = Object.entries(fields)
    .map(([name, value]) => `${name}: ${value}`)
    .join('\n');
  return `## ${slug}\n\n${body}\n`;
}

const BASE = { status: 'pending', title: 'т', why: 'з', done_when: 'к' } as const;

function backlogText(...items: readonly string[]): string {
  return `# Очередь\n\nПреамбула.\n\n${items.join('\n')}`;
}

/** Второй проект того же корня прогонов: свой каталог, свой прогон, своя очередь. */
function makeSecondProject(runsRoot: string, home: string): string {
  const projectRoot = join(home, '..', 'project-2');
  mkdirSync(projectRoot, { recursive: true });
  seedRun(runsRoot, projectRoot, { runId: 'b' });
  return projectRoot;
}

describe('ui-dashboard: сборка вида очереди (src/ui/backlog.ts)', () => {
  it('показывает разделы двух проектов с их пунктами, в порядке файла', () => {
    const { runsRoot, projectRoot, home } = makeJournalBed();
    seedRun(runsRoot, projectRoot, { runId: 'a' });
    writeFileSync(join(projectRoot, 'backlog.md'), backlogText(item('third', BASE), item('first', BASE)));

    const projectRoot2 = makeSecondProject(runsRoot, home);
    writeFileSync(join(projectRoot2, 'backlog.md'), backlogText(item('second', BASE)));

    const backlog = buildBacklog(buildOverview(runsRoot));

    assert.equal(backlog.projects.length, 2);
    const bySlug = backlog.projects.flatMap((project) => project.items.map((entry) => entry.slug));
    assert.deepEqual(new Set(bySlug), new Set(['third', 'first', 'second']));

    const withThird = backlog.projects.find((project) => project.items.some((entry) => entry.slug === 'third'));
    assert.deepEqual(
      withThird?.items.map((entry) => entry.slug),
      ['third', 'first'],
      'порядок пунктов внутри раздела — порядок файла, а не пересортировка',
    );
  });

  it('проект без backlog.md остаётся без раздела и это не считается ошибкой', () => {
    const { runsRoot, projectRoot } = makeJournalBed();
    seedRun(runsRoot, projectRoot, { runId: 'a' });
    // Файл очереди не пишется вовсе.

    const backlog = buildBacklog(buildOverview(runsRoot));
    assert.deepEqual(backlog.projects, []);
  });

  it('проект без пути в указателе projects.json пропускается', () => {
    const { runsRoot, projectRoot } = makeJournalBed();
    seedRun(runsRoot, projectRoot, { runId: 'a' });
    writeFileSync(join(projectRoot, 'backlog.md'), backlogText(item('only', BASE)));

    // Указатель портится вручную: запись о проекте снимается, каталог прогона остаётся.
    const indexPath = join(runsRoot, 'projects.json');
    const index = JSON.parse(readFileSync(indexPath, 'utf8')) as Record<string, unknown>;
    delete index[projectKey(projectRoot)];
    writeFileSync(indexPath, JSON.stringify(index));

    const overview = buildOverview(runsRoot);
    assert.equal(overview.projects[0]?.path, undefined, 'обзор обязан остаться без пути');

    const backlog = buildBacklog(overview);
    assert.deepEqual(backlog.projects, [], 'без пути читать очередь неоткуда');
  });

  it('проект без единого прогона в вид не попадает, даже если каталог существует', () => {
    const { runsRoot } = makeJournalBed();
    // Пустой каталог проекта (без вложенных каталогов прогонов) buildOverview
    // уже отбрасывает — до buildBacklog он не доходит вовсе.
    mkdirSync(join(runsRoot, 'пустой-проект'), { recursive: true });

    const backlog = buildBacklog(buildOverview(runsRoot));
    assert.deepEqual(backlog.projects, []);
  });

  it('пункт без group показан со слагом в качестве действующей группы, пункт без track — с пустой дорожкой', () => {
    const { runsRoot, projectRoot } = makeJournalBed();
    seedRun(runsRoot, projectRoot, { runId: 'a' });
    writeFileSync(join(projectRoot, 'backlog.md'), backlogText(item('lonely', BASE)));

    const backlog = buildBacklog(buildOverview(runsRoot));
    const view = backlog.projects[0]?.items[0];
    assert.equal(view?.group, 'lonely');
    assert.equal(view?.track, '');
    assert.equal(view?.why, 'з');
    assert.equal(view?.doneWhen, 'к');
  });

  it('in_progress несёт момент взятия, failed несёт причину', () => {
    const { runsRoot, projectRoot } = makeJournalBed();
    seedRun(runsRoot, projectRoot, { runId: 'a' });
    writeFileSync(
      join(projectRoot, 'backlog.md'),
      backlogText(
        item('taken', { ...BASE, status: 'in_progress', started_at: '2026-09-01T00:00:00.000Z' }),
        item('failed-one', { ...BASE, status: 'failed', reason: 'сеть недоступна' }),
      ),
    );

    const backlog = buildBacklog(buildOverview(runsRoot));
    const items = backlog.projects[0]?.items ?? [];
    const taken = items.find((entry) => entry.slug === 'taken');
    const failed = items.find((entry) => entry.slug === 'failed-one');

    assert.equal(taken?.status, 'in_progress');
    assert.equal(taken?.startedAt, '2026-09-01T00:00:00.000Z');
    assert.equal(failed?.status, 'failed');
    assert.equal(failed?.reason, 'сеть недоступна');
  });

  it('неразбираемая очередь даёт раздел с объяснением и не отменяет показа соседнего проекта', () => {
    const { runsRoot, projectRoot, home } = makeJournalBed();
    seedRun(runsRoot, projectRoot, { runId: 'a' });
    // Строка без «ключ: значение» внутри пункта — та же беда разбора, что и в ядре.
    writeFileSync(join(projectRoot, 'backlog.md'), `${backlogText(item('broken', BASE))}просто текст\n`);

    const projectRoot2 = makeSecondProject(runsRoot, home);
    writeFileSync(join(projectRoot2, 'backlog.md'), backlogText(item('healthy', BASE)));

    const backlog = buildBacklog(buildOverview(runsRoot));
    assert.equal(backlog.projects.length, 2);

    const broken = backlog.projects.find((project) => project.projectPath === projectRoot);
    assert.equal(broken?.items.length, 0);
    assert.equal(typeof broken?.error, 'string');
    assert.equal(broken?.errorFile, 'backlog.md');
    assert.equal(broken?.errorAt, 'broken');

    const healthy = backlog.projects.find((project) => project.projectPath === projectRoot2);
    assert.equal(healthy?.error, undefined);
    assert.deepEqual(
      healthy?.items.map((entry) => entry.slug),
      ['healthy'],
      'отказ разбора одного проекта не должен отменять показ другого',
    );
  });

  // Сценарий: «Файл очереди без единого пункта»
  it('файл очереди без пунктов даёт раздел с пустым списком и без отказа', () => {
    const { runsRoot, projectRoot } = makeJournalBed();
    seedRun(runsRoot, projectRoot, { runId: 'a' });
    // Все пункты разобраны в архив: остались заголовок и преамбула.
    writeFileSync(join(projectRoot, 'backlog.md'), backlogText());

    const backlog = buildBacklog(buildOverview(runsRoot));
    assert.equal(backlog.projects.length, 1, 'файл есть — раздел проекта должен быть');
    assert.deepEqual(backlog.projects[0]?.items, []);
    assert.equal(backlog.projects[0]?.error, undefined, 'пустая очередь — не отказ разбора');
  });

  it('пункт с неизвестным полем показан, а не отвергнут', () => {
    const { runsRoot, projectRoot } = makeJournalBed();
    seedRun(runsRoot, projectRoot, { runId: 'a' });
    writeFileSync(join(projectRoot, 'backlog.md'), backlogText(item('odd', { ...BASE, weird_field: 'что-то' })));

    const backlog = buildBacklog(buildOverview(runsRoot));
    assert.deepEqual(
      backlog.projects[0]?.items.map((entry) => entry.slug),
      ['odd'],
    );
  });
});
