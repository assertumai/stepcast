import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { resolveConfig } from '../src/core/config/resolve.js';
import { describeSource } from '../src/core/config/merge.js';
import { StepcastError } from '../src/core/errors.js';
import { renderConfigReport } from '../src/cli/commands/config.js';

interface Sandbox {
  readonly home: string;
  readonly cwd: string;
  readonly globalPath: string;
  readonly projectPath: string;
}

function sandbox(files: { global?: string; project?: string }): Sandbox {
  const root = mkdtempSync(join(tmpdir(), 'stepcast-config-'));
  const home = join(root, 'home');
  const cwd = join(root, 'project');
  mkdirSync(join(home, '.stepcast'), { recursive: true });
  mkdirSync(join(cwd, '.stepcast'), { recursive: true });

  const globalPath = join(home, '.stepcast', 'config.yml');
  const projectPath = join(cwd, '.stepcast', 'config.yml');
  if (files.global !== undefined) writeFileSync(globalPath, files.global);
  if (files.project !== undefined) writeFileSync(projectPath, files.project);

  return { home, cwd, globalPath, projectPath };
}

function resolveIn(box: Sandbox, flags?: Record<string, unknown>) {
  return resolveConfig({
    cwd: box.cwd,
    home: box.home,
    globalPath: box.globalPath,
    projectPath: box.projectPath,
    ...(flags === undefined ? {} : { flags }),
  });
}

