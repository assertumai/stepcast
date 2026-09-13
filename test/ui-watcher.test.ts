import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { createWatcher } from '../src/ui/watcher.js';
import { StepcastError } from '../src/core/errors.js';
import { cleanupRun, removeRunWithStats } from '../src/core/run/cleanup.js';
import { projectKey } from '../src/core/journal/paths.js';
import { removeUsageRecords } from '../src/core/journal/usageStore.js';
import { widgetsDirPath } from '../src/ui/widgets.js';
import { homeRoutesPath, projectRoutesPath } from '../src/ui/routesFile.js';
import { homeDashboardsDirPath, projectDashboardsDirPath } from '../src/ui/dashboardsFile.js';
import { proposalsDirPath, proposeEntry, readProposalsDir } from '../src/core/proposals/store.js';
import type { BacklogOverview } from '../src/ui/backlog.js';
import type { Overview } from '../src/ui/overview.js';
import type { WidgetsOverview } from '../src/ui/widgets.js';
import type { ProposalsOverview } from '../src/ui/proposals.js';
import { makeJournalBed, seedRun } from './helpers.js';
import { tempDir } from './tmp.js';

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
    writeFileSync(file, backlogText('todo'));

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
    writeFileSync(join(projectRoot, 'backlog.md'), backlogText('todo'));

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
    writeFileSync(join(projectRoot, 'backlog.md'), backlogText('todo'));

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
    writeFileSync(join(projectRoot, 'backlog.md'), backlogText('todo'));

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
    writeFileSync(join(projectRoot, 'backlog.md'), backlogText('todo'));

    const watcher = createWatcher({ runsRoot, intervalMs: 10_000 });
    assert.equal(watcher.currentBacklog().projects[0]?.items[0]?.slug, 'work-item');
    watcher.dispose();
  });

  // Часть отпечатка `widgets` (design.md изменения `ui-runtime-widget-spike`, Решение 7).
  describe('часть widgets', () => {
    function widgetOf(overview: WidgetsOverview, projectKeyValue: string): readonly { id: string; version: string }[] {
      return overview.projects.find((project) => project.projectKey === projectKeyValue)?.widgets ?? [];
    }

    it('появление файла виджета меняет состав и будит подписчика', () => {
      const { runsRoot, projectRoot } = makeJournalBed();
      seedRun(runsRoot, projectRoot, { runId: 'a' });
      const key = projectKey(projectRoot);
      const dir = widgetsDirPath(projectRoot);
      mkdirSync(dir, { recursive: true });

      const watcher = createWatcher({ runsRoot, intervalMs: 10_000 });
      assert.deepEqual(widgetOf(watcher.currentWidgets(), key), []);
      let calls = 0;
      watcher.subscribe(() => (calls += 1));

      writeFileSync(join(dir, 'clock.tsx'), 'export default function Clock() { return null; }\n');
      watcher.poll();

      assert.equal(calls, 1, 'появление виджета обязано разбудить подписчика');
      assert.deepEqual(
        widgetOf(watcher.currentWidgets(), key).map((w) => w.id),
        ['clock'],
      );
      watcher.dispose();
    });

    it('правка файла виджета меняет его версию', () => {
      const { runsRoot, projectRoot } = makeJournalBed();
      seedRun(runsRoot, projectRoot, { runId: 'a' });
      const key = projectKey(projectRoot);
      const dir = widgetsDirPath(projectRoot);
      mkdirSync(dir, { recursive: true });
      const file = join(dir, 'clock.tsx');
      writeFileSync(file, 'export default function Clock() { return null; }\n');

      const watcher = createWatcher({ runsRoot, intervalMs: 10_000 });
      const before = widgetOf(watcher.currentWidgets(), key)[0]?.version;

      writeFileSync(file, 'export default function Clock() { return 1; }\n');
      const bumped = new Date(Date.now() + 5_000);
      utimesSync(file, bumped, bumped);
      watcher.poll();

      const after = widgetOf(watcher.currentWidgets(), key)[0]?.version;
      assert.notEqual(after, before, 'правка файла обязана сменить версию виджета');
      watcher.dispose();
    });

    it('удаление файла виджета убирает его из состава', () => {
      const { runsRoot, projectRoot } = makeJournalBed();
      seedRun(runsRoot, projectRoot, { runId: 'a' });
      const key = projectKey(projectRoot);
      const dir = widgetsDirPath(projectRoot);
      mkdirSync(dir, { recursive: true });
      const file = join(dir, 'clock.tsx');
      writeFileSync(file, 'export default function Clock() { return null; }\n');

      const watcher = createWatcher({ runsRoot, intervalMs: 10_000 });
      assert.equal(widgetOf(watcher.currentWidgets(), key).length, 1);

      unlinkSync(file);
      watcher.poll();

      assert.deepEqual(widgetOf(watcher.currentWidgets(), key), []);
      watcher.dispose();
    });

    it('такт, на котором сдвинулся только идущий прогон, оставляет тот же объект состава виджетов', () => {
      const { runsRoot, projectRoot } = makeJournalBed();
      const journal = seedRun(runsRoot, projectRoot, { runId: 'a', status: 'running' });
      const dir = widgetsDirPath(projectRoot);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'clock.tsx'), 'export default function Clock() { return null; }\n');

      const watcher = createWatcher({ runsRoot, intervalMs: 10_000 });
      const before = watcher.currentWidgets();

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

      assert.equal(watcher.currentWidgets(), before, 'состав виджетов не должен пересобираться, когда сдвинулся только прогон');
      watcher.dispose();
    });

    it('появление проекта без виджетов даёт ему раздел в составе', () => {
      const { runsRoot, projectRoot } = makeJournalBed();
      seedRun(runsRoot, projectRoot, { runId: 'a' });

      const watcher = createWatcher({ runsRoot, intervalMs: 10_000 });
      const before = watcher.currentWidgets();

      // Ни одного файла виджета у нового проекта нет: состав обязан
      // пересобраться всё равно — иначе экран не покажет его пустым разделом
      // до первой правки какого-нибудь виджета (требование ui-dashboard).
      const other = tempDir('other-project-');
      seedRun(runsRoot, other, { runId: 'b' });
      watcher.poll();

      const after = watcher.currentWidgets();
      assert.notEqual(after, before, 'регистрация проекта обязана пересобрать состав виджетов');
      assert.deepEqual(widgetOf(after, projectKey(other)), []);
      assert.ok(
        after.projects.some((project) => project.projectKey === projectKey(other)),
        'проект без виджетов обязан попасть в состав своим разделом',
      );
      watcher.dispose();
    });

    /**
     * Такт наблюдателя идёт раз в секунду по каждому виджету каждого проекта,
     * и часть отпечатка `widgets` обязана оставаться на `mtime`+размере (план
     * T12): признак устаревания в отпечаток не входит, а читать ради него
     * исходник каждого виджета на каждом опросе — чистая трата. Проверка —
     * по исходнику наблюдателя, а не по числу чтений: связывание импортов
     * `node:fs` происходит один раз при загрузке модуля, и подменить
     * `readFileSync` для уже загруженного модуля нечем.
     */
    it('отпечаток считается дешёвой половиной состава, без чтения исходников виджетов', () => {
      const text = readFileSync(fileURLToPath(new URL('../../src/ui/watcher.ts', import.meta.url)), 'utf8');
      assert.match(text, /projectWidgetVersions\(/);
      assert.doesNotMatch(
        text,
        /buildProjectWidgets\(/,
        'отпечаток обязан считаться projectWidgetVersions: buildProjectWidgets вдобавок читает исходник каждого виджета ради признака устаревания',
      );
    });

    it('правка очереди улучшений не пересобирает состав виджетов', () => {
      const { runsRoot, projectRoot } = makeJournalBed();
      seedRun(runsRoot, projectRoot, { runId: 'a' });
      const dir = widgetsDirPath(projectRoot);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'clock.tsx'), 'export default function Clock() { return null; }\n');
      writeFileSync(join(projectRoot, 'backlog.md'), backlogText('todo'));

      const watcher = createWatcher({ runsRoot, intervalMs: 10_000 });
      const before = watcher.currentWidgets();

      writeFileSync(join(projectRoot, 'backlog.md'), backlogText('done'));
      watcher.poll();

      assert.equal(watcher.currentWidgets(), before, 'состав виджетов не должен пересобираться от правки очереди');
      watcher.dispose();
    });
  });

  describe('часть proposals', () => {
    function recordsOf(overview: ProposalsOverview, projectKeyValue: string): readonly { readonly id: string }[] {
      return overview.projects.find((project) => project.projectKey === projectKeyValue)?.records ?? [];
    }

    it('появление записи очереди предложений меняет состав и будит подписчика', () => {
      const { runsRoot, projectRoot } = makeJournalBed();
      seedRun(runsRoot, projectRoot, { runId: 'a' });
      const key = projectKey(projectRoot);

      const watcher = createWatcher({ runsRoot, intervalMs: 10_000 });
      assert.deepEqual(recordsOf(watcher.currentProposals(), key), []);
      let calls = 0;
      watcher.subscribe(() => (calls += 1));

      proposeEntry(projectRoot, { target: '.stepcast/widgets/clock.tsx', content: 'export default 1;\n' });
      watcher.poll();

      assert.equal(calls, 1, 'новая запись обязана разбудить подписчика');
      assert.equal(recordsOf(watcher.currentProposals(), key).length, 1);
      watcher.dispose();
    });

    it('такт без изменений в каталоге очереди предложений не порождает события', () => {
      const { runsRoot, projectRoot } = makeJournalBed();
      seedRun(runsRoot, projectRoot, { runId: 'a' });
      proposeEntry(projectRoot, { target: '.stepcast/widgets/clock.tsx', content: 'export default 1;\n' });

      const watcher = createWatcher({ runsRoot, intervalMs: 10_000 });
      const before = watcher.currentProposals();
      let calls = 0;
      watcher.subscribe(() => (calls += 1));

      watcher.poll();

      assert.equal(calls, 0, 'такт без изменений не должен будить подписчика');
      assert.equal(watcher.currentProposals(), before);
      watcher.dispose();
    });

    it('такт по каталогу очереди не пишет ни одного файла проекта', () => {
      const { runsRoot, projectRoot } = makeJournalBed();
      seedRun(runsRoot, projectRoot, { runId: 'a' });
      proposeEntry(projectRoot, { target: '.stepcast/widgets/clock.tsx', content: 'export default 1;\n' });

      const before = readProposalsDir(projectRoot);
      const watcher = createWatcher({ runsRoot, intervalMs: 10_000 });
      watcher.poll();
      const after = readProposalsDir(projectRoot);

      assert.deepEqual(after.records, before.records);
      assert.equal(existsSync(join(projectRoot, '.stepcast', 'widgets', 'clock.tsx')), false);
      watcher.dispose();
    });

    it('негодная запись переживает такт наблюдения', () => {
      const { runsRoot, projectRoot } = makeJournalBed();
      seedRun(runsRoot, projectRoot, { runId: 'a' });
      const dir = proposalsDirPath(projectRoot);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'broken.json'), '{not json');

      const watcher = createWatcher({ runsRoot, intervalMs: 10_000 });
      watcher.poll();

      const key = projectKey(projectRoot);
      const invalid = watcher.currentProposals().projects.find((project) => project.projectKey === key)?.invalid ?? [];
      assert.equal(invalid.length, 1);
      assert.ok(existsSync(join(dir, 'broken.json')));
      watcher.dispose();
    });

    it('такт, на котором сдвинулся только идущий прогон, оставляет тот же объект очереди предложений', () => {
      const { runsRoot, projectRoot } = makeJournalBed();
      const journal = seedRun(runsRoot, projectRoot, { runId: 'a', status: 'running' });
      proposeEntry(projectRoot, { target: '.stepcast/widgets/clock.tsx', content: 'export default 1;\n' });

      const watcher = createWatcher({ runsRoot, intervalMs: 10_000 });
      const before = watcher.currentProposals();

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

      assert.equal(
        watcher.currentProposals(),
        before,
        'очередь предложений не должна пересобираться, когда сдвинулся только прогон',
      );
      watcher.dispose();
    });
  });
});

