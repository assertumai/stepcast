import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { StepcastError } from '../src/core/errors.js';
import { readJobData } from '../src/core/journal/data.js';
import { exec, input, log, output, publish } from '../src/step/index.js';
import { tempDir } from './tmp.js';

/**
 * Библиотека `stepcast/step` работает по одним лишь `STEPCAST_*` (design.md,
 * решение 10) — тест выставляет их сам, как это делает движок в окружении
 * шага, а не запускает настоящий подпроцесс.
 */

/** Каталог работы: `resolved.json`, объявляющий переданные ключи данных. */
function jobDir(declared: readonly string[] = []): string {
  const dir = join(tempDir('step-sdk-job-'), 'jobs', 'работа');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'resolved.json'), JSON.stringify({ id: 'работа', data: declared }));
  return dir;
}

/** Выполнить `fn` с заданными `STEPCAST_*`, восстановив окружение по завершении. */
async function withStepEnv<T>(
  vars: Readonly<Record<string, string | undefined>>,
  fn: () => Promise<T> | T,
): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const name of Object.keys(vars)) previous.set(name, process.env[name]);
  for (const [name, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

describe('step-sdk: input/output/publish/log/exec по переменным окружения', () => {
  it('input() читает и разбирает файл входа', async () => {
    const dir = tempDir('step-sdk-');
    const inputPath = join(dir, 'input.json');
    writeFileSync(inputPath, JSON.stringify({ slug: 'bug-42' }));

    await withStepEnv({ STEPCAST_INPUT: inputPath }, () => {
      assert.deepEqual(input(), { slug: 'bug-42' });
    });
  });

  it('output() пишет файл выхода целиком, повторный вызов заменяет', async () => {
    const dir = tempDir('step-sdk-');
    const outputPath = join(dir, 'output.json');

    await withStepEnv({ STEPCAST_OUTPUT: outputPath }, () => {
      output({ ok: true, n: 1 });
      output({ ok: true, n: 2 });
    });

    assert.deepEqual(JSON.parse(readFileSync(outputPath, 'utf8')), { ok: true, n: 2 });
  });

  it('publish(ключ, значение) неотличим от stepcast data set: та же проверка объявленного состава', async () => {
    const dir = jobDir(['slug']);

    await withStepEnv({ STEPCAST_JOB_DIR: dir }, () => {
      publish('slug', 'bug-42');
    });
    assert.deepEqual(readJobData(dir), { slug: 'bug-42' });

    await assert.rejects(
      withStepEnv({ STEPCAST_JOB_DIR: dir }, async () => publish('not-declared', 'x')),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.message, /не объявляла ключ данных/);
        return true;
      },
    );
  });

  it('publish(отображение) пишет несколько ключей разом', async () => {
    const dir = jobDir(['a', 'b']);
    await withStepEnv({ STEPCAST_JOB_DIR: dir }, () => {
      publish({ a: '1', b: '2' });
    });
    assert.deepEqual(readJobData(dir), { a: '1', b: '2' });
  });

  it('log() печатает в stdout, не бросая вне присутствия STEPCAST_JOB_DIR названно', async () => {
    const dir = jobDir([]);
    const original = console.log;
    const lines: unknown[][] = [];
    console.log = (...args: unknown[]) => lines.push(args);
    try {
      await withStepEnv({ STEPCAST_JOB_DIR: dir }, () => {
        log('привет', 1);
      });
    } finally {
      console.log = original;
    }
    assert.deepEqual(lines, [['привет', 1]]);
  });

  it('exec() запускает процесс без оболочки и отдаёт код возврата и stdout', async () => {
    const dir = jobDir([]);
    const result = await withStepEnv({ STEPCAST_JOB_DIR: dir }, () =>
      exec('node', ['-e', 'console.log("hi")']),
    );
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /hi/);
  });

  it('exec() пишет потоки дочернего процесса в потоки шага, а не только в результат', async () => {
    const dir = jobDir([]);
    const written: string[] = [];
    const originalOut = process.stdout.write.bind(process.stdout);
    const originalErr = process.stderr.write.bind(process.stderr);
    const capture = (chunk: string | Uint8Array): boolean => {
      written.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    };
    process.stdout.write = capture as typeof process.stdout.write;
    process.stderr.write = capture as typeof process.stderr.write;
    try {
      await withStepEnv({ STEPCAST_JOB_DIR: dir }, () =>
        exec('node', ['-e', 'console.log("в лог"); console.error("в стерр")']),
      );
    } finally {
      process.stdout.write = originalOut;
      process.stderr.write = originalErr;
    }

    const log = written.join('');
    assert.match(log, /в лог/);
    assert.match(log, /в стерр/);
  });

  it('exec() отказывает по умолчанию при ненулевом коде возврата', async () => {
    const dir = jobDir([]);
    await assert.rejects(
      withStepEnv({ STEPCAST_JOB_DIR: dir }, () => exec('node', ['-e', 'process.exit(3)'])),
    );
  });

  // Сценарий: «Вызов вне шага»
  it('вызов вне шага прогона отказывает названно', async () => {
    await withStepEnv({ STEPCAST_INPUT: undefined, STEPCAST_OUTPUT: undefined, STEPCAST_JOB_DIR: undefined }, () => {
      assert.throws(() => input(), (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.message, /работает только внутри шага прогона/);
        return true;
      });
    });
  });
});
