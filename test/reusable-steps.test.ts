import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';

import { expandPipeline, type ScriptRoots } from '../src/core/pipeline/expand.js';
import { StepcastError } from '../src/core/errors.js';
import { asScript, makeProject, type Project } from './helpers.js';
import { tempDir } from './tmp.js';

/**
 * Каталог шага `uses` (`docs/pipeline-format.md`, раздел о переиспользуемом
 * шаге): манифест `step.yml`, разрешение имени тремя слоями, сведение
 * параметров. Тесты гоняют через `expandPipeline` — тот же вход, каким шаг
 * доходит до линта и до прогона, а не отдельный юнит-тест `steps.ts`: смысл
 * изменения в том, что видит пайплайн, а не в устройстве модуля.
 */

/** Корни слоёв шагов, изолированные от машины — `home` и `builtin` пусты, пока тест не допишет в них. */
function isolatedStepRoots(project: Project): ScriptRoots {
  return { project: project.root, home: tempDir('step-home-'), builtin: tempDir('step-builtin-') };
}

/** Корни слоёв script — шагу `uses` они нужны для разрешения обёртки раннера. */
function isolatedScriptRoots(project: Project): ScriptRoots {
  return { project: project.root, home: tempDir('script-home-'), builtin: tempDir('script-builtin-') };
}

function expandUses(project: Project, stepRoots: ScriptRoots, scriptRoots?: ScriptRoots) {
  return expandPipeline({
    pipelinePath: project.path('stepcast.yml'),
    config: project.config,
    stepRoots,
    scriptRoots: scriptRoots ?? isolatedScriptRoots(project),
  });
}

/** Каталог шага с манифестом и файлами рядом. */
function writeStepDir(
  layerDir: string,
  name: string,
  manifest: string,
  files: Readonly<Record<string, string>> = {},
): void {
  const dir = join(layerDir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'step.yml'), manifest);
  for (const [file, content] of Object.entries(files)) {
    const full = join(dir, file);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
}

const GREET_MAIN = `
const fs = require('node:fs');
const input = JSON.parse(fs.readFileSync(process.env.STEPCAST_INPUT, 'utf8'));
fs.writeFileSync(process.env.STEPCAST_OUTPUT, JSON.stringify({ greeting: 'привет, ' + input.name }));
`;

const GREET_MANIFEST = `
version: 1
kind: step
name: greet
description: Приветствует по имени.
file: ./main.cjs
params:
  type: object
  properties:
    name: { type: string, default: world, description: Кого приветствовать }
output_schema: ./output.schema.json
`;

const GREET_OUTPUT_SCHEMA = JSON.stringify({
  type: 'object',
  properties: { greeting: { type: 'string' } },
  required: ['greeting'],
});

function pipelineWithUses(uses: string, withBlock = ''): string {
  return `
kind: pipeline
budget: { tokens: 100k }
jobs:
  build:
    steps:
      - id: c
        uses: ${uses}
${withBlock}
`;
}

