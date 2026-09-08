import assert from 'node:assert/strict';
import { appendFileSync, chmodSync, existsSync, readFileSync, statSync } from 'node:fs';
import { describe, it } from 'node:test';

import { projectKey, usageStorePath } from '../src/core/journal/paths.js';
import { readUsage } from '../src/core/journal/reader.js';
import type { RunManifest, RunStatus, UsageReport } from '../src/core/journal/schema.js';
import {
  appendUsageRecord,
  backfillUsageStore,
  catchUpUsageRecords,
  catchUpUsageStore,
  ensureUsageRecord,
  mergeAppendedTail,
  readUsageStore,
  removeUsageRecords,
  selectUsageRecords,
  usageRecord,
  usageRecordAddress,
} from '../src/core/journal/usageStore.js';
import { USAGE_STORE_FORMAT } from '../src/core/journal/format.js';
import { expandPipeline } from '../src/core/pipeline/expand.js';
import { runPipeline } from '../src/core/run/runner.js';
import { makeJournalBed, makeProject, MINIMAL_PIPELINE, seedRun } from './helpers.js';
import { tempDir } from './tmp.js';

function manifestOf(runId: string, projectRoot: string, overrides: Partial<RunManifest> = {}): RunManifest {
  return {
    run_id: runId,
    pipeline: 'demo',
    pipeline_file: `${projectRoot}/stepcast.yml`,
    lock_hash: 'abc',
    project_root: projectRoot,
    workspace: { mode: 'cwd' },
    inputs: {},
    git: {},
    backends: {},
    started_at: '2026-08-01T00:00:00.000Z',
    finished_at: '2026-08-01T00:05:00.000Z',
    status: 'success',
    ...overrides,
  };
}

function statusOf(runId: string, overrides: Partial<RunStatus> = {}): RunStatus {
  return {
    run_id: runId,
    pipeline: 'demo',
    lock_hash: 'abc',
    status: 'success',
    workspace: { mode: 'cwd' },
    inputs: {},
    jobs: [],
    budget: { tokens_used: 0, wallclock_ms: 0 },
    updated_at: '2026-08-01T00:05:00.000Z',
    ...overrides,
  };
}

function usageOf(runId: string, overrides: Partial<UsageReport> = {}): UsageReport {
  return {
    run_id: runId,
    total: { tokens_in: 0, tokens_out: 0, cache_read: 0, cache_write: 0, billable_tokens: 0, wallclock_ms: 0 },
    unreported: [],
    jobs: {},
    ...overrides,
  };
}

