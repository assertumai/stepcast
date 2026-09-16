import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { StepcastError } from '../src/kernel/errors.js';
import {
  findPackageRoot,
  packagedPipelineNames,
  packagedPipelinePath,
  resolvePipelineTarget,
} from '../src/parts/pipeline/domain/package-schema.js';
import { resolveConfig } from '../src/parts/pipeline/config/resolve.js';
import { expandPipeline } from '../src/parts/pipeline/document/expand.js';
import { hasErrors, lintPipeline } from '../src/parts/pipeline/domain/lint.js';
import { createClaudeAdapter } from '../src/parts/backends/claude/adapter.js';
import { resultLine } from '../src/parts/pipeline/backend/fake.js';
import { runPipeline } from '../src/parts/pipeline/run/runner.js';
import { readStatus } from '../src/parts/pipeline/run/journal/reader.js';
import type { AgentInvocation, BackendAdapter, LaunchSpec } from '../src/parts/pipeline/backend/types.js';
import { readProposalsDir } from '../src/parts/pipeline/domain/proposals/store.js';
import { widgetsDirPath } from '../src/parts/ui/widgets.js';
import { makeProject, withHome, type Project } from './helpers.js';
import { tempDir } from './tmp.js';

/**
 * `pipeline-definition`, «Ссылка на поставку называет и пайплайн, а не
 * только схему» (`agent-edits-widgets`, Решение 11): `stepcast:<имя>`
 * раскрывается в файл `src/builtin/pipelines/<имя>.yml` от расположения
 * движка, независимо от каталога запуска.
 */

function project(): string {
  const dir = tempDir('builtin-pipelines-');
  mkdirSync(join(dir, '.git'), { recursive: true });
  return dir;
}

describe('package-schema: packagedPipelinePath', () => {
  it('раскрывает migrate-widgets', () => {
    const path = packagedPipelinePath('migrate-widgets');
    assert.match(path, /src[\\/]builtin[\\/]pipelines[\\/]migrate-widgets\.yml$/);
  });

  it('перечень поставляемых имён содержит migrate-widgets', () => {
    assert.ok(packagedPipelineNames().includes('migrate-widgets'));
  });

  it('неизвестное имя отказывает, перечисляя поставляемые', () => {
    assert.throws(
      () => packagedPipelinePath('no-such-thing'),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.message, /не поставляется/);
        assert.match(error.hint ?? '', /migrate-widgets/);
        return true;
      },
    );
  });

  it('имя с разделителем пути отказывает требованием к слагу', () => {
    assert.throws(
      () => packagedPipelinePath('../secret'),
      (error: unknown) => {
        assert.ok(error instanceof StepcastError);
        assert.match(error.message, /kebab-case/);
        return true;
      },
    );
  });
});

/**
 * `pipeline-definition`, «Путь остаётся путём»: позиционный аргумент без
 * префикса `stepcast:` — файл каталога запуска, даже когда поставка везёт
 * пайплайн с тем же именем. Правило одно на `stepcast run` и `stepcast lint`
 * (`resolvePipelineTarget`), поэтому и проверяется один раз.
 */
describe('package-schema: resolvePipelineTarget', () => {
  it('ссылка stepcast:<имя> ведёт в поставку, а не в каталог запуска', () => {
    const dir = project();
    const resolved = resolvePipelineTarget(dir, 'stepcast:migrate-widgets');
    assert.equal(resolved.isSupplyPipeline, true);
    assert.equal(resolved.pipelinePath, packagedPipelinePath('migrate-widgets'));
  });

  it('migrate-widgets.yml в каталоге запуска остаётся файлом проекта', () => {
    const dir = project();
    const own = join(dir, 'migrate-widgets.yml');
    writeFileSync(own, 'version: 1\nkind: pipeline\nname: мой\njobs: {}\n');

    const resolved = resolvePipelineTarget(dir, 'migrate-widgets.yml');
    assert.equal(resolved.isSupplyPipeline, false);
    assert.equal(resolved.pipelinePath, own);
    assert.notEqual(resolved.pipelinePath, packagedPipelinePath('migrate-widgets'));
  });

  it('голое имя без расширения — тоже путь каталога запуска, не имя поставки', () => {
    const dir = project();
    const resolved = resolvePipelineTarget(dir, 'migrate-widgets');
    assert.equal(resolved.isSupplyPipeline, false);
    assert.equal(resolved.pipelinePath, join(dir, 'migrate-widgets'));
  });
});