describe('reusable-step: разрешение имени тремя слоями', () => {
  it('находит шаг проектного слоя', () => {
    const project = makeProject({ 'stepcast.yml': pipelineWithUses('greet') });
    const stepRoots = isolatedStepRoots(project);
    writeStepDir(join(stepRoots.project, '.stepcast', 'steps'), 'greet', GREET_MANIFEST, {
      'main.cjs': GREET_MAIN,
      'output.schema.json': GREET_OUTPUT_SCHEMA,
    });

    const { pipeline } = expandUses(project, stepRoots);
    const step = asScript(pipeline.jobs[0]!.steps[0]!);
    assert.equal(step.unresolved, undefined);
    assert.equal(step.uses?.name, 'greet');
    assert.equal(step.uses?.layer, 'project');
    assert.equal(step.resolved?.absolutePath, join(stepRoots.project, '.stepcast', 'steps', 'greet', 'main.cjs'));
  });

  it('проектный слой перекрывает домашний', () => {
    const project = makeProject({ 'stepcast.yml': pipelineWithUses('greet') });
    const stepRoots = isolatedStepRoots(project);
    writeStepDir(join(stepRoots.project, '.stepcast', 'steps'), 'greet', GREET_MANIFEST, {
      'main.cjs': GREET_MAIN,
      'output.schema.json': GREET_OUTPUT_SCHEMA,
    });
    writeStepDir(join(stepRoots.home, '.stepcast', 'steps'), 'greet', GREET_MANIFEST, {
      'main.cjs': GREET_MAIN,
      'output.schema.json': GREET_OUTPUT_SCHEMA,
    });

    const { pipeline } = expandUses(project, stepRoots);
    const step = asScript(pipeline.jobs[0]!.steps[0]!);
    assert.equal(step.uses?.layer, 'project');
    assert.equal(step.resolved?.absolutePath, join(stepRoots.project, '.stepcast', 'steps', 'greet', 'main.cjs'));
  });

  it('домашний слой перекрывает встроенный', () => {
    const project = makeProject({ 'stepcast.yml': pipelineWithUses('greet') });
    const stepRoots = isolatedStepRoots(project);
    writeStepDir(stepRoots.builtin, 'greet', GREET_MANIFEST, {
      'main.cjs': GREET_MAIN,
      'output.schema.json': GREET_OUTPUT_SCHEMA,
    });
    writeStepDir(join(stepRoots.home, '.stepcast', 'steps'), 'greet', GREET_MANIFEST, {
      'main.cjs': GREET_MAIN,
      'output.schema.json': GREET_OUTPUT_SCHEMA,
    });

    const { pipeline } = expandUses(project, stepRoots);
    const step = asScript(pipeline.jobs[0]!.steps[0]!);
    assert.equal(step.uses?.layer, 'home');
  });

  it('встроенный слой разрешает шаг без единого каталога шагов у проекта', () => {
    const project = makeProject({ 'stepcast.yml': pipelineWithUses('greet') });
    const stepRoots = isolatedStepRoots(project);
    writeStepDir(stepRoots.builtin, 'greet', GREET_MANIFEST, {
      'main.cjs': GREET_MAIN,
      'output.schema.json': GREET_OUTPUT_SCHEMA,
    });

    const { pipeline } = expandUses(project, stepRoots);
    const step = asScript(pipeline.jobs[0]!.steps[0]!);
    assert.equal(step.uses?.layer, 'builtin');
    assert.equal(step.unresolved, undefined);
  });

  it('каталог без step.yml пропускается слоем, как отсутствующий', () => {
    const project = makeProject({ 'stepcast.yml': pipelineWithUses('notes') });
    const stepRoots = isolatedStepRoots(project);
    // Каталог проектного слоя есть, но манифеста в нём нет.
    mkdirSync(join(stepRoots.project, '.stepcast', 'steps', 'notes'), { recursive: true });
    writeFileSync(join(stepRoots.project, '.stepcast', 'steps', 'notes', 'readme.txt'), 'не манифест');
    writeStepDir(join(stepRoots.home, '.stepcast', 'steps'), 'notes', GREET_MANIFEST.replace('greet', 'notes'), {
      'main.cjs': GREET_MAIN,
      'output.schema.json': GREET_OUTPUT_SCHEMA,
    });

    const { pipeline } = expandUses(project, stepRoots);
    const step = asScript(pipeline.jobs[0]!.steps[0]!);
    assert.equal(step.uses?.layer, 'home');
    assert.equal(step.unresolved, undefined);
  });

  it('ненайденное имя — unresolved step_not_found с перечнем просмотренных каталогов', () => {
    const project = makeProject({ 'stepcast.yml': pipelineWithUses('no-such-step') });
    const stepRoots = isolatedStepRoots(project);

    const { pipeline } = expandUses(project, stepRoots);
    const step = asScript(pipeline.jobs[0]!.steps[0]!);
    assert.equal(step.resolved, undefined);
    assert.equal(step.unresolved?.reason, 'step_not_found');
    if (step.unresolved?.reason === 'step_not_found') {
      assert.equal(step.unresolved.searched.length, 3);
      assert.ok(step.unresolved.searched[0]!.includes(join('.stepcast', 'steps', 'no-such-step')));
    }
  });
});