describe('usage-store: хранилище расхода', () => {
  // 1.1 — дозапись добавляет строку, не трогая накопленного; чтение отдаёт
  // запись со всеми полями разреза.
  it('дозаписывает запись, не трогая накопленного, и читает её со всеми полями', () => {
    const { runsRoot, projectRoot } = makeJournalBed();
    const key = projectKey(projectRoot);

    const first = usageRecord(
      key,
      manifestOf('run-a', projectRoot),
      statusOf('run-a'),
      usageOf('run-a', {
        total: { tokens_in: 10, tokens_out: 5, cache_read: 0, cache_write: 0, billable_tokens: 15, wallclock_ms: 1000, cost_usd: 1 },
        jobs: {
          build: {
            billable_tokens: 15,
            wallclock_ms: 1000,
            cost_usd: 1,
            steps: {
              write: {
                billable_tokens: 15,
                wallclock_ms: 1000,
                cost_usd: 1,
                attempts: [{ attempt: 1, backend: 'claude', model: 'opus', billable_tokens: 15, wallclock_ms: 1000, cost_usd: 1 }],
              },
            },
          },
        },
      }),
    );
    appendUsageRecord(runsRoot, first);

    const before = readUsageStore(runsRoot);
    assert.equal(before.records.size, 1);

    const second = usageRecord(key, manifestOf('run-b', projectRoot), statusOf('run-b'), usageOf('run-b'));
    appendUsageRecord(runsRoot, second);

    const after = readUsageStore(runsRoot);
    assert.equal(after.records.size, 2);
    const record = after.records.get(`${key}/run-a`);
    assert.ok(record !== undefined);
    assert.equal(record.run_id, 'run-a');
    assert.equal(record.project.key, key);
    assert.equal(record.project.path, projectRoot);
    assert.equal(record.pipeline.name, 'demo');
    assert.equal(record.status, 'success');
    assert.equal(record.started_at, '2026-08-01T00:00:00.000Z');
    assert.equal(record.finished_at, '2026-08-01T00:05:00.000Z');
    assert.equal(record.total.billable_tokens, 15);
    assert.equal(record.total.cost_usd, 1);
    assert.deepEqual(record.jobs['build']?.steps['write'], { billable_tokens: 15, wallclock_ms: 1000, cost_usd: 1 });
  });

  // 1.2 — две записи по одному прогону: чтение отдаёт последнюю, прогон
  // назван один раз.
  it('две записи по одному прогону: побеждает последняя, прогон назван один раз', () => {
    const { runsRoot, projectRoot } = makeJournalBed();
    const key = projectKey(projectRoot);

    appendUsageRecord(runsRoot, usageRecord(key, manifestOf('run-a', projectRoot), statusOf('run-a', { status: 'running' }), usageOf('run-a', { total: { tokens_in: 0, tokens_out: 0, cache_read: 0, cache_write: 0, billable_tokens: 1, wallclock_ms: 1 } })));
    appendUsageRecord(runsRoot, usageRecord(key, manifestOf('run-a', projectRoot), statusOf('run-a', { status: 'success' }), usageOf('run-a', { total: { tokens_in: 0, tokens_out: 0, cache_read: 0, cache_write: 0, billable_tokens: 42, wallclock_ms: 42 } })));

    const { records } = readUsageStore(runsRoot);
    assert.equal(records.size, 1);
    const record = records.get(`${key}/run-a`);
    assert.equal(record?.status, 'success');
    assert.equal(record?.total.billable_tokens, 42);
  });

  // 1.3 — хвост без перевода строки и неразбираемая строка пропускаются,
  // остальные читаются, число испорченных названо.
  it('пропускает оборванный хвост и неразбираемую строку, считая их', () => {
    const { runsRoot, projectRoot } = makeJournalBed();
    const key = projectKey(projectRoot);
    appendUsageRecord(runsRoot, usageRecord(key, manifestOf('good', projectRoot), statusOf('good'), usageOf('good')));

    const path = usageStorePath(runsRoot);
    appendFileSync(path, 'не json вовсе\n');
    appendFileSync(path, '{"run_id": "torn", "project": {"key": "x"'); // без перевода строки, оборван

    const { records, corrupted } = readUsageStore(runsRoot);
    assert.equal(records.size, 1);
    assert.equal(corrupted, 2);
  });

  // 1.4 — незнакомое поле не теряет запись; версия новее читателя читается с
  // пометкой о расхождении.
  it('незнакомое поле сохраняется, версия новее читателя читается с пометкой', () => {
    const { runsRoot, projectRoot } = makeJournalBed();
    const key = projectKey(projectRoot);
    const base = usageRecord(key, manifestOf('run-a', projectRoot), statusOf('run-a'), usageOf('run-a'));
    const path = usageStorePath(runsRoot);

    appendFileSync(path, `${JSON.stringify({ ...base, run_id: 'with-extra', future_field: 'зюйд-вест' })}\n`);
    appendFileSync(path, `${JSON.stringify({ ...base, run_id: 'from-future', format: USAGE_STORE_FORMAT + 1 })}\n`);

    const { records, versionSkew } = readUsageStore(runsRoot);
    const withExtra = records.get(`${key}/with-extra`) as unknown as Record<string, unknown>;
    assert.equal(withExtra['future_field'], 'зюйд-вест');
    assert.equal(records.get(`${key}/from-future`)?.run_id, 'from-future');
    assert.equal(versionSkew, 1);
  });

  // 1.5 — запись несёт итог, разрез по работам/шагам/моделям; несообщённая
  // цена отсутствует, число попыток без цены названо; доли моделей сходятся
  // с итогом, включая случай суммы попыток больше итога.
  it('несообщённая цена отсутствует, а доли моделей сходятся с итогом (включая перенесённую попытку)', () => {
    const { projectRoot } = makeJournalBed();
    const key = projectKey(projectRoot);

    const noPrice = usageRecord(
      key,
      manifestOf('no-price', projectRoot),
      statusOf('no-price'),
      usageOf('no-price', {
        total: { tokens_in: 0, tokens_out: 0, cache_read: 0, cache_write: 0, billable_tokens: 100, wallclock_ms: 100 },
        jobs: {
          build: {
            billable_tokens: 100,
            wallclock_ms: 100,
            steps: {
              write: {
                billable_tokens: 100,
                wallclock_ms: 100,
                attempts: [{ attempt: 1, backend: 'claude', model: 'opus', billable_tokens: 100, wallclock_ms: 100 }],
              },
            },
          },
        },
      }),
    );
    assert.equal(noPrice.total.cost_usd, undefined);
    assert.equal(noPrice.cost_unreported_attempts, 1);
    assert.equal(noPrice.models['opus']?.cost_usd, undefined);
    assert.equal(noPrice.models['opus']?.billable_tokens, 100);

    // Сумма попыток шага (2000) вдвое больше итога прогона (1000) —
    // перенесённая попытка продолженного шага не входит в итог.
    const overgrown = usageRecord(
      key,
      manifestOf('overgrown', projectRoot),
      statusOf('overgrown'),
      usageOf('overgrown', {
        total: { tokens_in: 0, tokens_out: 0, cache_read: 0, cache_write: 0, billable_tokens: 1000, wallclock_ms: 1000, cost_usd: 10 },
        jobs: {
          build: {
            billable_tokens: 2000,
            wallclock_ms: 1000,
            cost_usd: 20,
            steps: {
              write: {
                billable_tokens: 2000,
                wallclock_ms: 1000,
                cost_usd: 20,
                attempts: [
                  { attempt: 1, backend: 'claude', model: 'opus', billable_tokens: 1500, wallclock_ms: 700, cost_usd: 15 },
                  { attempt: 2, backend: 'claude', model: 'sonnet', billable_tokens: 500, wallclock_ms: 300, cost_usd: 5 },
                ],
              },
            },
          },
        },
      }),
    );
    const sumTokens = Object.values(overgrown.models).reduce((sum, m) => sum + m.billable_tokens, 0);
    const sumCost = Object.values(overgrown.models).reduce((sum, m) => sum + (m.cost_usd ?? 0), 0);
    assert.equal(sumTokens, overgrown.total.billable_tokens);
    assert.equal(sumCost, overgrown.total.cost_usd);
    assert.equal(overgrown.models['opus']?.billable_tokens, 750);
    assert.equal(overgrown.models['sonnet']?.billable_tokens, 250);
  });

  // 1.6 — перенос дописывает записи прогонам на диске, которых нет в
  // хранилище, включая застрявший в running; повторный перенос второй строки
  // не добавляет.
  it('перенос дописывает прогоны с диска, включая застрявший в running, и не повторяется', () => {
    const { runsRoot, projectRoot } = makeJournalBed();
    const key = projectKey(projectRoot);
    seedRun(runsRoot, projectRoot, {
      runId: 'finished',
      usage: usageOf('finished', { total: { tokens_in: 0, tokens_out: 0, cache_read: 0, cache_write: 0, billable_tokens: 7, wallclock_ms: 7 } }),
    });
    seedRun(runsRoot, projectRoot, {
      runId: 'stuck',
      status: 'running',
      usage: usageOf('stuck', { total: { tokens_in: 0, tokens_out: 0, cache_read: 0, cache_write: 0, billable_tokens: 3, wallclock_ms: 3 } }),
    });

    backfillUsageStore(runsRoot);
    const { records } = readUsageStore(runsRoot);
    assert.equal(records.size, 2);
    assert.equal(records.get(`${key}/finished`)?.status, 'success');
    assert.equal(records.get(`${key}/stuck`)?.status, 'running');

    const sizeBefore = statSync(usageStorePath(runsRoot)).size;
    backfillUsageStore(runsRoot);
    const sizeAfter = statSync(usageStorePath(runsRoot)).size;
    assert.equal(sizeBefore, sizeAfter, 'повторный перенос не должен дописывать строк');
  });

  // Сценарий «Прогон появился после первого переноса»: `backfillUsageStore`
  // защищён защёлкой на весь процесс, а прогон, появившийся на диске после
  // неё, обязан дойти до хранилища через догон — без него отбор витрины на
  // демоне, поднятом давно, его не увидит никогда (design.md, Решение 1).
  it('перенос уже был в этом процессе — догон дописывает прогон, появившийся после него', () => {
    const { runsRoot, projectRoot } = makeJournalBed();
    const key = projectKey(projectRoot);
    backfillUsageStore(runsRoot);

    seedRun(runsRoot, projectRoot, {
      runId: 'после-переноса',
      usage: usageOf('после-переноса', { total: { tokens_in: 0, tokens_out: 0, cache_read: 0, cache_write: 0, billable_tokens: 5, wallclock_ms: 5 } }),
    });
    assert.equal(
      readUsageStore(runsRoot).records.has(`${key}/после-переноса`),
      false,
      'сам по себе прогон в хранилище не появляется — только через перенос',
    );

    catchUpUsageStore(runsRoot);

    const { records } = readUsageStore(runsRoot);
    const record = records.get(`${key}/после-переноса`);
    assert.ok(record !== undefined, 'догон обязан дописать появившийся прогон');
    assert.equal(record.total.billable_tokens, 5);
  });

  // Сценарий «Догон сужен проектом».
  it('догон, сужённый проектом, дописывает только его и не трогает чужого', () => {
    const { runsRoot, projectRoot } = makeJournalBed();
    const other = makeJournalBed();
    const key = projectKey(projectRoot);
    const otherKey = projectKey(other.projectRoot);
    seedRun(runsRoot, projectRoot, { runId: 'свой' });
    seedRun(runsRoot, other.projectRoot, { runId: 'чужой' });

    catchUpUsageStore(runsRoot, { project: key });

    const { records } = readUsageStore(runsRoot);
    assert.ok(records.has(`${key}/свой`));
    assert.equal(records.has(`${otherKey}/чужой`), false, 'догон, сужённый проектом, чужого не касается');
  });

  // Сценарий «Догон ничего не портит».
  it('догон не переписывает и не удаляет прежних строк хранилища и не трогает каталогов', () => {
    const { runsRoot, projectRoot } = makeJournalBed();
    const journal = seedRun(runsRoot, projectRoot, { runId: 'a' });
    backfillUsageStore(runsRoot);
    const before = readFileSync(usageStorePath(runsRoot), 'utf8');

    catchUpUsageStore(runsRoot);

    assert.equal(readFileSync(usageStorePath(runsRoot), 'utf8'), before, 'догон без нового на диске не меняет файла');
    assert.ok(existsSync(journal.paths.dir));
    assert.ok(existsSync(journal.paths.manifest));
  });

  // Догон по явному списку адресов: областью служит сам список — обходить
  // корень незачем, когда прогоны названы поимённо.
  it('догон по списку адресов дописывает названные прогоны и не касается прочих', () => {
    const { runsRoot, projectRoot } = makeJournalBed();
    const key = projectKey(projectRoot);
    seedRun(runsRoot, projectRoot, { runId: 'названный' });
    seedRun(runsRoot, projectRoot, { runId: 'прочий' });

    catchUpUsageRecords(runsRoot, [{ key, runId: 'названный' }]);

    const { records } = readUsageStore(runsRoot);
    assert.ok(records.has(`${key}/названный`), 'названный прогон обязан дойти до хранилища');
    assert.equal(records.has(`${key}/прочий`), false, 'неназванный прогон догон не обходит');
  });

  // Догон дописывает производное и зовётся с путей, которые сами по себе —
  // чтение (отбор витрины). Отказ дозаписи обязан выродить его в «без свежих
  // записей», а неброситься в вызывающего: маршруты витрины синхронны, и
  // исключение отсюда уронило бы демона целиком.
  it('догон переживает отказ дозаписи молча — обеими своими формами', () => {
    const { runsRoot, projectRoot } = makeJournalBed();
    const key = projectKey(projectRoot);
    seedRun(runsRoot, projectRoot, { runId: 'a' });

    // Корень без права на запись: завести в нём `usage.ndjson` нельзя, а
    // читать каталоги прогонов по-прежнему можно.
    chmodSync(runsRoot, 0o500);
    try {
      catchUpUsageStore(runsRoot);
      catchUpUsageStore(runsRoot, { project: key });
      catchUpUsageRecords(runsRoot, [{ key, runId: 'a' }]);
    } finally {
      chmodSync(runsRoot, 0o700);
    }

    assert.equal(existsSync(usageStorePath(runsRoot)), false, 'записать было нечем и нечего');
  });

  // Сценарий «Повторный догон впустую».
  it('повторный догон при неизменном диске не дописывает ничего', () => {
    const { runsRoot, projectRoot } = makeJournalBed();
    seedRun(runsRoot, projectRoot, { runId: 'a' });

    catchUpUsageStore(runsRoot);
    const sizeBefore = statSync(usageStorePath(runsRoot)).size;
    catchUpUsageStore(runsRoot);
    const sizeAfter = statSync(usageStorePath(runsRoot)).size;

    assert.equal(sizeBefore, sizeAfter, 'второй вызов подряд не должен дописывать строк');
  });

  // 1.7 — снятие по возрасту/исходу/проекту снимает только отобранное, не
  // трогая каталогов; снятие без признаков не снимает ничего; запись,
  // дописанная во время снятия, остаётся.
  it('снятие по признакам не трогает каталогов и не снимает без единого признака', () => {
    const { runsRoot, projectRoot } = makeJournalBed();
    const key = projectKey(projectRoot);
    const old = seedRun(runsRoot, projectRoot, {
      runId: 'old-failed',
      status: 'failed',
      manifest: { started_at: '2020-01-01T00:00:00.000Z', finished_at: '2020-01-01T00:05:00.000Z' },
    });
    seedRun(runsRoot, projectRoot, { runId: 'recent-ok', status: 'success' });
    backfillUsageStore(runsRoot);

    const byAge = selectUsageRecords(runsRoot, { olderThanMs: 1000 * 60 * 60 * 24 * 365 });
    assert.deepEqual(byAge.map((s) => s.address), [`${key}/old-failed`]);

    const byOutcome = selectUsageRecords(runsRoot, { failed: true });
    assert.deepEqual(byOutcome.map((s) => s.address), [`${key}/old-failed`]);

    const byProject = selectUsageRecords(runsRoot, { failed: true }, { project: key });
    assert.equal(byProject.length, 1);

    const withoutTraits = selectUsageRecords(runsRoot, {});
    assert.equal(withoutTraits.length, 0);

    // Снятие не трогает каталоги прогонов.
    removeUsageRecords(runsRoot, [`${key}/old-failed`]);
    assert.ok(existsSync(old.paths.dir));
    const { records } = readUsageStore(runsRoot);
    assert.equal(records.has(`${key}/old-failed`), false);
    assert.ok(records.has(`${key}/recent-ok`));
  });

  // Догон хвоста — часть снятия, которая имеет дело с состязанием во
  // времени (другой прогон дописывает свою запись, пока снятие уже читает
  // файл для отбора); проверяется как чистое преобразование двух срезов
  // содержимого файла, а не воспроизведением настоящей гонки потоков.
  it('mergeAppendedTail отдаёт хвост, дописанный после исходного чтения, и ничего — когда его нет', () => {
    const before = '{"a":1}\n';
    const appended = `${before}{"a":2}\n`;
    assert.equal(mergeAppendedTail(before, appended), '{"a":2}\n');
    assert.equal(mergeAppendedTail(before, before), '');
  });

  it('запись, дописанная во время снятия, остаётся: снятие учитывает содержимое файла на момент замены', () => {
    const { runsRoot, projectRoot } = makeJournalBed();
    const key = projectKey(projectRoot);
    appendUsageRecord(runsRoot, usageRecord(key, manifestOf('a', projectRoot), statusOf('a'), usageOf('a')));

    removeUsageRecords(runsRoot, [`${key}/a`]);
    // Прогон, чья запись дописана уже после снятия, из хранилища не пропадает
    // (обычный путь дозаписи, независимый от снятия).
    appendUsageRecord(runsRoot, usageRecord(key, manifestOf('b', projectRoot), statusOf('b'), usageOf('b')));

    const { records } = readUsageStore(runsRoot);
    assert.ok(records.has(`${key}/b`));
    assert.equal(records.has(`${key}/a`), false);
  });

  it('ensureUsageRecord пишет запись из каталога прогона, если её ещё нет, и не дублирует', () => {
    const { runsRoot, projectRoot } = makeJournalBed();
    const key = projectKey(projectRoot);
    const journal = seedRun(runsRoot, projectRoot, { runId: 'a' });

    ensureUsageRecord(runsRoot, key, 'a');
    ensureUsageRecord(runsRoot, key, 'a');

    const { records } = readUsageStore(runsRoot);
    assert.equal(records.size, 1);
    assert.ok(records.has(`${key}/a`));
    void journal;
  });

  // Сценарий спеки usage-store «Испорченная запись чинится переносом».
  it('перенос дописывает запись прогона, чья строка в хранилище испорчена, пока каталог цел', () => {
    const { runsRoot, projectRoot } = makeJournalBed();
    const key = projectKey(projectRoot);
    seedRun(runsRoot, projectRoot, {
      runId: 'битый',
      usage: usageOf('битый', {
        total: { tokens_in: 0, tokens_out: 0, cache_read: 0, cache_write: 0, billable_tokens: 9, wallclock_ms: 9 },
      }),
    });

    // Строка прогона в хранилище есть, но оборвана на середине — обрыв
    // процесса на дозаписи. Читателю она невидима, а каталог прогона цел.
    const record = usageRecord(key, manifestOf('битый', projectRoot), statusOf('битый'), usageOf('битый'));
    const torn = JSON.stringify(record).slice(0, 40);
    appendFileSync(usageStorePath(runsRoot), `${torn}\n`);
    const before = readUsageStore(runsRoot);
    assert.equal(before.records.size, 0, 'испорченная строка записью не считается');
    assert.equal(before.corrupted, 1);

    backfillUsageStore(runsRoot);

    const after = readUsageStore(runsRoot);
    const repaired = after.records.get(`${key}/битый`);
    assert.ok(repaired !== undefined, 'перенос обязан дописать запись заново');
    assert.equal(repaired.total.billable_tokens, 9);
    assert.equal(after.corrupted, 1, 'испорченная строка остаётся на месте — стирать нечего, адреса у неё нет');
  });

  // Проект — область отбора и сам по себе признак: «снять статистику вот
  // этого проекта» иначе не выражалось бы вовсе (найдено ревью).
  it('названный проект отбирает свою область целиком и не выходит за неё', () => {
    const { runsRoot, projectRoot } = makeJournalBed();
    const key = projectKey(projectRoot);
    const other = makeJournalBed();
    const otherKey = projectKey(other.projectRoot);

    seedRun(runsRoot, projectRoot, { runId: 'свой-успешный', status: 'success' });
    seedRun(runsRoot, projectRoot, { runId: 'свой-отказавший', status: 'failed' });
    seedRun(runsRoot, other.projectRoot, { runId: 'чужой', status: 'failed' });
    backfillUsageStore(runsRoot);

    const wholeProject = selectUsageRecords(runsRoot, {}, { project: key });
    assert.deepEqual(
      wholeProject.map((entry) => entry.address).sort(),
      [`${key}/свой-отказавший`, `${key}/свой-успешный`],
      'проект без прочих признаков отбирает свою область целиком',
    );

    const narrowed = selectUsageRecords(runsRoot, { failed: true }, { project: key });
    assert.deepEqual(
      narrowed.map((entry) => entry.address),
      [`${key}/свой-отказавший`],
      'исход сужает область, а не расширяет её до чужих проектов',
    );
    assert.equal(
      readUsageStore(runsRoot).records.has(`${otherKey}/чужой`),
      true,
      'запись чужого проекта в хранилище есть — и в отбор не попала',
    );

    assert.deepEqual(selectUsageRecords(runsRoot, {}), [], 'совсем без признаков не отбирается ничего');
  });

  it('пустое хранилище читается без ошибки, когда файла ещё нет', () => {
    const { runsRoot } = makeJournalBed();
    const { records, corrupted, versionSkew } = readUsageStore(runsRoot);
    assert.equal(records.size, 0);
    assert.equal(corrupted, 0);
    assert.equal(versionSkew, 0);
  });

  it('usageRecordAddress строит адрес из ключа проекта и идентификатора прогона', () => {
    const { projectRoot } = makeJournalBed();
    const key = projectKey(projectRoot);
    const record = usageRecord(key, manifestOf('run-x', projectRoot), statusOf('run-x'), usageOf('run-x'));
    assert.equal(usageRecordAddress(record), `${key}/run-x`);
  });
});