describe('builtin pipelines: stepcast:migrate-widgets', () => {
  it('раскрывается и проходит stepcast lint без ошибок', () => {
    const dir = project();
    const pipelinePath = packagedPipelinePath('migrate-widgets');
    const config = resolveConfig({ cwd: dir }).config;

    const expanded = expandPipeline({ pipelinePath, config, projectRoot: dir });
    const diagnostics = lintPipeline(expanded, { config, cwd: dir });

    assert.equal(
      hasErrors(diagnostics),
      false,
      diagnostics.map((d) => d.message).join('\n'),
    );
  });

  /**
   * Права шага и форма вызова в промпте обязаны совпадать: при `enforce:
   * strict` вызов, не подходящий ни под одно право, отклоняется — и миграция
   * завершилась бы «успехом» без единой записи в очереди. Подставной бэкенд
   * прав не применяет (он порождает CLI напрямую), поэтому связка проверяется
   * здесь, на объявлениях.
   */
  it('форма вызова propose из промпта подходит под объявленное право шага', () => {
    const dir = project();
    const config = resolveConfig({ cwd: dir }).config;
    const expanded = expandPipeline({
      pipelinePath: packagedPipelinePath('migrate-widgets'),
      config,
      projectRoot: dir,
    });
    const step = expanded.pipeline.jobs.find((job) => job.id === 'migrate')?.steps[0];
    assert.equal(step?.kind, 'agent');
    const agent = step as Extract<typeof step, { readonly kind: 'agent' }>;
    const allow = agent.permissions?.allow ?? [];

    const command = /^\s*(node "\$STEPCAST_BIN" propose .+)$/m.exec(agent.prompt)?.[1];
    assert.ok(
      command !== undefined,
      'промпт обязан учить надёжной форме вызова движка: node "$STEPCAST_BIN" propose …',
    );

    const bashPrefixes = allow
      .filter((entry) => entry.startsWith('Bash(') && entry.endsWith('*)'))
      .map((entry) => entry.slice('Bash('.length, -'*)'.length));
    assert.ok(
      bashPrefixes.some((prefix) => command.startsWith(prefix)),
      `ни одно право шага не покрывает вызов из промпта: ${command} против ${JSON.stringify(allow)}`,
    );

    assert.ok(!allow.includes('Edit'), 'правки рабочего дерева у шага миграции быть не должно');
    assert.ok(!allow.includes('Write'), 'запись разрешена только в каталог черновиков, а не всюду');
    assert.equal(agent.permissions?.enforce, 'strict');
  });

  it('несёт работы survey и migrate в этом порядке зависимости', () => {
    const dir = project();
    const config = resolveConfig({ cwd: dir }).config;
    const expanded = expandPipeline({
      pipelinePath: packagedPipelinePath('migrate-widgets'),
      config,
      projectRoot: dir,
    });
    const jobIds = expanded.pipeline.jobs.map((job) => job.id);
    assert.deepEqual(jobIds, ['survey', 'migrate']);
    const migrate = expanded.pipeline.jobs.find((job) => job.id === 'migrate');
    assert.deepEqual(migrate?.needs, ['survey']);
  });
});

/**
 * Прогон целиком с поддельным бэкендом (`widget-migration`, «Миграция кладёт
 * результат в очередь», «Мигрировать нечего»): агентский шаг заменён
 * подставным процессом, который ведёт себя ровно как агент, следующий
 * промпту, — правит виджет, кладёт исправленную версию в
 * `$STEPCAST_SCRATCH` и ставит её в очередь настоящей командой `stepcast
 * propose` (собранным бинарём этого же дерева), а не притворяется, что
 * поставил.
 */