describe('reusable-step: форма имени uses', () => {
  it('отклоняет форму автор/имя', () => {
    const project = makeProject({ 'stepcast.yml': pipelineWithUses('alice/lint-fix') });
    assert.throws(
      () => expandUses(project, isolatedStepRoots(project)),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.message, /автор\/имя/);
        return true;
      },
    );
  });

  it('отклоняет путь вместо имени, называя script нужным ключом', () => {
    const project = makeProject({ 'stepcast.yml': pipelineWithUses('./tools/step.yml') });
    assert.throws(
      () => expandUses(project, isolatedStepRoots(project)),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.message, /script/);
        return true;
      },
    );
  });

  it('отклоняет пустое имя', () => {
    const project = makeProject({ 'stepcast.yml': pipelineWithUses('""') });
    assert.throws(() => expandUses(project, isolatedStepRoots(project)), StepcastError);
  });

  it('отклоняет имя с пробелом', () => {
    const project = makeProject({ 'stepcast.yml': pipelineWithUses('"lint fix"') });
    assert.throws(() => expandUses(project, isolatedStepRoots(project)), StepcastError);
  });
});

describe('reusable-step: манифест', () => {
  it('несовпадение name с именем каталога — unresolved name_mismatch', () => {
    const project = makeProject({ 'stepcast.yml': pipelineWithUses('greet') });
    const stepRoots = isolatedStepRoots(project);
    writeStepDir(
      join(stepRoots.project, '.stepcast', 'steps'),
      'greet',
      GREET_MANIFEST.replace('name: greet', 'name: list-changes'),
      { 'main.cjs': GREET_MAIN, 'output.schema.json': GREET_OUTPUT_SCHEMA },
    );

    const { pipeline } = expandUses(project, stepRoots);
    const step = asScript(pipeline.jobs[0]!.steps[0]!);
    assert.equal(step.unresolved?.reason, 'name_mismatch');
    if (step.unresolved?.reason === 'name_mismatch') {
      assert.equal(step.unresolved.manifestName, 'list-changes');
      assert.equal(step.unresolved.name, 'greet');
    }
  });

  it('незнакомое поле манифеста — unresolved manifest_invalid', () => {
    const project = makeProject({ 'stepcast.yml': pipelineWithUses('greet') });
    const stepRoots = isolatedStepRoots(project);
    writeStepDir(
      join(stepRoots.project, '.stepcast', 'steps'),
      'greet',
      `${GREET_MANIFEST}\nunexpected_field: 1\n`,
      { 'main.cjs': GREET_MAIN, 'output.schema.json': GREET_OUTPUT_SCHEMA },
    );

    const { pipeline } = expandUses(project, stepRoots);
    const step = asScript(pipeline.jobs[0]!.steps[0]!);
    assert.equal(step.unresolved?.reason, 'manifest_invalid');
    if (step.unresolved?.reason === 'manifest_invalid') {
      assert.match(step.unresolved.detail, /unexpected_field/);
    }
  });

  it('file за пределами каталога шага — unresolved manifest_invalid', () => {
    const project = makeProject({ 'stepcast.yml': pipelineWithUses('greet') });
    const stepRoots = isolatedStepRoots(project);
    writeStepDir(
      join(stepRoots.project, '.stepcast', 'steps'),
      'greet',
      GREET_MANIFEST.replace('file: ./main.cjs', 'file: ../../../tools/cleanup.py'),
      { 'output.schema.json': GREET_OUTPUT_SCHEMA },
    );

    const { pipeline } = expandUses(project, stepRoots);
    const step = asScript(pipeline.jobs[0]!.steps[0]!);
    assert.equal(step.unresolved?.reason, 'manifest_invalid');
    if (step.unresolved?.reason === 'manifest_invalid') {
      assert.match(step.unresolved.detail, /пределы каталога/);
    }
  });

  it('отсутствующий file — unresolved step_file_missing с ожидаемым путём', () => {
    const project = makeProject({ 'stepcast.yml': pipelineWithUses('greet') });
    const stepRoots = isolatedStepRoots(project);
    writeStepDir(join(stepRoots.project, '.stepcast', 'steps'), 'greet', GREET_MANIFEST, {
      'output.schema.json': GREET_OUTPUT_SCHEMA,
    });

    const { pipeline } = expandUses(project, stepRoots);
    const step = asScript(pipeline.jobs[0]!.steps[0]!);
    assert.equal(step.unresolved?.reason, 'step_file_missing');
    if (step.unresolved?.reason === 'step_file_missing') {
      assert.equal(
        step.unresolved.expectedPath,
        join(stepRoots.project, '.stepcast', 'steps', 'greet', 'main.cjs'),
      );
    }
  });

  it('раннер выбирается расширением файла манифеста', () => {
    const project = makeProject({ 'stepcast.yml': pipelineWithUses('greet') });
    const stepRoots = isolatedStepRoots(project);
    writeStepDir(join(stepRoots.project, '.stepcast', 'steps'), 'greet', GREET_MANIFEST, {
      'main.cjs': GREET_MAIN,
      'output.schema.json': GREET_OUTPUT_SCHEMA,
    });

    const { pipeline } = expandUses(project, stepRoots);
    const step = asScript(pipeline.jobs[0]!.steps[0]!);
    assert.equal(step.resolved?.runner, 'node');
  });
});

