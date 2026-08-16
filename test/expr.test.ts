import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { evaluate, parseExpression, references } from '../src/core/expr/parse.js';
import { ScarpError } from '../src/core/errors.js';

const scope = {
  inputs: { skip_review: false, count: 3, name: 'foo' },
  jobs: {
    plan: { status: 'success', output: { findings: [], target: 'desktop' } },
    build: { status: 'failed' },
  },
};

function check(source: string): boolean {
  return evaluate(parseExpression(source), scope);
}

describe('язык выражений', () => {
  it('вычисляет обращения к полям и отрицание', () => {
    assert.equal(check('inputs.skip_review'), false);
    assert.equal(check('not inputs.skip_review'), true);
    assert.equal(check('not not inputs.skip_review'), false);
  });

  it('сравнивает строки и числа', () => {
    assert.equal(check('jobs.plan.status == "success"'), true);
    assert.equal(check("jobs.build.status != 'success'"), true);
    assert.equal(check('inputs.count > 2'), true);
    assert.equal(check('inputs.count >= 4'), false);
    assert.equal(check('inputs.count <= 3'), true);
  });

  it('соединяет условия and, or и скобками', () => {
    assert.equal(check('inputs.count > 2 and jobs.plan.status == "success"'), true);
    assert.equal(check('inputs.skip_review or inputs.count == 3'), true);
    assert.equal(check('(inputs.skip_review or false) and true'), false);
  });

  it('трактует пустоту списка через истинность, а не через литерал', () => {
    // Литерала списка в грамматике нет намеренно: «есть ли находки» выражается
    // самой ссылкой, и второй способ сказать то же самое не нужен.
    assert.throws(() => parseExpression('jobs.plan.output.findings == []'), ScarpError);
    assert.equal(check('not jobs.plan.output.findings'), true, 'пустой список ложен');
    assert.equal(
      evaluate(parseExpression('jobs.r.output.findings'), {
        jobs: { r: { output: { findings: [{ severity: 'high' }] } } },
      }),
      true,
      'непустой список истинен',
    );
  });

  // Правило из спеки: выход упавшей работы неопределён и делает условие ложным.
  it('неопределённое значение ложно, а сравнение с ним не выполняется', () => {
    assert.equal(check('jobs.build.output.anything'), false);
    assert.equal(check('jobs.build.output.anything == "x"'), false);
    assert.equal(check('jobs.build.output.anything != "x"'), true);
    assert.equal(check('jobs.missing.status == "success"'), false);
    assert.equal(check('jobs.build.output.count > 0'), false, 'сравнение чисел с неопределённым ложно');
  });

  it('собирает все обращения к полям', () => {
    const paths = references(parseExpression('inputs.a and jobs.b.status == "x" or not inputs.c'));
    assert.deepEqual(
      paths.map((path) => path.join('.')).sort(),
      ['inputs.a', 'inputs.c', 'jobs.b.status'],
    );
  });

  it('отклоняет то, чего нет в грамматике', () => {
    assert.throws(() => parseExpression('inputs.count + 1'), ScarpError);
    assert.throws(() => parseExpression('len(inputs.name)'), ScarpError);
    assert.throws(() => parseExpression('inputs.count === 3'), ScarpError);
    assert.throws(() => parseExpression('(inputs.a'), ScarpError);
    assert.throws(() => parseExpression('inputs.a inputs.b'), ScarpError);
    assert.throws(() => parseExpression('"незакрытая'), ScarpError);
  });
});
