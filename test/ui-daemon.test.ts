import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  clearRecord,
  daemonPaths,
  describeDaemon,
  isAddressInUse,
  isAlive,
  portBusyError,
  readRecord,
  runningDaemon,
  stopDaemon,
  writeRecord,
} from '../src/ui/daemon.js';
import { StepcastError } from '../src/core/errors.js';

function bed(): ReturnType<typeof daemonPaths> {
  const home = mkdtempSync(join(tmpdir(), 'stepcast-daemon-'));
  mkdirSync(join(home, '.stepcast'), { recursive: true });
  return daemonPaths(home);
}

/** Заведомо свободный pid: такого процесса в системе быть не может. */
const DEAD_PID = 0x7ffffff0;

describe('ui-daemon: жизненный цикл', () => {
  it('записывает и читает сведения о демоне', () => {
    const paths = bed();
    writeRecord(paths, { pid: 4242, port: 7717, started_at: '2026-08-01T00:00:00.000Z' });

    const record = readRecord(paths);
    assert.equal(record?.pid, 4242);
    assert.equal(record?.port, 7717);
    assert.equal(readFileSync(paths.pidFile, 'utf8').includes('7717'), true);
  });

  it('считает текущий процесс живым, а несуществующий — мёртвым', () => {
    assert.equal(isAlive(process.pid), true);
    assert.equal(isAlive(DEAD_PID), false);
  });

  // Сценарий: «Осиротевший pid-файл»
  it('стирает осиротевший pid-файл и не считает демон работающим', () => {
    const paths = bed();
    writeRecord(paths, { pid: DEAD_PID, port: 7717, started_at: '2026-08-01T00:00:00.000Z' });

    assert.equal(runningDaemon(paths), undefined);
    assert.equal(existsSync(paths.pidFile), false, 'осиротевший файл не должен требовать уборки руками');
  });

  // Сценарий: «Демон уже поднят»
  it('распознаёт живого демона по pid-файлу', () => {
    const paths = bed();
    writeRecord(paths, { pid: process.pid, port: 7717, started_at: '2026-08-01T00:00:00.000Z' });

    const running = runningDaemon(paths);
    assert.equal(running?.pid, process.pid);
    assert.deepEqual(describeDaemon(running!), [
      'витрина: http://127.0.0.1:7717',
      `процесс: ${process.pid}, запущен 2026-08-01T00:00:00.000Z`,
    ]);
  });

  it('не спотыкается о повреждённый или отсутствующий pid-файл', () => {
    const paths = bed();
    assert.equal(readRecord(paths), undefined);

    writeFileSync(paths.pidFile, 'не json');
    assert.equal(readRecord(paths), undefined);
    assert.equal(runningDaemon(paths), undefined);

    writeFileSync(paths.pidFile, '{"port": 7717}');
    assert.equal(readRecord(paths), undefined, 'запись без pid бессмысленна');
  });

  // Сценарий: «Останавливать нечего»
  it('остановка без запущенного демона сообщает об этом', () => {
    const paths = bed();
    assert.equal(stopDaemon(paths), 'not-running');

    writeRecord(paths, { pid: DEAD_PID, port: 7717, started_at: '' });
    assert.equal(stopDaemon(paths), 'not-running');
    assert.equal(existsSync(paths.pidFile), false);
  });

  // Сценарий: «Остановка работающего демона»
  it('останавливает живой процесс и стирает pid-файл', async () => {
    const paths = bed();
    const { spawn } = await import('node:child_process');
    // Процесс, который сам не завершится: его должен снять stopDaemon.
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
    });
    const exited = new Promise<void>((done) => child.once('exit', () => done()));

    writeRecord(paths, { pid: child.pid!, port: 7717, started_at: '' });
    assert.equal(stopDaemon(paths), 'stopped');

    await exited;
    assert.equal(existsSync(paths.pidFile), false);
  });

  it('очистка записи безопасна, когда файла нет', () => {
    const paths = bed();
    clearRecord(paths);
    clearRecord(paths);
    assert.equal(existsSync(paths.pidFile), false);
  });

  // Сценарий: «Порт занят посторонним процессом»
  it('опознаёт занятый порт и объясняет, что делать', () => {
    assert.equal(isAddressInUse(Object.assign(new Error('busy'), { code: 'EADDRINUSE' })), true);
    assert.equal(isAddressInUse(new Error('другое')), false);

    const error = portBusyError(7717);
    assert.ok(error instanceof StepcastError);
    assert.match(error.message, /7717/);
    assert.match(error.hint ?? '', /ui\.port/);
  });
});
