import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { resolveConfig } from '../src/core/config/resolve.js';
import { describeSource, matchesKeyPattern } from '../src/core/config/merge.js';
import { RawSpecSchema, RelativeRepoPathSchema } from '../src/core/config/schema.js';
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

  it('limits.cost по умолчанию $50 и участвует в слиянии как потолок', () => {
    const builtin = resolveIn(sandbox({}));
    assert.equal(builtin.config.limits.costMicroUsd, 50_000_000);

    const tightened = sandbox({
      global: 'limits:\n  cost: 20\n',
      project: 'limits:\n  cost: 5\n',
    });
    assert.equal(resolveIn(tightened).config.limits.costMicroUsd, 5_000_000);

    const loosened = sandbox({
      global: 'limits:\n  cost: 20\n',
      project: 'limits:\n  cost: 100\n',
    });
    assert.equal(resolveIn(loosened).config.limits.costMicroUsd, 20_000_000);
  });

  it('печатает limits.cost в отчёте stepcast config', () => {
    const resolved = resolveIn(sandbox({}));
    const lines = renderConfigReport(resolved);
    assert.ok(lines.some((line) => line.includes('limits.cost') && line.includes('$50.00')));
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

  // Сценарий: «Базовый режим бэкенда»
  it('permissions.enforce из проектного файла доезжает до BackendConfig', () => {
    const box = sandbox({
      project: 'backends:\n  claude:\n    permissions:\n      enforce: strict\n      allow: [Read]\n',
    });
    const { config } = resolveIn(box);
    assert.equal(config.backends.claude?.permissions?.enforce, 'strict');
    assert.deepEqual(config.backends.claude?.permissions?.allow, ['Read']);
  });

  // Встроенный бэкенд claude объявляет возможность применять жёсткий режим.
  it('claude объявляет strictPermissions по умолчанию', () => {
    const { config } = resolveIn(sandbox({}));
    assert.equal(config.backends.claude?.strictPermissions, true);
  });

  // Флаг возможности можно выключить конфигурацией — для CLI, ещё не понимающего флаг.
  it('strict_permissions можно выключить в проектном файле', () => {
    const box = sandbox({ project: 'backends:\n  claude:\n    strict_permissions: false\n' });
    const { config } = resolveIn(box);
    assert.equal(config.backends.claude?.strictPermissions, false);
  });

  // Сценарий: «Происхождение режима наблюдаемо»
  it('источник permissions.enforce виден в разрешённой конфигурации', () => {
    const box = sandbox({ project: 'backends:\n  claude:\n    permissions:\n      enforce: strict\n' });
    const { provenance } = resolveIn(box);
    assert.equal(
      describeSource(provenance.get('backends.claude.permissions.enforce')!),
      box.projectPath,
    );
  });

  // Сценарий: «Команда объявлена в проектном конфиге»
  it('принимает project.check в проектном конфиге', () => {
    const box = sandbox({ project: 'project:\n  check: npm run check\n' });
    const { config, provenance } = resolveIn(box);
    assert.equal(config.project.check, 'npm run check');
    assert.equal(describeSource(provenance.get('project.check')!), box.projectPath);
  });

  // Сценарий: «Пустая команда»
  it('отклоняет пустую project.check', () => {
    const box = sandbox({ project: 'project:\n  check: "   "\n' });
    assert.throws(
      () => resolveIn(box),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.equal(error.at, 'project.check');
        assert.equal(error.file, box.projectPath);
        return true;
      },
    );
  });

  // Сценарий: «Неизвестный ключ секции»
  it('отклоняет неизвестный ключ секции project', () => {
    const box = sandbox({ project: 'project:\n  chek: npm run check\n' });
    assert.throws(() => resolveIn(box), StepcastError);
  });

  // Сценарий: «Команда не объявлена»
  it('project.check отсутствует, если не объявлен ни одним слоем', () => {
    const box = sandbox({});
    const { config } = resolveIn(box);
    assert.equal(config.project.check, undefined);
  });

  // Сценарий: «Команда проверки в глобальном конфиге»
  it('отклоняет project.check в глобальном конфиге', () => {
    const box = sandbox({ global: 'project:\n  check: npm run check\n' });
    assert.throws(
      () => resolveIn(box),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.message, /project\.check/);
        assert.equal(error.file, box.globalPath);
        assert.match(error.hint ?? '', /\.stepcast\/config\.yml/);
        return true;
      },
    );
  });

  // Сценарий: «Проектный конфиг не ограничен этим правилом»
  it('принимает project.check в проектном, даже если глобальный без секции project', () => {
    const box = sandbox({ project: 'project:\n  check: "./gradlew check"\n' });
    assert.doesNotThrow(() => resolveIn(box));
  });

  it('печатает project.check в отчёте stepcast config с файлом-источником', () => {
    const box = sandbox({ project: 'project:\n  check: npm run check\n' });
    const lines = renderConfigReport(resolveIn(box));
    const line = lines.find((item) => item.startsWith('project.check'));
    assert.ok(line !== undefined);
    assert.match(line, /npm run check/);
    assert.match(line, new RegExp(box.projectPath.replace(/[/\\]/g, '\\$&')));
  });

  // Задача 1.3 / Сценарий: «Группа объявлена в проектном конфиге»
  it('принимает project.spec в проектном конфиге и печатает значения в отчёте', () => {
    const box = sandbox({
      project:
        'project:\n  spec:\n    dir: openspec/changes\n    rules: .stepcast/prompts/spec-rules.md\n    tool: openspec\n',
    });
    const resolved = resolveIn(box);
    assert.equal(resolved.config.project.spec.dir, 'openspec/changes');
    assert.equal(resolved.config.project.spec.rules, '.stepcast/prompts/spec-rules.md');
    assert.equal(resolved.config.project.spec.tool, 'openspec');
    assert.equal(describeSource(resolved.provenance.get('project.spec.dir')!), box.projectPath);

    const lines = renderConfigReport(resolved);
    const line = lines.find((item) => item.startsWith('project.spec.tool'));
    assert.ok(line !== undefined);
    assert.match(line, /openspec/);
  });

  // Задача 1.3 / Сценарий: «Часть группы»
  it('принимает часть группы project.spec', () => {
    const box = sandbox({ project: 'project:\n  spec:\n    dir: openspec/changes\n' });
    const { config } = resolveIn(box);
    assert.equal(config.project.spec.dir, 'openspec/changes');
    assert.equal(config.project.spec.rules, undefined);
    assert.equal(config.project.spec.tool, undefined);
  });

  // Задача 1.3 / Сценарий: «Группа не объявлена»
  it('project.spec отсутствует, если не объявлен ни одним слоем', () => {
    const box = sandbox({});
    const { config } = resolveIn(box);
    assert.equal(config.project.spec.dir, undefined);
    assert.equal(config.project.spec.rules, undefined);
    assert.equal(config.project.spec.tool, undefined);
  });

  // Задача 1.2 / Сценарий: «Неизвестный ключ группы»
  it('отклоняет неизвестный ключ группы project.spec', () => {
    const box = sandbox({ project: 'project:\n  spec:\n    folder: openspec/changes\n' });
    assert.throws(() => resolveIn(box), StepcastError);
  });

  // Задача 1.1 / Сценарий: «Пустой каталог документов»
  it('отклоняет пустой project.spec.dir', () => {
    const box = sandbox({ project: 'project:\n  spec:\n    dir: "   "\n' });
    assert.throws(
      () => resolveIn(box),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.equal(error.at, 'project.spec.dir');
        assert.equal(error.file, box.projectPath);
        return true;
      },
    );
  });

  // Задача 1.1 / Сценарий: «Абсолютный путь»
  it('отклоняет абсолютный путь project.spec.dir', () => {
    const box = sandbox({ project: 'project:\n  spec:\n    dir: /tmp/changes\n' });
    assert.throws(
      () => resolveIn(box),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.equal(error.at, 'project.spec.dir');
        return true;
      },
    );
  });

  // Задача 1.1 / Сценарий: «Выход за корень репозитория»
  it('отклоняет project.spec.rules с сегментом ..', () => {
    const box = sandbox({ project: 'project:\n  spec:\n    rules: "../rules.md"\n' });
    assert.throws(
      () => resolveIn(box),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.equal(error.at, 'project.spec.rules');
        return true;
      },
    );
  });
});