describe('reusable-step: схема параметров', () => {
  it('схема параметров не объектная — unresolved manifest_invalid', () => {
    const project = makeProject({ 'stepcast.yml': pipelineWithUses('greet') });
    const stepRoots = isolatedStepRoots(project);
    writeStepDir(
      join(stepRoots.project, '.stepcast', 'steps'),
      'greet',
      GREET_MANIFEST.replace(/params:[\s\S]*?output_schema:/, 'params: { type: array }\noutput_schema:'),
      { 'main.cjs': GREET_MAIN, 'output.schema.json': GREET_OUTPUT_SCHEMA },
    );

    const { pipeline } = expandUses(project, stepRoots);
    const step = asScript(pipeline.jobs[0]!.steps[0]!);
    assert.equal(step.unresolved?.reason, 'manifest_invalid');
    if (step.unresolved?.reason === 'manifest_invalid') {
      assert.match(step.unresolved.detail, /объектной/);
    }
  });

  it('дефектная схема параметров — unresolved manifest_invalid, называющий шаг и файл', () => {
    const project = makeProject({ 'stepcast.yml': pipelineWithUses('greet') });
    const stepRoots = isolatedStepRoots(project);
    writeStepDir(
      join(stepRoots.project, '.stepcast', 'steps'),
      'greet',
      GREET_MANIFEST.replace(
        /params:[\s\S]*?output_schema:/,
        'params: { type: object, properties: { n: { type: "not-a-real-type" } } }\noutput_schema:',
      ),
      { 'main.cjs': GREET_MAIN, 'output.schema.json': GREET_OUTPUT_SCHEMA },
    );

    const { pipeline } = expandUses(project, stepRoots);
    const step = asScript(pipeline.jobs[0]!.steps[0]!);
    assert.equal(step.unresolved?.reason, 'manifest_invalid');
    if (step.unresolved?.reason === 'manifest_invalid') {
      assert.equal(step.unresolved.name, 'greet');
      assert.match(step.unresolved.manifestPath, /step\.yml$/);
    }
  });

  it('шаг без params — непустой with отказывает params_invalid', () => {
    const project = makeProject({
      'stepcast.yml': pipelineWithUses('greet', '        with: { slug: bug-42 }'),
    });
    const stepRoots = isolatedStepRoots(project);
    writeStepDir(
      join(stepRoots.project, '.stepcast', 'steps'),
      'greet',
      GREET_MANIFEST.replace(/params:[\s\S]*?description: Кого приветствовать }\n/, ''),
      { 'main.cjs': GREET_MAIN, 'output.schema.json': GREET_OUTPUT_SCHEMA },
    );

    const { pipeline } = expandUses(project, stepRoots);
    const step = asScript(pipeline.jobs[0]!.steps[0]!);
    assert.equal(step.unresolved?.reason, 'params_invalid');
  });

  it('умолчание подставляется при раскрытии', () => {
    const project = makeProject({ 'stepcast.yml': pipelineWithUses('greet') });
    const stepRoots = isolatedStepRoots(project);
    writeStepDir(join(stepRoots.project, '.stepcast', 'steps'), 'greet', GREET_MANIFEST, {
      'main.cjs': GREET_MAIN,
      'output.schema.json': GREET_OUTPUT_SCHEMA,
    });

    const { pipeline } = expandUses(project, stepRoots);
    const step = asScript(pipeline.jobs[0]!.steps[0]!);
    assert.deepEqual(step.input, { name: 'world' });
    assert.deepEqual(step.uses?.params, { name: 'world' });
  });
});

