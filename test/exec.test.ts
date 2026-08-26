import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { buildStepEnv, injectedVariables, parseEnvFile } from '../src/core/exec/env.js';
import { BUILTIN_CONFIG } from '../src/core/config/defaults.js';
import { runProcess } from '../src/core/exec/process.js';
import { planAttempt, runAttempts } from '../src/core/exec/attempts.js';
import { executeRunStep } from '../src/core/exec/runStep.js';
import type { Attempts, RunStep } from '../src/core/pipeline/model.js';

function workdir(): string {
  return mkdtempSync(join(tmpdir(), 'stepcast-exec-'));
}

const NO_ATTEMPTS: Attempts = { max: 1, escalation: [] };

function makeRunStep(overrides: Partial<RunStep> = {}): RunStep {
  return {
    kind: 'run',
    id: 'c',
    index: 1,
    env: {},
    context: [],
    contextInherit: true,
    contextExclude: [],
    timeoutMs: 5_000,
    expect: [],
    attempts: NO_ATTEMPTS,
    command: ['echo', 'ok'],
    ...overrides,
  } as RunStep;
}

describe('step-execution: окружение', () => {
  // Сценарий: «Перекрытие по уровням»
  it('шаг перекрывает пайплайн', () => {
    const { env } = buildStepEnv({
      base: {},
      envFiles: [],
      pipeline: { NODE_ENV: 'test' },
      job: {},
      step: { NODE_ENV: 'development' },
      injected: {},
      deny: [],
      cwd: '/tmp',
    });
    assert.equal(env.NODE_ENV, 'development');
  });

  it('наследует окружение процесса целиком', () => {
    const { env } = buildStepEnv({
      base: { JAVA_HOME: '/opt/java', SSH_AUTH_SOCK: '/tmp/agent.sock' },
      envFiles: [],
      pipeline: {},
      job: {},
      step: {},
      injected: {},
      deny: [],
      cwd: '/tmp',
    });
    assert.equal(env.JAVA_HOME, '/opt/java');
    assert.equal(env.SSH_AUTH_SOCK, '/tmp/agent.sock');
  });

  it('умолчания запретов не ломают git по ssh', () => {
    // Шаблон SSH_* выглядел осторожным, но вычёркивал адрес сокета агента, и
    // первый же шаг с git по ssh переставал работать.
    const { env } = buildStepEnv({
      base: { SSH_AUTH_SOCK: '/tmp/agent.sock', SSH_AGENT_PID: '42', MY_PRIVATE_KEY: 'секрет' },
      envFiles: [],
      pipeline: {},
      job: {},
      step: {},
      injected: {},
      deny: BUILTIN_CONFIG.env_deny ?? [],
      cwd: '/tmp',
    });

    assert.equal(env.SSH_AUTH_SOCK, '/tmp/agent.sock');
    assert.equal(env.SSH_AGENT_PID, '42');
    assert.equal(env.MY_PRIVATE_KEY, undefined, 'ключи по-прежнему вычёркиваются');
  });

  // Сценарий: «Запрет применяется последним»
  it('вычёркивает переменную под запретом и сообщает, каким шаблоном', () => {
    const { env, denied } = buildStepEnv({
      base: { GH_TOKEN: 'из окружения' },
      envFiles: [],
      pipeline: {},
      job: { AWS_REGION: 'eu-west-1' },
      step: { HARMLESS: '1' },
      injected: {},
      deny: ['*_TOKEN', 'AWS_*'],
      cwd: '/tmp',
    });

    assert.equal(env.GH_TOKEN, undefined);
    assert.equal(env.AWS_REGION, undefined);
    assert.equal(env.HARMLESS, '1');
    assert.deepEqual(
      denied.map((item) => [item.name, item.pattern]).sort(),
      [
        ['AWS_REGION', 'AWS_*'],
        ['GH_TOKEN', '*_TOKEN'],
      ],
    );
  });

  it('читает переменные из env_files', () => {
    const dir = workdir();
    writeFileSync(join(dir, '.env.test'), '# комментарий\nAPI_BASE="https://x"\nexport CI=1\nмусор\n');

    const { env } = buildStepEnv({
      base: {},
      envFiles: ['.env.test'],
      pipeline: {},
      job: {},
      step: {},
      injected: {},
      deny: [],
      cwd: dir,
    });

    assert.equal(env.API_BASE, 'https://x');
    assert.equal(env.CI, '1');
    assert.equal(parseEnvFile(join(dir, 'нет.env')).X, undefined);
  });

  // Сценарий: «Инжектируемые переменные»
  it('добавляет переменные stepcast', () => {
    const injected = injectedVariables({
      runId: 'r1',
      runDir: '/runs/r1',
      jobId: 'build',
      jobDir: '/runs/r1/jobs/build',
      stepId: 'compile',
      stepDir: '/runs/r1/jobs/build/steps/01-compile',
      attempt: 2,
      workspace: '/work',
      artifacts: '/runs/r1/artifacts',
    });

    const { env } = buildStepEnv({
      base: {},
      envFiles: [],
      pipeline: {},
      job: {},
      step: {},
      injected,
      deny: [],
      cwd: '/tmp',
    });

    assert.equal(env.STEPCAST_RUN_ID, 'r1');
    assert.equal(env.STEPCAST_JOB, 'build');
    assert.equal(env.STEPCAST_STEP, 'compile');
    assert.equal(env.STEPCAST_ATTEMPT, '2');
    assert.equal(env.STEPCAST_WORKSPACE, '/work');
  });

  // Сценарий: «Инжектируемые переменные не переопределяются»
  it('не даёт шагу подменить переменные stepcast', () => {
    const { env } = buildStepEnv({
      base: {},
      envFiles: [],
      pipeline: {},
      job: {},
      step: { STEPCAST_JOB: 'подделка' },
      injected: { STEPCAST_JOB: 'build' },
      deny: [],
      cwd: '/tmp',
    });
    assert.equal(env.STEPCAST_JOB, 'build');
  });

  it('переменные stepcast не попадают под запреты', () => {
    const { env, denied } = buildStepEnv({
      base: {},
      envFiles: [],
      pipeline: {},
      job: {},
      step: {},
      injected: { STEPCAST_RUN_ID: 'r1' },
      deny: ['STEPCAST_*'],
      cwd: '/tmp',
    });
    assert.equal(env.STEPCAST_RUN_ID, 'r1');
    assert.deepEqual(denied, []);
  });
});