describe('ui-routes: часть отпечатка наблюдателя', () => {
  function writeHomeRoutes(home: string, content: string): void {
    mkdirSync(join(home, '.stepcast'), { recursive: true });
    writeFileSync(homeRoutesPath(home), content);
  }

  function writeProjectRoutes(projectRoot: string, content: string): void {
    mkdirSync(join(projectRoot, '.stepcast'), { recursive: true });
    writeFileSync(projectRoutesPath(projectRoot), content);
  }

  it('правка домашнего файла маршрутов пересобирает таблицу и будит подписчика, не трогая виджеты и очередь', () => {
    const { runsRoot, projectRoot } = makeJournalBed();
    const home = tempDir('routes-watcher-home-');
    writeFileSync(join(projectRoot, 'backlog.md'), backlogText('todo'));

    const watcher = createWatcher({ runsRoot, home, intervalMs: 10_000 });
    const beforeWidgets = watcher.currentWidgets();
    const beforeBacklog = watcher.currentBacklog();
    let calls = 0;
    watcher.subscribe(() => (calls += 1));

    writeHomeRoutes(home, 'routes:\n  - id: screen-cleanup\n    nav:\n      title: Чистка\n');
    watcher.poll();

    assert.equal(calls, 1, 'правка файла маршрутов обязана разбудить подписчика');
    const entry = watcher.currentRoutes().entries.find((candidate) => candidate.id === 'screen-cleanup');
    assert.equal(entry?.definition.nav?.title, 'Чистка');
    assert.equal(watcher.currentWidgets(), beforeWidgets, 'правка routes.yml не должна пересобирать состав виджетов');
    assert.equal(watcher.currentBacklog(), beforeBacklog, 'правка routes.yml не должна перечитывать очередь');
    watcher.dispose();
  });

  it('правка файла маршрутов не перечитывает прогоны', () => {
    const { runsRoot, projectRoot } = makeJournalBed();
    const home = tempDir('routes-watcher-home-');
    seedRun(runsRoot, projectRoot, { runId: 'a' });

    const watcher = createWatcher({ runsRoot, home, intervalMs: 10_000 });
    const beforeOverview = watcher.current();

    writeHomeRoutes(home, 'routes:\n  - id: screen-cleanup\n    nav:\n      title: Чистка\n');
    watcher.poll();

    // Обзор — самая дорогая часть такта (разбор `status.json` каждого
    // прогона корня), и правка `routes.yml` не повод его пересобирать
    // (`ui-routes`, «MUST NOT перечитывать ради неё очередь, виджеты и
    // прогоны»).
    assert.equal(watcher.current(), beforeOverview, 'правка routes.yml не должна перечитывать прогоны');
    assert.equal(watcher.currentRoutes().entries.find((entry) => entry.id === 'screen-cleanup')?.definition.nav?.title, 'Чистка');
    watcher.dispose();
  });

  it('сломанный встроенный файл маршрутов отказывает подъёму витрины, а не поднимает её с пустой таблицей', () => {
    const { runsRoot } = makeJournalBed();
    const home = tempDir('routes-watcher-home-');
    const missing = join(tempDir('routes-builtin-'), 'routes.yml');

    assert.throws(
      () => createWatcher({ runsRoot, home, intervalMs: 10_000, builtinRoutesPath: missing }),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.equal(error.file, missing);
        return true;
      },
    );
  });

  it('сломанный пользовательский файл на первом же подъёме не гасит витрину, а называет причину', () => {
    const { runsRoot } = makeJournalBed();
    const home = tempDir('routes-watcher-home-');
    writeHomeRoutes(home, 'routes:\n  - id: bad\n    bogus: 1\n');

    const watcher = createWatcher({ runsRoot, home, intervalMs: 10_000 });
    assert.match(watcher.currentRoutesError() ?? '', /bogus/);
    assert.deepEqual(watcher.currentRoutes().table, [], 'первая сборка не имеет прежней таблицы, которой можно было бы остаться');
    watcher.dispose();
  });

  it('такт без правки файлов маршрутов оставляет тот же объект таблицы', () => {
    const { runsRoot, projectRoot } = makeJournalBed();
    const home = tempDir('routes-watcher-home-');
    seedRun(runsRoot, projectRoot, { runId: 'a' });

    const watcher = createWatcher({ runsRoot, home, intervalMs: 10_000 });
    const before = watcher.currentRoutes();

    seedRun(runsRoot, projectRoot, { runId: 'b' });
    watcher.poll();

    assert.equal(watcher.currentRoutes(), before, 'таблица маршрутов не должна пересобираться, когда файлы слоя не менялись');
    watcher.dispose();
  });

  it('правка очереди или виджета не меняет таблицу маршрутов', () => {
    const { runsRoot, projectRoot } = makeJournalBed();
    const home = tempDir('routes-watcher-home-');

    const watcher = createWatcher({ runsRoot, home, intervalMs: 10_000 });
    const before = watcher.currentRoutes();

    writeFileSync(join(projectRoot, 'backlog.md'), backlogText('todo'));
    watcher.poll();

    assert.equal(watcher.currentRoutes(), before, 'правка очереди не должна пересобирать таблицу маршрутов');
    watcher.dispose();
  });

  it('проектный слой — только файл каталога проекта, в котором поднят демон', () => {
    const { runsRoot, projectRoot } = makeJournalBed();
    const home = tempDir('routes-watcher-home-');

    const watcher = createWatcher({ runsRoot, home, projectRoot, intervalMs: 10_000 });
    writeProjectRoutes(projectRoot, 'routes:\n  - id: screen-runs\n    path: /elsewhere\n');
    watcher.poll();

    const entry = watcher.currentRoutes().entries.find((candidate) => candidate.id === 'screen-runs');
    assert.equal(entry?.definition.path, '/elsewhere');
    watcher.dispose();
  });

  it('отказ сборки после правки файла не гасит прежнюю действующую таблицу, а называет причину', () => {
    const { runsRoot } = makeJournalBed();
    const home = tempDir('routes-watcher-home-');

    const watcher = createWatcher({ runsRoot, home, intervalMs: 10_000 });
    const before = watcher.currentRoutes();
    assert.equal(watcher.currentRoutesError(), undefined);

    writeHomeRoutes(home, 'routes:\n  - id: bad\n    bogus: 1\n');
    watcher.poll();

    assert.equal(watcher.currentRoutes(), before, 'отказ сборки не должен подменять действующую таблицу');
    assert.match(watcher.currentRoutesError() ?? '', /bogus/);
    watcher.dispose();
  });
});

