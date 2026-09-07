import assert from 'node:assert/strict';
import { readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { createWatcher } from '../src/ui/watcher.js';
import { cleanupRun, removeRunWithStats } from '../src/core/run/cleanup.js';
import { projectKey } from '../src/core/journal/paths.js';
import { removeUsageRecords } from '../src/core/journal/usageStore.js';
import type { BacklogOverview } from '../src/ui/backlog.js';
import type { Overview } from '../src/ui/overview.js';
import { makeJournalBed, seedRun } from './helpers.js';

/** Минимальный, но валидный текст очереди с одним пунктом. */
function backlogText(status: string): string {
  return `# Очередь\n\n## work-item\n\nstatus: ${status}\ntitle: т\nwhy: з\ndone_when: к\n`;
}

describe('ui-dashboard: наблюдатель за корнем прогонов', () => {
  // Сценарий: «Новый прогон появляется сам»
  it('доводит до слушателя прогон, появившийся после старта наблюдения', () => {
    const { runsRoot, projectRoot } = makeJournalBed();
    const watcher = createWatcher({ runsRoot, intervalMs: 10_000 });

    const seen: Overview[] = [];
    watcher.subscribe((overview) => seen.push(overview));

    assert.deepEqual(watcher.current().projects, [], 'до прогонов обзор пуст');

    seedRun(runsRoot, projectRoot, { runId: 'новый' });
    watcher.poll();

    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.projects[0]?.runs[0]?.runId, 'новый');
    watcher.dispose();
  });

  it('не уведомляет, когда ничего не изменилось', () => {
    const { runsRoot, projectRoot } = makeJournalBed();
    seedRun(runsRoot, projectRoot, { runId: 'a' });

    const watcher = createWatcher({ runsRoot, intervalMs: 10_000 });
    let calls = 0;
    watcher.subscribe(() => (calls += 1));

    watcher.poll();
    watcher.poll();
    watcher.poll();

    assert.equal(calls, 0, 'неизменившийся корень не должен порождать уведомлений');
    watcher.dispose();
  });

  // Сценарий: «Несколько открытых вкладок»
  it('раздаёт один и тот же обзор всем слушателям', () => {
    const { runsRoot, projectRoot } = makeJournalBed();
    const watcher = createWatcher({ runsRoot, intervalMs: 10_000 });

    const first: Overview[] = [];
    const second: Overview[] = [];
    watcher.subscribe((overview) => first.push(overview));
    watcher.subscribe((overview) => second.push(overview));

    seedRun(runsRoot, projectRoot, { runId: 'a' });
    watcher.poll();

    assert.equal(first.length, 1);
    assert.equal(second.length, 1);
    assert.equal(first[0], second[0], 'обзор собирается один раз на всех');
    watcher.dispose();
  });

  it('замечает изменение состояния прогона', () => {
    const { runsRoot, projectRoot } = makeJournalBed();
    const journal = seedRun(runsRoot, projectRoot, { runId: 'a', status: 'running' });

    const watcher = createWatcher({ runsRoot, intervalMs: 10_000 });
    const seen: Overview[] = [];
    watcher.subscribe((overview) => seen.push(overview));

    journal.writeStatus({
      run_id: journal.paths.runId,
      pipeline: 'demo',
      lock_hash: 'abc',
      status: 'success',
      workspace: { mode: 'cwd' },
      inputs: {},
      jobs: [],
      budget: { tokens_used: 0, wallclock_ms: 0 },
      updated_at: '2026-08-01T01:00:00.000Z',
    });
    watcher.poll();

    assert.equal(seen.at(-1)?.projects[0]?.runs[0]?.status, 'success');
    watcher.dispose();
  });

  /**
   * Найдено ручной проверкой: `gc` сносит содержимое прогона, не трогая
   * `status.json`, поэтому отпечаток по одному лишь mtime состояния уборку не
   * замечал — и обзор навсегда оставался с устаревшим признаком.
   */
  it('замечает уборку прогона, которая не меняет состояние', () => {
    const { runsRoot, projectRoot } = makeJournalBed();
    const journal = seedRun(runsRoot, projectRoot, { runId: 'a', artifacts: { build: {} } });

    const watcher = createWatcher({ runsRoot, intervalMs: 10_000 });
    const seen: Overview[] = [];
    watcher.subscribe((overview) => seen.push(overview));

    assert.equal(watcher.current().projects[0]?.runs[0]?.swept, false);

    cleanupRun(journal.paths);
    watcher.poll();

    assert.equal(seen.length, 1, 'уборка должна дойти до клиента');
    assert.equal(seen[0]?.projects[0]?.runs[0]?.swept, true);
    watcher.dispose();
  });

  /**
   * Найдено ревью: у прогона без файлов каталога нет вовсе, и он живёт в
   * обзоре одной лишь записью хранилища. Пока отпечаток перечислял только
   * каталоги, снятие такой записи (`DELETE /api/usage-records`,
   * `stepcast gc --stats`) отпечатка не меняло, и снятый прогон оставался на
   * экране и в разрезе расхода до первого изменения какого-нибудь каталога.
   */
  it('замечает появление и снятие записи хранилища у прогона без файлов', () => {
    const { runsRoot, projectRoot } = makeJournalBed();
    const key = projectKey(projectRoot);
    seedRun(runsRoot, projectRoot, { runId: 'a' });
    seedRun(runsRoot, projectRoot, { runId: 'b' });

    const watcher = createWatcher({ runsRoot, intervalMs: 10_000 });
    const seen: Overview[] = [];
    watcher.subscribe((overview) => seen.push(overview));

    // Файлы сняты, статистика сохранена: каталога у прогона больше нет, но в
    // обзоре он остаётся записью.
    removeRunWithStats(runsRoot, key, 'a');
    watcher.poll();
    const afterRemoval = seen.at(-1)?.projects[0]?.runs.find((run) => run.runId === 'a');
    assert.equal(afterRemoval?.filesGone, true, 'прогон без файлов обязан остаться в обзоре записью');

    const before = seen.length;
    removeUsageRecords(runsRoot, [`${key}/a`]);
    watcher.poll();

    assert.ok(seen.length > before, 'снятие записи обязано дойти до клиента');
    assert.equal(
      seen.at(-1)?.projects[0]?.runs.some((run) => run.runId === 'a'),
      false,
      'снятый прогон обязан пропасть из обзора',
    );
    watcher.dispose();
  });

  it('отписка и dispose прекращают уведомления', () => {
    const { runsRoot, projectRoot } = makeJournalBed();
    const watcher = createWatcher({ runsRoot, intervalMs: 10_000 });

    let calls = 0;
    const unsubscribe = watcher.subscribe(() => (calls += 1));

    seedRun(runsRoot, projectRoot, { runId: 'a' });
    watcher.poll();
    assert.equal(calls, 1);

    unsubscribe();
    seedRun(runsRoot, projectRoot, { runId: 'b' });
    watcher.poll();
    assert.equal(calls, 1, 'отписавшийся слушатель больше не вызывается');

    watcher.subscribe(() => (calls += 1));
    watcher.dispose();
    seedRun(runsRoot, projectRoot, { runId: 'c' });
    watcher.poll();
    assert.equal(calls, 1, 'после dispose слушателей не остаётся');
  });

  // Сценарий: «Отказ разбора назван в логе» + «Строка не повторяется на
  // каждом опросе» + «Расхождение версий называет лекарство»
  it('печатает одну строку на беду за жизнь демона и называет лекарство при расхождении версий', () => {
    const { runsRoot, projectRoot } = makeJournalBed();
    const journal = seedRun(runsRoot, projectRoot, { runId: 'skewed' });

    const raw = JSON.parse(readFileSync(journal.paths.manifest, 'utf8')) as Record<string, unknown>;
    raw.bogus_field = 'x';
    writeFileSync(journal.paths.manifest, `${JSON.stringify(raw, null, 2)}\n`);

    const lines: string[] = [];
    const watcher = createWatcher({ runsRoot, intervalMs: 10_000, log: (line) => lines.push(line) });

    // Несколько пересборок подряд: status.json переписывается и получает
    // новую mtime, отпечаток корня меняется, обзор собирается заново — но
    // беда run.json от этого не меняется.
    for (let i = 1; i <= 3; i += 1) {
      journal.writeStatus({
        run_id: journal.paths.runId,
        pipeline: 'demo',
        lock_hash: 'abc',
        status: 'success',
        workspace: { mode: 'cwd' },
        inputs: {},
        jobs: [],
        budget: { tokens_used: 0, wallclock_ms: 0 },
        updated_at: '2026-08-01T01:00:00.000Z',
      });
      const bumped = new Date(2026, 7, 1, 0, i, 0);
      utimesSync(journal.paths.status, bumped, bumped);
      watcher.poll();
    }

    assert.equal(lines.length, 1, 'беда должна быть названа один раз, а не на каждую пересборку');
    assert.match(lines[0] ?? '', /skewed/);
    assert.match(lines[0] ?? '', /run\.json/);
    assert.match(lines[0] ?? '', /bogus_field/);
    assert.match(lines[0] ?? '', /версия журнала/);
    assert.match(lines[0] ?? '', /версия читателя/);
    assert.match(lines[0] ?? '', /stepcast down && stepcast up/);
    watcher.dispose();
  });

  /**
   * Найдено ревью: между записью манифеста и первой записью состояния лежат
   * секунды, а опрос идёт раз в секунду. Строка «status.json — файл не
   * найден» о здоровом прогоне легла бы в `~/.stepcast/ui.log` навсегда и
   * обесценила бы правило «одна строка на беду».
   */
  it('не печатает в лог ещё не записанные файлы начинающегося прогона', () => {
    const { runsRoot, projectRoot } = makeJournalBed();
    const journal = seedRun(runsRoot, projectRoot, { runId: 'starting' });
    rmSync(journal.paths.status);
    rmSync(journal.paths.usage, { force: true });

    const lines: string[] = [];
    const watcher = createWatcher({ runsRoot, intervalMs: 10_000, log: (line) => lines.push(line) });
    watcher.poll();

    assert.deepEqual(lines, [], 'отсутствие ещё не записанного файла отказом разбора не является');
    watcher.dispose();
  });

  it('печатает отказ разбора сводки расхода', () => {
    const { runsRoot, projectRoot } = makeJournalBed();
    const journal = seedRun(runsRoot, projectRoot, { runId: 'usage-broken' });

    const raw = JSON.parse(readFileSync(journal.paths.usage, 'utf8')) as Record<string, unknown>;
    raw.bogus_field = 'x';
    writeFileSync(journal.paths.usage, `${JSON.stringify(raw, null, 2)}\n`);

    const lines: string[] = [];
    const watcher = createWatcher({ runsRoot, intervalMs: 10_000, log: (line) => lines.push(line) });

    assert.equal(lines.length, 1, 'сводка расхода — такой же файл журнала, как манифест');
    assert.match(lines[0] ?? '', /usage\.json/);
    assert.match(lines[0] ?? '', /bogus_field/);
    watcher.dispose();
  });

  // Сценарий: «Статус пункта меняется на лету»
  it('правка файла очереди проекта будит подписчика и доводит до него новое содержимое', () => {
    const { runsRoot, projectRoot } = makeJournalBed();
    seedRun(runsRoot, projectRoot, { runId: 'a' });
    const file = join(projectRoot, 'backlog.md');
    writeFileSync(file, backlogText('pending'));

    const watcher = createWatcher({ runsRoot, intervalMs: 10_000 });
    const seen: Array<{ overview: Overview; backlog: BacklogOverview }> = [];
    watcher.subscribe((overview, backlog) => seen.push({ overview, backlog }));

    writeFileSync(file, backlogText('done'));
    watcher.poll();

    assert.equal(seen.length, 1, 'правка очереди должна дойти до подписчика');
    assert.equal(seen[0]?.backlog.projects[0]?.items[0]?.status, 'done');
    watcher.dispose();
  });

  // Сценарий: «Неизменный файл не перечитывается»
  it('такт опроса без изменений подписчика не будит и очередь заново не разбирается', () => {
    const { runsRoot, projectRoot } = makeJournalBed();
    seedRun(runsRoot, projectRoot, { runId: 'a' });
    writeFileSync(join(projectRoot, 'backlog.md'), backlogText('pending'));

    const watcher = createWatcher({ runsRoot, intervalMs: 10_000 });
    const before = watcher.currentBacklog();
    let calls = 0;
    watcher.subscribe(() => (calls += 1));

    watcher.poll();
    watcher.poll();

    assert.equal(calls, 0, 'неизменившийся файл очереди не должен порождать уведомлений');
    assert.equal(
      watcher.currentBacklog(),
      before,
      'без смены отпечатка очередь обязана остаться тем же значением, а не пересобираться заново',
    );
    watcher.dispose();
  });

  // Сценарий: «Изменение прогона не перечитывает очередь»
  it('такт, где изменился прогон, а файл очереди нет, оставляет прежнее значение очереди', () => {
    const { runsRoot, projectRoot } = makeJournalBed();
    seedRun(runsRoot, projectRoot, { runId: 'a' });
    writeFileSync(join(projectRoot, 'backlog.md'), backlogText('pending'));

    const watcher = createWatcher({ runsRoot, intervalMs: 10_000 });
    const before = watcher.currentBacklog();
    const seen: BacklogOverview[] = [];
    watcher.subscribe((_overview, backlog) => seen.push(backlog));

    // Прогон появился, очередь не тронута: отпечаток корня разошёлся, отпечаток
    // очередей — нет.
    seedRun(runsRoot, projectRoot, { runId: 'b' });
    watcher.poll();

    assert.equal(seen.length, 1, 'появление прогона обязано разбудить подписчика');
    assert.equal(
      seen[0],
      before,
      'очередь не менялась — разбирать сотни килобайт заново незачем, значение обязано остаться тем же',
    );
    assert.equal(watcher.currentBacklog(), before);
    watcher.dispose();
  });

  it('проект, впервые появившийся в обзоре, получает свою очередь тем же тактом', () => {
    const { runsRoot, projectRoot } = makeJournalBed();
    // Файл очереди написан до первого прогона: сам по себе он проект в обзоре
    // не заводит, и раздела у него нет, пока прогонов нет.
    writeFileSync(join(projectRoot, 'backlog.md'), backlogText('pending'));

    const watcher = createWatcher({ runsRoot, intervalMs: 10_000 });
    assert.deepEqual(watcher.currentBacklog().projects, [], 'проекта без прогонов в очереди нет');

    seedRun(runsRoot, projectRoot, { runId: 'a' });
    watcher.poll();

    assert.equal(
      watcher.currentBacklog().projects[0]?.items[0]?.slug,
      'work-item',
      'смена состава проектов обзора обязана пересобрать очередь, даже если файлы её не менялись',
    );
    watcher.dispose();
  });

  it('currentBacklog() отдаёт очередь без ожидания следующего опроса', () => {
    const { runsRoot, projectRoot } = makeJournalBed();
    seedRun(runsRoot, projectRoot, { runId: 'a' });
    writeFileSync(join(projectRoot, 'backlog.md'), backlogText('pending'));

    const watcher = createWatcher({ runsRoot, intervalMs: 10_000 });
    assert.equal(watcher.currentBacklog().projects[0]?.items[0]?.slug, 'work-item');
    watcher.dispose();
  });
});