describe('step-execution: процесс', () => {
  // Сценарий: «Форма списком»
  it('исполняет список argv без оболочки', async () => {
    const result = await runProcess({
      command: ['echo', 'a b', '$HOME'],
      cwd: workdir(),
      env: { PATH: process.env.PATH ?? '' },
      timeoutMs: 5_000,
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout.trim(), 'a b $HOME', 'подстановка оболочки не выполняется');
  });

  // Сценарий: «Форма строкой»
  it('исполняет строку через оболочку платформы', async () => {
    const result = await runProcess({
      command: 'echo one && echo two',
      cwd: workdir(),
      env: { PATH: process.env.PATH ?? '' },
      timeoutMs: 5_000,
    });
    assert.equal(result.exitCode, 0);
    assert.deepEqual(result.stdout.trim().split('\n'), ['one', 'two']);
  });

  // Сценарий: «Рабочая директория»
  it('запускает процесс в рабочей директории работы', async () => {
    const dir = workdir();
    mkdirSync(join(dir, 'inner'));
    const result = await runProcess({
      command: ['pwd'],
      cwd: join(dir, 'inner'),
      env: { PATH: process.env.PATH ?? '' },
      timeoutMs: 5_000,
    });
    assert.match(result.stdout.trim(), /inner$/);
  });

  it('передаёт окружение и не наследует лишнего', async () => {
    const result = await runProcess({
      command: 'echo "$MARKER-$HOME"',
      cwd: workdir(),
      env: { PATH: process.env.PATH ?? '', MARKER: 'да' },
      timeoutMs: 5_000,
    });
    assert.equal(result.stdout.trim(), 'да-');
  });

  it('пишет потоки в файлы построчным текстом', async () => {
    const dir = workdir();
    const result = await runProcess({
      command: 'echo вывод; echo ошибка 1>&2',
      cwd: dir,
      env: { PATH: process.env.PATH ?? '' },
      timeoutMs: 5_000,
      stdoutPath: join(dir, 'stdout.log'),
      stderrPath: join(dir, 'stderr.log'),
    });

    assert.equal(result.exitCode, 0);
    assert.equal(readFileSync(join(dir, 'stdout.log'), 'utf8').trim(), 'вывод');
    assert.equal(readFileSync(join(dir, 'stderr.log'), 'utf8').trim(), 'ошибка');
  });

  // Сценарий: «Шаг превысил время»
  it('прерывает шаг по таймауту', async () => {
    const result = await runProcess({
      command: ['sleep', '5'],
      cwd: workdir(),
      env: { PATH: process.env.PATH ?? '' },
      timeoutMs: 150,
      graceMs: 200,
    });
    assert.equal(result.outcome, 'timeout');
    assert.notEqual(result.signal, null);
  });

  // Сценарий: «Процесс не завершился по SIGTERM»
  it('добивает процесс, переживший мягкий сигнал', async () => {
    const result = await runProcess({
      // Ловушка на SIGTERM: процесс переживает мягкий сигнал и уходит только
      // по SIGKILL — ровно тот случай, ради которого нужна отсрочка.
      command: "trap '' TERM; sleep 5",
      cwd: workdir(),
      env: { PATH: process.env.PATH ?? '' },
      timeoutMs: 100,
      graceMs: 150,
    });
    assert.equal(result.outcome, 'timeout');
    assert.equal(result.forceKilled, true);
  });

  it('убивает всё дерево процессов, а не только потомка', async () => {
    const dir = workdir();
    const marker = join(dir, 'внук-жив');
    const result = await runProcess({
      // Внук переживёт смерть родителя, если убивать не группу.
      command: `sh -c '(sleep 1; echo x > ${marker}) & sleep 5'`,
      cwd: dir,
      env: { PATH: process.env.PATH ?? '' },
      timeoutMs: 100,
      graceMs: 150,
    });

    assert.equal(result.outcome, 'timeout');
    await new Promise((resolve) => setTimeout(resolve, 1500));
    assert.equal(existsSync(marker), false, 'внук должен быть убит вместе с группой');
  });

  // Сценарий: «Молчание процесса»
  it('сообщает о тишине, не прерывая шаг', async () => {
    const silences: number[] = [];
    const result = await runProcess({
      command: 'echo начали; sleep 0.4; echo кончили',
      cwd: workdir(),
      env: { PATH: process.env.PATH ?? '' },
      timeoutMs: 5_000,
      stallTimeoutMs: 100,
      onStall: (ms) => silences.push(ms),
    });

    assert.equal(result.outcome, 'exited');
    assert.equal(result.exitCode, 0);
    assert.ok(silences.length > 0, 'молчание должно быть замечено');
    assert.match(result.stdout, /кончили/, 'шаг не прерван');
  });

  it('прерывается по внешней отмене', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const result = await runProcess({
      command: ['sleep', '5'],
      cwd: workdir(),
      env: { PATH: process.env.PATH ?? '' },
      timeoutMs: 10_000,
      graceMs: 200,
      signal: controller.signal,
    });
    assert.equal(result.outcome, 'canceled');
  });
});

