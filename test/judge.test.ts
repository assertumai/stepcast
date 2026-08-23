import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { createFakeBackend, resultLine } from '../src/core/backend/fake.js';
import type { BackendAdapter } from '../src/core/backend/types.js';
import { runJudgePass } from '../src/core/exec/judgePass.js';
import { RunJournal } from '../src/core/journal/writer.js';
import type { Predicate } from '../src/core/pipeline/model.js';
import type { PredicateResult, Usage } from '../src/core/journal/schema.js';

function bed(): { runsRoot: string; projectRoot: string; stepDir: string } {
  const base = mkdtempSync(join(tmpdir(), 'stepcast-judge-'));
  const runsRoot = join(base, 'runs');
  const projectRoot = join(base, 'project');
  mkdirSync(runsRoot, { recursive: true });
  mkdirSync(projectRoot, { recursive: true });
  const journal = RunJournal.create({ runsRoot, projectRoot });
  const stepDir = journal.prepareStep('build', 1, 'review');
  return { runsRoot, projectRoot, stepDir };
}

const CLAIM: Extract<Predicate, { kind: 'judge' }> = {
  kind: 'judge',
  claim: 'план покрывает все требования',
  hard: true,
};

const STRUCTURAL: readonly Predicate[] = [{ kind: 'exit_code', value: 0 }];
const STRUCTURAL_PASSED: PredicateResult = {
  predicate: 'exit_code',
  passed: true,
  hard: true,
  expected: 0,
  actual: 0,
};
const STRUCTURAL_FAILED: PredicateResult = {
  ...STRUCTURAL_PASSED,
  passed: false,
  actual: 1,
  detail: 'код возврата 1 вместо 0',
};
const JUDGE_PLACEHOLDER: PredicateResult = {
  predicate: 'judge',
  passed: true,
  hard: false,
  expected: CLAIM.claim,
  detail: 'не вычислен: судья вызывается вторым проходом',
};

function baseOptions(overrides: {
  readonly adapter: BackendAdapter;
  readonly stepDir: string;
  readonly firstPass?: readonly PredicateResult[];
  readonly usages?: Usage[];
  readonly budgetExhausted?: boolean;
}) {
  const journal = RunJournal.create({
    runsRoot: mkdtempSync(join(tmpdir(), 'stepcast-judge-runs-')),
    projectRoot: mkdtempSync(join(tmpdir(), 'stepcast-judge-project-')),
  });
  return {
    predicates: [...STRUCTURAL, CLAIM],
    firstPass: overrides.firstPass ?? [STRUCTURAL_PASSED, JUDGE_PLACEHOLDER],
    task: 'сделай план',
    text: 'готово',
    structured: { tasks: ['a'] },
    cwd: overrides.stepDir,
    stepDir: overrides.stepDir,
    attempt: 1,
    timeoutMs: 5_000,
    adapterFor: () => overrides.adapter,
    defaultAgent: 'claude',
    journal,
    nextCallIndex: (() => {
      let n = 0;
      return () => {
        n += 1;
        return n;
      };
    })(),
    canCall: () => !(overrides.budgetExhausted ?? false),
    onUsage: (usage: Usage) => overrides.usages?.push(usage),
  };
}