describe('reusable-step: сведение параметров вызова', () => {
  it('неизвестный параметр — params_invalid с перечнем объявленных', () => {
    const project = makeProject({
      'stepcast.yml': pipelineWithUses('greet', '        with: { nam: bug-42 }'),
    });
    const stepRoots = isolatedStepRoots(project);
    writeStepDir(join(stepRoots.project, '.stepcast', 'steps'), 'greet', GREET_MANIFEST, {
      'main.cjs': GREET_MAIN,
      'output.schema.json': GREET_OUTPUT_SCHEMA,
    });

    const { pipeline } = expandUses(project, stepRoots);
    const step = asScript(pipeline.jobs[0]!.steps[0]!);
    assert.equal(step.unresolved?.reason, 'params_invalid');
    if (step.unresolved?.reason === 'params_invalid') {
      assert.match(step.unresolved.detail, /nam/);
      assert.match(step.unresolved.detail, /name/);
    }
  });

  it('непереданный обязательный — params_invalid, называющий параметр', () => {
    const project = makeProject({ 'stepcast.yml': pipelineWithUses('greet') });
    const stepRoots = isolatedStepRoots(project);
    writeStepDir(
      join(stepRoots.project, '.stepcast', 'steps'),
      'greet',
      GREET_MANIFEST.replace('type: object\n  properties:', 'type: object\n  required: [name]\n  properties:')
        .replace('name: { type: string, default: world, description: Кого приветствовать }', 'name: { type: string }'),
      { 'main.cjs': GREET_MAIN, 'output.schema.json': GREET_OUTPUT_SCHEMA },
    );

    const { pipeline } = expandUses(project, stepRoots);
    const step = asScript(pipeline.jobs[0]!.steps[0]!);
    assert.equal(step.unresolved?.reason, 'params_invalid');
    if (step.unresolved?.reason === 'params_invalid') {
      assert.match(step.unresolved.detail, /name/);
    }
  });

  it('значение не по схеме — params_invalid с замечанием валидатора', () => {
    const project = makeProject({
      'stepcast.yml': pipelineWithUses('greet', '        with: { name: 42 }'),
    });
    const stepRoots = isolatedStepRoots(project);
    writeStepDir(join(stepRoots.project, '.stepcast', 'steps'), 'greet', GREET_MANIFEST, {
      'main.cjs': GREET_MAIN,
      'output.schema.json': GREET_OUTPUT_SCHEMA,
    });

    const { pipeline } = expandUses(project, stepRoots);
    const step = asScript(pipeline.jobs[0]!.steps[0]!);
    assert.equal(step.unresolved?.reason, 'params_invalid');
    if (step.unresolved?.reason === 'params_invalid') {
      assert.match(step.unresolved.detail, /name/);
    }
  });

  /**
   * Проверкой схемы пропускается **значение** с отложенной подстановкой, а не
   * весь набор (design.md, решение 7): иначе один параметр из выхода работы
   * выше по графу прятал бы промах соседнего до самого прогона.
   */
  const TWO_PARAMS_MANIFEST = `
version: 1
kind: step
name: greet
description: Приветствует по имени.
file: ./main.cjs
params:
  type: object
  required: [name]
  properties:
    name: { type: string }
    note: { type: string }
`;

  it('отложенная подстановка в одном параметре не отменяет проверки соседнего', () => {
    const project = makeProject({
      'stepcast.yml': pipelineWithUses(
        'greet',
        '        with: { name: 42, note: "${jobs.plan.output.note}" }',
      ),
    });
    const stepRoots = isolatedStepRoots(project);
    writeStepDir(join(stepRoots.project, '.stepcast', 'steps'), 'greet', TWO_PARAMS_MANIFEST, {
      'main.cjs': GREET_MAIN,
    });

    const { pipeline } = expandUses(project, stepRoots);
    const step = asScript(pipeline.jobs[0]!.steps[0]!);
    assert.equal(step.unresolved?.reason, 'params_invalid');
    if (step.unresolved?.reason === 'params_invalid') {
      assert.match(step.unresolved.detail, /name/);
    }
  });

  it('само отложенное значение схемой не проверяется, и обязательность им не нарушается', () => {
    const project = makeProject({
      'stepcast.yml': pipelineWithUses(
        'greet',
        '        with: { name: "${jobs.plan.output.name}", note: заметка }',
      ),
    });
    const stepRoots = isolatedStepRoots(project);
    writeStepDir(join(stepRoots.project, '.stepcast', 'steps'), 'greet', TWO_PARAMS_MANIFEST, {
      'main.cjs': GREET_MAIN,
    });

    const { pipeline } = expandUses(project, stepRoots);
    const step = asScript(pipeline.jobs[0]!.steps[0]!);
    assert.equal(step.unresolved, undefined);
  });

  it('параметр-объект принимается объектом целиком', () => {
    const project = makeProject({
      'stepcast.yml': pipelineWithUses('greet', '        with: { name: { first: Ann } }'),
    });
    const stepRoots = isolatedStepRoots(project);
    writeStepDir(
      join(stepRoots.project, '.stepcast', 'steps'),
      'greet',
      GREET_MANIFEST.replace(
        'name: { type: string, default: world, description: Кого приветствовать }',
        'name: { type: object }',
      ),
      { 'main.cjs': GREET_MAIN, 'output.schema.json': GREET_OUTPUT_SCHEMA },
    );

    const { pipeline } = expandUses(project, stepRoots);
    const step = asScript(pipeline.jobs[0]!.steps[0]!);
    assert.equal(step.unresolved, undefined);
    assert.deepEqual(step.input, { name: { first: 'Ann' } });
  });
});