describe('step-execution: попытки', () => {
  // Сценарий: «Умолчание числа попыток»
  it('без объявления выполняется одна попытка', async () => {
    let calls = 0;
    const result = await runAttempts({
      attempts: NO_ATTEMPTS,
      run: async () => {
        calls += 1;
        return { passed: false, value: calls };
      },
    });
    assert.equal(calls, 1);
    assert.equal(result.passed, false);
  });

  // Сценарий: «Успех со второй попытки»
  it('останавливается на успешной попытке и хранит обе', async () => {
    const result = await runAttempts<number>({
      attempts: { max: 3, escalation: [] },
      run: async (plan) => ({ passed: plan.attempt === 2, value: plan.attempt }),
    });
    assert.equal(result.passed, true);
    assert.equal(result.attemptsUsed, 2);
    assert.deepEqual(result.outcomes, [1, 2]);
  });

  // Сценарий: «Исчерпание попыток»
  it('исчерпывает попытки и отдаёт отказ', async () => {
    const result = await runAttempts<number>({
      attempts: { max: 3, escalation: [] },
      run: async (plan) => ({ passed: false, value: plan.attempt }),
    });
    assert.equal(result.passed, false);
    assert.equal(result.attemptsUsed, 3);
  });

  it('прекращает попытки, когда внешний ограничитель против', async () => {
    const result = await runAttempts<number>({
      attempts: { max: 5, escalation: [] },
      run: async (plan) => ({ passed: false, value: plan.attempt }),
      canContinue: (attempt) => attempt < 2,
    });
    assert.equal(result.attemptsUsed, 2);
    assert.equal(result.stoppedEarly, true);
  });

  // Неустранимый отказ бэкенда прекращает попытки немедленно, не расходуя
  // оставшиеся: см. requirement «Повторные попытки» в step-execution/spec.md.
  it('терминальная попытка прекращает цикл, даже когда max позволяет ещё', async () => {
    let calls = 0;
    const result = await runAttempts<number>({
      attempts: { max: 3, escalation: [] },
      run: async (plan) => {
        calls += 1;
        return { passed: false, value: plan.attempt, terminal: true };
      },
    });
    assert.equal(calls, 1);
    assert.equal(result.passed, false);
    assert.equal(result.attemptsUsed, 1);
    assert.equal(result.stoppedEarly, true);
  });

  // Сценарий: «Передача причины отказа»
  it('первая ступень эскалации добавляет вывод отказа со второй попытки', () => {
    const attempts: Attempts = {
      max: 3,
      escalation: [{ includeFailure: true }, { includeFailure: true, model: 'opus' }],
    };
    assert.equal(planAttempt(1, attempts).includeFailure, false, 'первая попытка идёт как объявлено');
    assert.equal(planAttempt(2, attempts).includeFailure, true);
  });

  // Сценарий: «Смена модели на поздней попытке»
  it('вторая ступень меняет модель на третьей попытке', () => {
    const attempts: Attempts = {
      max: 3,
      escalation: [{ includeFailure: true }, { includeFailure: true, model: 'opus' }],
    };
    assert.equal(planAttempt(2, attempts).model, undefined);
    assert.equal(planAttempt(3, attempts).model, 'opus');
  });

  // Сценарий: «Список короче числа попыток»
  it('повторяет последнюю ступень, когда список короче max', () => {
    const attempts: Attempts = {
      max: 5,
      escalation: [{ includeFailure: false }, { includeFailure: true, model: 'opus' }],
    };
    assert.equal(planAttempt(4, attempts).model, 'opus');
    assert.equal(planAttempt(5, attempts).model, 'opus');
  });
});