describe('ui-dashboards: часть отпечатка наблюдателя', () => {
  function writeHomeDashboard(home: string, id: string, content: string): void {
    const dir = homeDashboardsDirPath(home);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${id}.yml`), content);
  }

  function writeProjectDashboard(projectRoot: string, id: string, content: string): void {
    const dir = projectDashboardsDirPath(projectRoot);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${id}.yml`), content);
  }

  const CELL_YAML = 'cells:\n  - id: a\n    widget: runs\n    at: { column: 0, row: 0, width: 4, height: 2 }\n';

  it('правка файла дашборда будит подписчика и доводит новый состав, не трогая маршруты, виджеты и обзор', () => {
    const { runsRoot, projectRoot } = makeJournalBed();
    const home = tempDir('dash-watcher-home-');
    seedRun(runsRoot, projectRoot, { runId: 'a' });

    const watcher = createWatcher({ runsRoot, home, intervalMs: 10_000 });
    const beforeOverview = watcher.current();
    const beforeWidgets = watcher.currentWidgets();
    const beforeRoutes = watcher.currentRoutes();
    let calls = 0;
    watcher.subscribe(() => (calls += 1));

    writeHomeDashboard(home, 'release', CELL_YAML);
    watcher.poll();

    assert.equal(calls, 1, 'правка каталога дашбордов обязана разбудить подписчика');
    assert.equal(watcher.currentDashboards().dashboards.find((d) => d.id === 'release')?.document.cells[0]?.id, 'a');
    assert.equal(watcher.current(), beforeOverview, 'правка дашборда не должна перечитывать прогоны');
    assert.equal(watcher.currentWidgets(), beforeWidgets, 'правка дашборда не должна пересобирать состав виджетов');
    assert.equal(watcher.currentRoutes(), beforeRoutes, 'правка дашборда не должна пересобирать таблицу маршрутов');
    watcher.dispose();
  });

  it('правка файла маршрутов или очереди не пересобирает состав дашбордов', () => {
    const { runsRoot, projectRoot } = makeJournalBed();
    const home = tempDir('dash-watcher-home-');
    writeHomeDashboard(home, 'release', CELL_YAML);

    const watcher = createWatcher({ runsRoot, home, intervalMs: 10_000 });
    const before = watcher.currentDashboards();

    writeFileSync(join(projectRoot, 'backlog.md'), backlogText('todo'));
    watcher.poll();

    assert.equal(watcher.currentDashboards(), before, 'правка очереди не должна пересобирать состав дашбордов');
    watcher.dispose();
  });

  it('такт, где сдвинулся только прогон, оставляет тот же объект состава дашбордов', () => {
    const { runsRoot, projectRoot } = makeJournalBed();
    const home = tempDir('dash-watcher-home-');
    writeHomeDashboard(home, 'release', CELL_YAML);

    const watcher = createWatcher({ runsRoot, home, intervalMs: 10_000 });
    const before = watcher.currentDashboards();

    seedRun(runsRoot, projectRoot, { runId: 'a' });
    watcher.poll();

    assert.equal(watcher.currentDashboards(), before, 'состав дашбордов не должен пересобираться без сдвига своей части отпечатка');
    watcher.dispose();
  });

  it('проектный дашборд перекрывает домашний тем же наблюдателем, что и слои маршрутов', () => {
    const { runsRoot } = makeJournalBed();
    const home = tempDir('dash-watcher-home-');
    const projectRoot = tempDir('dash-watcher-project-');
    writeHomeDashboard(home, 'release', CELL_YAML);

    const watcher = createWatcher({ runsRoot, home, projectRoot, intervalMs: 10_000 });
    writeProjectDashboard(projectRoot, 'release', 'cells: []\n');
    watcher.poll();

    const entry = watcher.currentDashboards().dashboards.find((d) => d.id === 'release');
    assert.equal(entry?.layer, 'project');
    assert.deepEqual(entry?.document.cells, []);
    watcher.dispose();
  });

  it('сломанный файл дашборда едет причиной рядом с исправными, не гася витрину', () => {
    const { runsRoot } = makeJournalBed();
    const home = tempDir('dash-watcher-home-');
    writeHomeDashboard(home, 'release', CELL_YAML);

    const watcher = createWatcher({ runsRoot, home, intervalMs: 10_000 });
    writeHomeDashboard(home, 'broken', 'bogus: 1\ncells: []\n');
    watcher.poll();

    const result = watcher.currentDashboards();
    assert.equal(result.dashboards.some((d) => d.id === 'release'), true);
    const failure = result.failures.find((f) => f.id === 'broken');
    assert.match(failure?.reason ?? '', /bogus/);
    watcher.dispose();
  });

  it('удаление файла дашборда убирает его из действующего состава', () => {
    const { runsRoot } = makeJournalBed();
    const home = tempDir('dash-watcher-home-');
    writeHomeDashboard(home, 'release', CELL_YAML);

    const watcher = createWatcher({ runsRoot, home, intervalMs: 10_000 });
    assert.equal(watcher.currentDashboards().dashboards.length, 1);

    unlinkSync(join(homeDashboardsDirPath(home), 'release.yml'));
    watcher.poll();

    assert.deepEqual(watcher.currentDashboards().dashboards, []);
    watcher.dispose();
  });
});