describe('builtin pipelines: прогон migrate-widgets с поддельным бэкендом', () => {
  const cliBin = join(findPackageRoot(fileURLToPath(new URL('.', import.meta.url))), 'dist', 'src', 'bin.js');

  /** Бэкенд, ведущий себя как агент, нашедший устаревший виджет `gauge` и починивший его. */
  function migratingAdapter(): BackendAdapter {
    const parser = createClaudeAdapter({
      command: 'фиктивный',
      enabled: true,
      defaultModel: undefined,
      concurrency: 1,
      cacheReadWeight: 0.1,
      sessions: true,
      structuredOutput: true,
      strictPermissions: true,
      mcp: true,
      permissions: undefined,
      env: {},
    });
    return {
      name: 'fake',
      capabilities: { sessions: true, structuredOutput: true, strictPermissions: true, mcp: true, sessionIdSource: 'engine' },
      launch(invocation: AgentInvocation): LaunchSpec {
        const scratchDir = invocation.scratchDir;
        assert.ok(scratchDir !== undefined, 'enforce: strict обязан дать шагу каталог черновиков');
        const draft = join(scratchDir, 'gauge.tsx');
        const fixed = "import { Button } from '@stepcast/ui';\nexport default function G() { return null; }\n";
        const payload = `${resultLine({ text: 'исправил gauge' })}\n`;
        const script = [
          `require('fs').writeFileSync(${JSON.stringify(draft)}, ${JSON.stringify(fixed)});`,
          `require('child_process').execFileSync(process.execPath, [${JSON.stringify(cliBin)}, 'propose', '.stepcast/widgets/gauge.tsx', '--from', ${JSON.stringify(draft)}, '--reason', 'имя ушло из таблицы'], { cwd: ${JSON.stringify(invocation.cwd)}, stdio: 'inherit' });`,
          `process.stdout.write(${JSON.stringify(payload)});`,
        ].join('\n');
        return { command: [process.execPath, '-e', script], stdin: invocation.prompt };
      },
      parseLine: (line) => parser.parseLine(line),
    };
  }

  /** Бэкенд «нечего мигрировать»: агент видит обзор без устаревших и не трогает ничего. */
  function idleAdapter(): BackendAdapter {
    const parser = createClaudeAdapter({
      command: 'фиктивный',
      enabled: true,
      defaultModel: undefined,
      concurrency: 1,
      cacheReadWeight: 0.1,
      sessions: true,
      structuredOutput: true,
      strictPermissions: true,
      mcp: true,
      permissions: undefined,
      env: {},
    });
    return {
      name: 'fake',
      capabilities: { sessions: true, structuredOutput: true, strictPermissions: true, mcp: true, sessionIdSource: 'engine' },
      launch(invocation: AgentInvocation): LaunchSpec {
        const payload = `${resultLine({ text: 'мигрировать нечего' })}\n`;
        return { command: [process.execPath, '-e', `process.stdout.write(${JSON.stringify(payload)});`], stdin: invocation.prompt };
      },
      parseLine: (line) => parser.parseLine(line),
    };
  }

  /** Бэкенд, запоминающий промпт, который увидел агент: вход пайплайна обязан доходить до него текстом. */
  function promptCapturingAdapter(seen: string[]): BackendAdapter {
    const parser = createClaudeAdapter({
      command: 'фиктивный',
      enabled: true,
      defaultModel: undefined,
      concurrency: 1,
      cacheReadWeight: 0.1,
      sessions: true,
      structuredOutput: true,
      strictPermissions: true,
      mcp: true,
      permissions: undefined,
      env: {},
    });
    return {
      name: 'fake',
      capabilities: { sessions: true, structuredOutput: true, strictPermissions: true, mcp: true, sessionIdSource: 'engine' },
      launch(invocation: AgentInvocation): LaunchSpec {
        seen.push(invocation.prompt);
        const payload = `${resultLine({ text: 'промпт прочитан' })}\n`;
        return { command: [process.execPath, '-e', `process.stdout.write(${JSON.stringify(payload)});`], stdin: invocation.prompt };
      },
      parseLine: (line) => parser.parseLine(line),
    };
  }

  async function runMigration(
    adapter: BackendAdapter,
    proj: Project,
    inputs: Record<string, string> = {},
  ): Promise<void> {
    const runsRoot = tempDir('migrate-run-');
    const expanded = expandPipeline({
      pipelinePath: packagedPipelinePath('migrate-widgets'),
      config: proj.config,
      inputs,
      projectRoot: proj.root,
    });
    const result = await runPipeline({
      expanded,
      config: { ...proj.config, runs: { ...proj.config.runs, root: runsRoot } },
      projectRoot: proj.root,
      cwd: proj.root,
      adapterFor: () => adapter,
    });
    if (result.status !== 'success') {
      const status = readStatus(result.journal.paths);
      throw new Error(`прогон не удался: ${JSON.stringify(status.jobs, null, 2)}`);
    }
  }

  it('виджет с устаревшим импортом: файл не изменился, в очереди — открытая запись', async () => {
    const proj = makeProject();
    const widgetPath = join(widgetsDirPath(proj.root), 'gauge.tsx');
    const original = "import { NotAName } from '@stepcast/ui';\nexport default function G() { return null; }\n";
    proj.write('.stepcast/widgets/gauge.tsx', original);

    await withHome(proj.home, () => runMigration(migratingAdapter(), proj));

    assert.equal(readFileSync(widgetPath, 'utf8'), original);
    const result = readProposalsDir(proj.root);
    assert.equal(result.records.length, 1);
    assert.equal(result.records[0]?.target, '.stepcast/widgets/gauge.tsx');
    assert.equal(result.records[0]?.state, 'pending');
    assert.match(result.records[0]?.reason ?? '', /имя ушло/);
  });

  /**
   * `widget-migration`, «Миграцию можно направить на названный виджет»: вход
   * обязан дойти до агента текстом промпта. Автоматически в контекст агента
   * попадают только выходы предшественников, поэтому значение подставляется в
   * сам промпт (`${params.widget}`) — без подстановки запуск с `--input
   * widget=<id>` вёл бы себя ровно как запуск без входа.
   */
  it('вход widget доходит до агента промптом', async () => {
    const proj = makeProject();
    proj.write(
      '.stepcast/widgets/clock.tsx',
      "import { useState } from 'react';\nexport default function C() { return null; }\n",
    );

    const seen: string[] = [];
    await withHome(proj.home, () => runMigration(promptCapturingAdapter(seen), proj, { widget: 'clock' }));

    assert.equal(seen.length, 1);
    assert.match(seen[0] ?? '', /"clock"/);
  });

  it('без входа промпт называет вход пустым, а не подстановкой', async () => {
    const proj = makeProject();
    proj.write(
      '.stepcast/widgets/clock.tsx',
      "import { useState } from 'react';\nexport default function C() { return null; }\n",
    );

    const seen: string[] = [];
    await withHome(proj.home, () => runMigration(promptCapturingAdapter(seen), proj));

    assert.match(seen[0] ?? '', /""/);
    assert.doesNotMatch(seen[0] ?? '', /\$\{params\.widget\}/);
  });

  it('проект без устаревших виджетов: успех без единой записи в очереди', async () => {
    const proj = makeProject();
    proj.write(
      '.stepcast/widgets/clock.tsx',
      "import { useState } from 'react';\nexport default function C() { return null; }\n",
    );

    await withHome(proj.home, () => runMigration(idleAdapter(), proj));

    assert.deepEqual(readProposalsDir(proj.root).records, []);
  });
});