describe('stepcast-configuration', () => {
  // Сценарий: «Проектный конфиг перекрывает глобальный»
  it('проектный конфиг перекрывает глобальный', () => {
    const box = sandbox({
      global: 'defaults:\n  model: sonnet\n',
      project: 'defaults:\n  model: opus\n',
    });
    const { config, provenance } = resolveIn(box);
    assert.equal(config.defaults.model, 'opus');
    assert.equal(describeSource(provenance.get('defaults.model')!), box.projectPath);
  });

  // Сценарий: «Флаг перекрывает оба файла»
  it('флаг перекрывает оба файла', () => {
    const box = sandbox({
      global: 'defaults:\n  model: sonnet\n',
      project: 'defaults:\n  model: opus\n',
    });
    const { config, provenance } = resolveIn(box, { 'defaults.model': 'haiku' });
    assert.equal(config.defaults.model, 'haiku');
    assert.equal(describeSource(provenance.get('defaults.model')!), '--model (флаг)');
  });

  // Сценарий: «Конфигов нет»
  it('работает на встроенных умолчаниях, когда конфигов нет', () => {
    const box = sandbox({});
    const { config, provenance } = resolveIn(box);
    assert.equal(config.defaults.agent, 'claude');
    assert.equal(config.defaults.workspace.mode, 'cwd');
    assert.equal(config.defaults.session, 'shared');
    assert.equal(config.defaults.concurrency, 1);
    assert.equal(config.defaults.stepTimeoutMs, 30 * 60_000);
    assert.equal(describeSource(provenance.get('defaults.agent')!), 'встроенное умолчание');
  });

  // Сценарий: «Пайплайн добавляет запрет» — на уровне конфигов проверяем то же
  // правило: список пополняется, а не заменяется.
  it('запреты складываются между уровнями', () => {
    const box = sandbox({
      global: 'env_deny: ["AWS_*"]\n',
      project: 'env_deny: ["FOO_*"]\n',
    });
    const { config } = resolveIn(box);
    assert.ok(config.envDeny.includes('AWS_*'));
    assert.ok(config.envDeny.includes('FOO_*'));
  });

  // Сценарий: «Пайплайн не может снять запрет»
  it('пустой список снизу не отменяет запреты сверху', () => {
    const box = sandbox({
      global: 'env_deny: ["AWS_*"]\n',
      project: 'env_deny: []\n',
    });
    const { config } = resolveIn(box);
    assert.ok(config.envDeny.includes('AWS_*'));
  });

  it('встроенные запреты не теряются при добавлении своих', () => {
    const box = sandbox({ project: 'env_deny: ["FOO_*"]\n' });
    const { config } = resolveIn(box);
    assert.ok(config.envDeny.includes('*_TOKEN'), 'встроенный шаблон должен сохраниться');
    assert.ok(config.envDeny.includes('FOO_*'));
  });

  it('потолки можно ужесточить снизу, но не ослабить', () => {
    const tightened = sandbox({
      global: 'limits:\n  tokens: 5M\n',
      project: 'limits:\n  tokens: 1M\n',
    });
    assert.equal(resolveIn(tightened).config.limits.tokens, 1_000_000);

    const loosened = sandbox({
      global: 'limits:\n  tokens: 5M\n',
      project: 'limits:\n  tokens: 9M\n',
    });
    assert.equal(resolveIn(loosened).config.limits.tokens, 5_000_000);
  });

  it('предел ожидания разбирается как длительность и переопределяется слоем', () => {
    const builtin = resolveIn(sandbox({}));
    assert.equal(builtin.config.defaults.maxWaitMs, 6 * 60 * 60 * 1000);

    const overridden = resolveIn(sandbox({ project: 'defaults:\n  max_wait: 30m\n' }));
    assert.equal(overridden.config.defaults.maxWaitMs, 30 * 60 * 1000);
  });

  // Сценарий: «Путь к бэкенду в проектном конфиге»
  it('отклоняет backends.*.command в проектном конфиге', () => {
    const box = sandbox({ project: 'backends:\n  claude:\n    command: /opt/claude\n' });
    assert.throws(
      () => resolveIn(box),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.message, /backends\.claude\.command/);
        assert.equal(error.file, box.projectPath);
        return true;
      },
    );
  });

  it('отклоняет runs.root в проектном конфиге', () => {
    const box = sandbox({ project: 'runs:\n  root: /tmp/runs\n' });
    assert.throws(() => resolveIn(box), StepcastError);
  });

  it('принимает те же ключи в глобальном конфиге', () => {
    const box = sandbox({ global: 'runs:\n  root: /tmp/runs\n' });
    assert.equal(resolveIn(box).config.runs.root, '/tmp/runs');
  });

  it('отклоняет неизвестный ключ', () => {
    const box = sandbox({ project: 'defaults:\n  modle: opus\n' });
    assert.throws(() => resolveIn(box), StepcastError);
  });

  it('отклоняет неразбираемый YAML', () => {
    const box = sandbox({ project: 'defaults:\n  - : :\n   bad\n' });
    assert.throws(() => resolveIn(box), StepcastError);
  });

  it('разворачивает тильду в корне прогонов', () => {
    const box = sandbox({ global: 'runs:\n  root: ~/.stepcast/runs\n' });
    assert.equal(resolveIn(box).config.runs.root, join(box.home, '.stepcast', 'runs'));
  });

  // Сценарий: «Отчёт о конфигурации»
  it('печатает значение и источник для каждого ключа', () => {
    const box = sandbox({
      global: 'defaults:\n  model: sonnet\n',
      project: 'env_deny: ["FOO_*"]\n',
    });
    const lines = renderConfigReport(resolveIn(box));
    const text = lines.join('\n');

    assert.match(text, /defaults\.agent\s+claude\s+встроенное умолчание/);
    assert.match(text, new RegExp(`defaults\\.model\\s+sonnet\\s+${box.globalPath.replace(/[/\\]/g, '\\$&')}`));
    assert.match(text, /limits\.tokens\s+20M/);
    assert.match(text, /defaults\.step_timeout\s+30m/);
  });

  // Сценарий: предел выдержки о прошлой итерации виден наравне с остальными
  // ключами context.*
  it('показывает предел выдержки о прошлой итерации со значением и происхождением', () => {
    const box = sandbox({});
    const lines = renderConfigReport(resolveIn(box));
    const line = lines.find((item) => item.startsWith('context.note_max_tokens'));

    assert.ok(line !== undefined);
    assert.match(line, /встроенное умолчание/);
    assert.doesNotMatch(line, /\bundefined\b/);
  });

  it('в отчёте нет неразрешённых значений ни по одному ключу', () => {
    // Отчёт когда-то читал значения из типизированной конфигурации через
    // таблицу псевдонимов и печатал undefined там, где имена расходились.
    const box = sandbox({});
    for (const line of renderConfigReport(resolveIn(box))) {
      assert.doesNotMatch(line, /\bundefined\b/, `неразрешённое значение: ${line}`);
    }
  });

  it('в отчёте показывает вклад каждого источника в списки запретов', () => {
    const box = sandbox({ project: 'env_deny: ["FOO_*", "BAR_*"]\n' });
    const line = renderConfigReport(resolveIn(box)).find((item) => item.startsWith('env_deny'));
    assert.ok(line !== undefined);
    assert.match(line, /9 шаблонов/);
    assert.match(line, /встроенное умолчание \(7\)/);
    assert.match(line, new RegExp(`${box.projectPath.replace(/[/\\]/g, '\\$&')} \\(2\\)`));
  });
});