describe('usage-store: движок дописывает запись по завершении прогона', () => {
  it('прогон, завершившийся любым исходом, получает строку в хранилище с величинами своего usage.json', async () => {
    const project = makeProject({ 'stepcast.yml': MINIMAL_PIPELINE });
    const runsRoot = tempDir('runs-');
    const expanded = expandPipeline({ pipelinePath: project.path('stepcast.yml'), config: project.config });

    const result = await runPipeline({
      expanded,
      config: { ...project.config, runs: { ...project.config.runs, root: runsRoot } },
      projectRoot: project.root,
      cwd: project.root,
    });

    const key = projectKey(project.root);
    const { records } = readUsageStore(runsRoot);
    const record = records.get(`${key}/${result.journal.paths.runId}`);
    assert.ok(record !== undefined, 'завершённый прогон обязан получить запись в хранилище');
    assert.equal(record.status, result.status);

    const onDisk = readUsage(result.journal.paths);
    assert.equal(record.total.billable_tokens, onDisk.total.billable_tokens);
    assert.equal(record.total.wallclock_ms, onDisk.total.wallclock_ms);
  });

  it('у идущего прогона записи в хранилище нет', async () => {
    const project = makeProject({ 'stepcast.yml': MINIMAL_PIPELINE });
    const runsRoot = tempDir('runs-');
    const expanded = expandPipeline({ pipelinePath: project.path('stepcast.yml'), config: project.config });
    const key = projectKey(project.root);

    let sawRunning = false;
    let runId: string | undefined;
    await runPipeline({
      expanded,
      config: { ...project.config, runs: { ...project.config.runs, root: runsRoot } },
      projectRoot: project.root,
      cwd: project.root,
      onEvent: (event) => {
        if (event.kind === 'run.started') runId = event.run_id;
        if (event.kind !== 'job.started' || runId === undefined) return;
        sawRunning = true;
        const { records } = readUsageStore(runsRoot);
        assert.equal(records.has(`${key}/${runId}`), false);
      },
    });
    assert.ok(sawRunning, 'сценарий обязан застать прогон идущим хотя бы раз');
  });
});