describe('agent-backend: вызов судьи', () => {
  it('передаёт схему вердикта и не передаёт permissions', async () => {
    const { stepDir } = bed();
    const backend = createFakeBackend({
      lines: [resultLine({ structured: { pass: true, reason: 'всё покрыто' } })],
    });

    const results = await runJudgePass(baseOptions({ adapter: backend.adapter, stepDir }));

    assert.equal(backend.invocations.length, 1);
    const invocation = backend.invocations[0];
    assert.ok(invocation?.outputSchemaPath, 'схема вердикта должна быть передана');
    assert.equal(invocation?.permissions, undefined);
    assert.equal(invocation?.resumeSession, false);

    assert.equal(results[1]?.passed, true);
    assert.equal(results[1]?.detail, 'всё покрыто');
  });

  it('судья независим от сессии шага: каждый вызов получает свежий идентификатор', async () => {
    const { stepDir } = bed();
    const backend = createFakeBackend({
      lines: [resultLine({ structured: { pass: true, reason: 'ок' } })],
    });

    await runJudgePass(baseOptions({ adapter: backend.adapter, stepDir }));
    await runJudgePass(baseOptions({ adapter: backend.adapter, stepDir }));

    const ids = backend.invocations.map((item) => item.sessionId);
    assert.equal(new Set(ids).size, ids.length, 'у каждого вызова свой идентификатор сессии');
  });

  it('pass:false даёт непройденный предикат', async () => {
    const { stepDir } = bed();
    const backend = createFakeBackend({
      lines: [resultLine({ structured: { pass: false, reason: 'ретраи не покрыты' } })],
    });

    const results = await runJudgePass(baseOptions({ adapter: backend.adapter, stepDir }));
    assert.equal(results[1]?.passed, false);
    assert.equal(results[1]?.detail, 'ретраи не покрыты');
  });

  it('ответ не по схеме даёт непройденный предикат с причиной', async () => {
    const { stepDir } = bed();
    const backend = createFakeBackend({
      lines: [resultLine({ structured: { ok: true } })],
    });

    const results = await runJudgePass(baseOptions({ adapter: backend.adapter, stepDir }));
    assert.equal(results[1]?.passed, false);
    assert.match(results[1]?.detail ?? '', /вердикт/i);
  });

  it('отсутствие структурированного вывода даёт непройденный предикат', async () => {
    const { stepDir } = bed();
    const backend = createFakeBackend({ lines: [resultLine({ text: 'наверное да' })] });

    const results = await runJudgePass(baseOptions({ adapter: backend.adapter, stepDir }));
    assert.equal(results[1]?.passed, false);
  });

  it('прерывание по времени даёт причину, называющую таймаут', async () => {
    const { stepDir } = bed();
    const backend = createFakeBackend({ lines: [], hangMs: 1000 });
    const options = baseOptions({ adapter: backend.adapter, stepDir });

    const results = await runJudgePass({ ...options, timeoutMs: 30 });
    assert.equal(results[1]?.passed, false);
    assert.match(results[1]?.detail ?? '', /мс/);
  });

  it('не вызывается после непройденного жёсткого структурного предиката', async () => {
    const { stepDir } = bed();
    const backend = createFakeBackend({
      lines: [resultLine({ structured: { pass: true, reason: 'ок' } })],
    });

    const results = await runJudgePass(
      baseOptions({
        adapter: backend.adapter,
        stepDir,
        firstPass: [STRUCTURAL_FAILED, JUDGE_PLACEHOLDER],
      }),
    );

    assert.equal(backend.invocations.length, 0);
    assert.equal(results[1]?.detail, JUDGE_PLACEHOLDER.detail);
    assert.equal(existsSync(join(stepDir, 'judge-1')), false);
  });

  it('исчерпанный бюджет оставляет вердикт невычисленным', async () => {
    const { stepDir } = bed();
    const backend = createFakeBackend({
      lines: [resultLine({ structured: { pass: true, reason: 'ок' } })],
    });

    const results = await runJudgePass(
      baseOptions({ adapter: backend.adapter, stepDir, budgetExhausted: true }),
    );

    assert.equal(backend.invocations.length, 0);
    assert.equal(results[1]?.passed, true);
    assert.equal(results[1]?.hard, false);
    assert.match(results[1]?.detail ?? '', /бюджет/);
  });

  it('записывает каталог judge-<n> с промптом, потоком, вердиктом и расходом', async () => {
    const { stepDir } = bed();
    const backend = createFakeBackend({
      lines: [resultLine({ structured: { pass: true, reason: 'план полный' }, tokensIn: 10, tokensOut: 5 })],
    });

    await runJudgePass(baseOptions({ adapter: backend.adapter, stepDir }));

    const dir = join(stepDir, 'judge-1');
    assert.ok(existsSync(join(dir, 'prompt.txt')));
    assert.ok(existsSync(join(dir, 'stdout.log')));

    const verdict = JSON.parse(readFileSync(join(dir, 'verdict.json'), 'utf8')) as {
      pass: boolean;
      reason: string;
      attempt: number;
      claim: string;
    };
    assert.equal(verdict.pass, true);
    assert.equal(verdict.reason, 'план полный');
    assert.equal(verdict.attempt, 1);
    assert.equal(verdict.claim, CLAIM.claim);

    const usage = JSON.parse(readFileSync(join(dir, 'usage.json'), 'utf8')) as Usage;
    assert.equal(usage.tokens_in, 10);
    assert.equal(usage.tokens_out, 5);

    const prompt = readFileSync(join(dir, 'prompt.txt'), 'utf8');
    assert.match(prompt, /план покрывает все требования/);
    assert.match(prompt, /сделай план/);
  });

  it('промпт содержит выводы шага и другие проверки, но не контекст', async () => {
    const { stepDir } = bed();
    const backend = createFakeBackend({
      lines: [resultLine({ structured: { pass: true, reason: 'ок' } })],
    });

    const contextMarker = 'СЕКРЕТНЫЙ_БЛОК_КОНТЕКСТА_ШАГА';
    const options = baseOptions({
      adapter: backend.adapter,
      stepDir,
      firstPass: [
        STRUCTURAL_PASSED,
        { ...STRUCTURAL_PASSED, predicate: 'matches', detail: 'строка найдена' },
        JUDGE_PLACEHOLDER,
      ],
    });

    await runJudgePass({
      ...options,
      predicates: [STRUCTURAL[0] as Predicate, { kind: 'matches', pattern: 'x' } as Predicate, CLAIM],
      task: 'сделай план',
      text: 'текстовый ответ шага',
      structured: { tasks: ['a', 'b'] },
    });

    const prompt = readFileSync(join(stepDir, 'judge-1', 'prompt.txt'), 'utf8');
    assert.match(prompt, /Утверждение для проверки/);
    assert.match(prompt, /Задание шага/);
    assert.match(prompt, /сделай план/);
    assert.match(prompt, /Текстовый результат шага/);
    assert.match(prompt, /текстовый ответ шага/);
    assert.match(prompt, /Структурированный вывод шага/);
    assert.match(prompt, /"tasks"/);
    assert.match(prompt, /Результаты остальных проверок/);
    assert.match(prompt, /exit_code/);
    assert.match(prompt, /matches/);
    assert.match(prompt, /строка найдена/);
    assert.doesNotMatch(prompt, new RegExp(contextMarker));
    assert.doesNotMatch(prompt, /Контекст/);
  });

  it('несколько судей нумеруются сквозным образом', async () => {
    const { stepDir } = bed();
    const backend = createFakeBackend({
      lines: [resultLine({ structured: { pass: true, reason: 'первое утверждение верно' } })],
    });

    const secondClaim: Extract<Predicate, { kind: 'judge' }> = {
      kind: 'judge',
      claim: 'второе утверждение',
      hard: false,
    };
    const secondPlaceholder: PredicateResult = { ...JUDGE_PLACEHOLDER, expected: secondClaim.claim };

    const options = baseOptions({
      adapter: backend.adapter,
      stepDir,
      firstPass: [STRUCTURAL_PASSED, JUDGE_PLACEHOLDER, secondPlaceholder],
    });
    const results = await runJudgePass({
      ...options,
      predicates: [...STRUCTURAL, CLAIM, secondClaim],
    });

    assert.equal(backend.invocations.length, 2);
    assert.equal(results[1]?.detail, 'первое утверждение верно');
    assert.equal(results[2]?.detail, 'первое утверждение верно');

    const first = join(stepDir, 'judge-1');
    const second = join(stepDir, 'judge-2');
    assert.ok(existsSync(first));
    assert.ok(existsSync(second));

    const firstVerdict = JSON.parse(readFileSync(join(first, 'verdict.json'), 'utf8')) as {
      claim: string;
      attempt: number;
    };
    const secondVerdict = JSON.parse(readFileSync(join(second, 'verdict.json'), 'utf8')) as {
      claim: string;
      attempt: number;
    };
    assert.equal(firstVerdict.claim, CLAIM.claim);
    assert.equal(firstVerdict.attempt, 1);
    assert.equal(secondVerdict.claim, secondClaim.claim);
    assert.equal(secondVerdict.attempt, 1);
  });
});