describe('stepcast-configuration: модель относительного пути репозитория', () => {
  // Задача 1.1
  it('принимает непустой относительный путь', () => {
    assert.equal(RelativeRepoPathSchema.safeParse('openspec/changes').success, true);
  });

  it('отклоняет пустую строку', () => {
    assert.equal(RelativeRepoPathSchema.safeParse('').success, false);
  });

  it('отклоняет строку из пробелов', () => {
    assert.equal(RelativeRepoPathSchema.safeParse('   ').success, false);
  });

  it('отклоняет абсолютный путь', () => {
    assert.equal(RelativeRepoPathSchema.safeParse('/tmp/changes').success, false);
  });

  it('отклоняет путь с сегментом ..', () => {
    assert.equal(RelativeRepoPathSchema.safeParse('../changes').success, false);
  });
});

describe('stepcast-configuration: RawSpecSchema', () => {
  // Задача 1.2
  it('принимает полную группу', () => {
    const result = RawSpecSchema.safeParse({
      dir: 'openspec/changes',
      rules: '.stepcast/prompts/spec-rules.md',
      tool: 'openspec',
    });
    assert.equal(result.success, true);
  });

  it('принимает любую часть группы', () => {
    assert.equal(RawSpecSchema.safeParse({ dir: 'openspec/changes' }).success, true);
    assert.equal(RawSpecSchema.safeParse({}).success, true);
  });

  it('отклоняет неизвестный ключ группы', () => {
    assert.equal(RawSpecSchema.safeParse({ folder: 'openspec/changes' }).success, false);
  });
});