describe('step-execution: шаг целиком', () => {
  it('успешный шаг завершается с одной попыткой', async () => {
    const dir = workdir();
    const result = await executeRunStep({
      step: makeRunStep(),
      cwd: dir,
      stepDir: dir,
      env: () => ({ PATH: process.env.PATH ?? '' }),
    });

    assert.equal(result.status, 'success');
    assert.equal(result.attempts.length, 1);
    assert.equal(result.attempts[0]?.exit_code, 0);
    assert.ok(existsSync(join(dir, 'stdout.log')));
  });

  it('повторяет упавший шаг и хранит каждую попытку отдельно', async () => {
    const dir = workdir();
    const result = await executeRunStep({
      step: makeRunStep({
        command: ['false'],
        attempts: { max: 3, escalation: [] },
        expect: [{ kind: 'exit_code', value: 0 }],
      }),
      cwd: dir,
      stepDir: dir,
      env: (plan) => ({ PATH: process.env.PATH ?? '', STEPCAST_ATTEMPT: String(plan.attempt) }),
    });

    assert.equal(result.status, 'failed');
    assert.equal(result.attempts.length, 3);
    assert.deepEqual(
      result.attempts.map((attempt) => attempt.attempt),
      [1, 2, 3],
    );
    // Логи каждой попытки лежат отдельно: иначе диагноз «проходит с третьего
    // раза» опирался бы только на счётчик.
    assert.ok(existsSync(join(dir, 'stdout.log')));
    assert.ok(existsSync(join(dir, 'stdout.2.log')));
    assert.ok(existsSync(join(dir, 'stdout.3.log')));
  });

  it('уважает объявленный ожидаемый код возврата', async () => {
    const dir = workdir();
    const result = await executeRunStep({
      step: makeRunStep({
        command: 'exit 3',
        expect: [{ kind: 'exit_code', value: 3 }],
      }),
      cwd: dir,
      stepDir: dir,
      env: () => ({ PATH: process.env.PATH ?? '' }),
    });
    assert.equal(result.status, 'success');
  });

  it('таймаут завершает шаг отказом с внятной причиной', async () => {
    const dir = workdir();
    const result = await executeRunStep({
      step: makeRunStep({ command: ['sleep', '5'], timeoutMs: 120 }),
      cwd: dir,
      stepDir: dir,
      graceMs: 150,
      env: () => ({ PATH: process.env.PATH ?? '' }),
    });

    assert.equal(result.status, 'failed');
    assert.match(result.reason ?? '', /не завершился/);
  });
});