describe('reusable-step: параметр не отображением', () => {
  it('отклоняет with списком', () => {
    const project = makeProject({
      'stepcast.yml': pipelineWithUses('greet', '        with: [a, b]'),
    });
    assert.throws(() => expandUses(project, isolatedStepRoots(project)), StepcastError);
  });
});

describe('reusable-step: общие ключи и запрет объявляемых манифестом', () => {
  it('принимает общие ключи шага рядом с uses', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
budget: { tokens: 100k }
jobs:
  build:
    steps:
      - id: c
        uses: greet
        timeout: 30s
        attempts: { max: 2 }
        env: { X: "1" }
        expect: [{ exit_code: 0 }]
`,
    });
    const stepRoots = isolatedStepRoots(project);
    writeStepDir(join(stepRoots.project, '.stepcast', 'steps'), 'greet', GREET_MANIFEST, {
      'main.cjs': GREET_MAIN,
      'output.schema.json': GREET_OUTPUT_SCHEMA,
    });

    const { pipeline } = expandUses(project, stepRoots);
    const step = asScript(pipeline.jobs[0]!.steps[0]!);
    assert.equal(step.attempts.max, 2);
    assert.equal(step.env.X, '1');
    assert.equal(step.timeoutMs, 30_000);
  });

  for (const key of ['runner: node', 'args: ["--x"]', 'input: { a: 1 }', 'output_schema: ./out.json']) {
    it(`отклоняет ${key.split(':')[0]} рядом с uses`, () => {
      const [field] = key.split(':') as [string];
      const project = makeProject({
        'stepcast.yml': `
kind: pipeline
jobs:
  build:
    steps:
      - id: c
        uses: greet
        ${key}
`,
      });
      assert.throws(
        () => expandUses(project, isolatedStepRoots(project)),
        (error: unknown) => {
          assert.ok(error instanceof StepcastError);
          assert.match(error.message, new RegExp(field));
          // Ключ известен формату — его объявляет манифест; «неизвестный
          // ключ» отправил бы автора искать опечатку там, где её нет.
          assert.match(error.message, /объявляет манифест шага/);
          assert.doesNotMatch(error.message, /неизвестн/i);
          return true;
        },
      );
    });
  }

  it('отклоняет uses вместе со script, называя script объявляемым манифестом', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
jobs:
  build:
    steps:
      - id: c
        uses: greet
        script: cleanup.py
`,
    });
    assert.throws(
      () => expandUses(project, isolatedStepRoots(project)),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.message, /script/);
        assert.match(error.message, /объявляет манифест шага/);
        return true;
      },
    );
  });

  it('отклоняет uses вместе с run', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
jobs:
  build:
    steps:
      - id: c
        uses: greet
        run: [echo, hi]
`,
    });
    assert.throws(() => expandUses(project, isolatedStepRoots(project)), StepcastError);
  });

  it('отклоняет uses вместе с prompt', () => {
    const project = makeProject({
      'stepcast.yml': `
kind: pipeline
jobs:
  build:
    steps:
      - id: c
        uses: greet
        prompt: привет
`,
    });
    assert.throws(() => expandUses(project, isolatedStepRoots(project)), StepcastError);
  });
});