describe('stepcast-configuration: запрет глобального слоя на вложенных ключах', () => {
  // Задача 2.1
  it('project.** ловит ключ первого уровня и вложенный, не ловит соседнюю секцию', () => {
    assert.equal(matchesKeyPattern('project.check', 'project.**'), true);
    assert.equal(matchesKeyPattern('project.spec.dir', 'project.**'), true);
    assert.equal(matchesKeyPattern('defaults.model', 'project.**'), false);
  });

  it('отклоняет форму ** посередине шаблона', () => {
    assert.throws(() => matchesKeyPattern('project.spec.dir', 'project.**.dir'));
  });

  // Задача 2.2 / Сценарий: «Вложенный ключ в глобальном конфиге»
  it('отклоняет project.spec.dir в глобальном конфиге, называя ключ и .stepcast/config.yml', () => {
    const box = sandbox({ global: 'project:\n  spec:\n    dir: openspec/changes\n' });
    assert.throws(
      () => resolveIn(box),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.message, /project\.spec\.dir/);
        assert.equal(error.file, box.globalPath);
        assert.match(error.hint ?? '', /\.stepcast\/config\.yml/);
        return true;
      },
    );
  });

  // Задача 2.2 / Сценарий: «Ключ первого уровня по-прежнему отклоняется»
  it('по-прежнему отклоняет project.check в глобальном конфиге', () => {
    const box = sandbox({ global: 'project:\n  check: npm run check\n' });
    assert.throws(
      () => resolveIn(box),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.message, /project\.check/);
        return true;
      },
    );
  });

  // Задача 2.2 / Сценарий: «Проектный конфиг не ограничен запретом»
  it('принимает project.spec.dir в проектном конфиге', () => {
    const box = sandbox({ project: 'project:\n  spec:\n    dir: docs/changes\n' });
    assert.doesNotThrow(() => resolveIn(box));
  });

  // Задача 2.2 / Сценарий: «Соседняя секция не задета шаблоном»
  it('не задевает соседнюю секцию defaults в глобальном конфиге', () => {
    const box = sandbox({ global: 'defaults:\n  model: sonnet\n' });
    assert.doesNotThrow(() => resolveIn(box));
  });
});
