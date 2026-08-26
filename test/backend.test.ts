import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { createClaudeAdapter } from '../src/core/backend/claude.js';
import { createFakeBackend, initLine, resultLine, toolUseLine } from '../src/core/backend/fake.js';
import { emptyUsage, mergeUsage, sumUsage } from '../src/core/backend/types.js';
import { createSessionRegistry, executeAgentStep } from '../src/core/exec/agentStep.js';
import type { BackendConfig } from '../src/core/config/resolve.js';
import type { AgentStep } from '../src/core/pipeline/model.js';

const BACKEND: BackendConfig = {
  command: 'claude',
  enabled: true,
  defaultModel: 'sonnet',
  concurrency: 2,
  cacheReadWeight: 0.1,
  sessions: true,
  structuredOutput: true,
  permissions: undefined,
  env: {},
};

function workdir(): string {
  return mkdtempSync(join(tmpdir(), 'stepcast-backend-'));
}

function makeAgentStep(overrides: Partial<AgentStep> = {}): AgentStep {
  return {
    kind: 'agent',
    id: 'ask',
    index: 1,
    env: {},
    context: [],
    contextInherit: true,
    contextExclude: [],
    timeoutMs: 5_000,
    expect: [],
    attempts: { max: 1, escalation: [] },
    agent: 'fake',
    session: 'default',
    prompt: 'сделай',
    ...overrides,
  } as AgentStep;
}

describe('agent-backend: сборка запуска', () => {
  it('запускает неинтерактивно с потоковым структурированным выводом', () => {
    const spec = createClaudeAdapter(BACKEND).launch({
      prompt: 'привет',
      cwd: '/tmp',
      resumeSession: false,
    });

    assert.deepEqual(spec.command.slice(0, 5), [
      'claude',
      '--print',
      '--output-format',
      'stream-json',
      '--verbose',
    ]);
    assert.equal(spec.stdin, 'привет', 'промпт уходит через stdin, не аргументом');
  });

  // Сценарий: «Ограничение инструментов на шаге»
  it('транслирует политику доступа в параметры запуска', () => {
    const spec = createClaudeAdapter(BACKEND).launch({
      prompt: 'p',
      cwd: '/tmp',
      resumeSession: false,
      permissions: { mode: 'acceptEdits', allow: ['Edit', 'Read'], deny: ['Bash(rm *)'] },
    });

    assert.ok(spec.command.includes('--permission-mode'));
    assert.ok(spec.command.includes('acceptEdits'));
    assert.equal(spec.command[spec.command.indexOf('--allowedTools') + 1], 'Edit Read');
    assert.equal(spec.command[spec.command.indexOf('--disallowedTools') + 1], 'Bash(rm *)');
  });

  it('берёт политику бэкенда, когда шаг её не объявил', () => {
    const spec = createClaudeAdapter({
      ...BACKEND,
      permissions: { mode: 'auto', allow: ['Read'] },
    }).launch({ prompt: 'p', cwd: '/tmp', resumeSession: false });

    assert.ok(spec.command.includes('--permission-mode'));
    assert.ok(spec.command.includes('auto'));
  });

  it('начинает сессию с идентификатором и продолжает её потом', () => {
    const adapter = createClaudeAdapter(BACKEND);
    const first = adapter.launch({ prompt: 'p', cwd: '/tmp', sessionId: 'sid', resumeSession: false });
    const second = adapter.launch({ prompt: 'p', cwd: '/tmp', sessionId: 'sid', resumeSession: true });

    assert.equal(first.command[first.command.indexOf('--session-id') + 1], 'sid');
    assert.equal(second.command[second.command.indexOf('--resume') + 1], 'sid');
  });

  it('передаёт схему вывода бэкенду', () => {
    const dir = workdir();
    const schemaPath = join(dir, 'plan.json');
    writeFileSync(schemaPath, '{"type":"object"}');

    const spec = createClaudeAdapter(BACKEND).launch({
      prompt: 'p',
      cwd: dir,
      resumeSession: false,
      outputSchemaPath: schemaPath,
    });
    assert.equal(spec.command[spec.command.indexOf('--json-schema') + 1], '{"type":"object"}');
  });
});

describe('agent-backend: разбор потока', () => {
  const adapter = createClaudeAdapter(BACKEND);

  it('различает инициализацию, вызов инструмента и результат', () => {
    assert.equal(adapter.parseLine(initLine({ plugins: [] })).kind, 'init');
    assert.equal(adapter.parseLine(toolUseLine('Read', { file_path: 'a.ts' })).kind, 'tool_use');
    assert.equal(adapter.parseLine(resultLine({ text: 'готово' })).kind, 'result');
  });

  it('не теряет usage, когда Claude сообщает его рядом с tool_use', () => {
    const event = adapter.parseLine(
      JSON.stringify({
        type: 'assistant',
        message: {
          id: 'msg-usage-tool',
          content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'src/a.ts' } }],
          usage: { input_tokens: 2, output_tokens: 3, cache_read_input_tokens: 40 },
        },
      }),
    ) as unknown as {
      readonly kind: string;
      readonly messageId?: string;
      readonly name?: string;
      readonly usage?: { readonly tokens_in?: number; readonly cache_read?: number };
    };

    assert.equal(event.kind, 'tool_use');
    assert.equal(event.messageId, 'msg-usage-tool');
    assert.equal(event.name, 'Read');
    assert.equal(event.usage?.tokens_in, 2);
    assert.equal(event.usage?.cache_read, 40);
  });

  // Сценарий: «Битая строка потока»
  it('не роняет шаг на неразбираемой строке и молчит о неизвестной', () => {
    assert.deepEqual(adapter.parseLine('{это не json'), {
      kind: 'unparsed',
      line: '{это не json',
    });
    assert.equal(adapter.parseLine('{"type":"неизвестное_будущее_поле"}').kind, 'ignored');
    assert.equal(adapter.parseLine('   ').kind, 'ignored');
  });

  // Сценарий: «Бэкенд не сообщает запись кеша»
  it('несообщённое поле остаётся отсутствующим, а не нулём', () => {
    const event = adapter.parseLine(resultLine({ tokensIn: 100, tokensOut: 20 }));
    assert.equal(event.kind, 'result');
    const usage = mergeUsage(emptyUsage('claude', 'sonnet', 0), event.usage);

    assert.equal(usage.tokens_in, 100);
    assert.equal(usage.cache_write, null, 'ноль превратил бы неполный учёт в мнимую точность');
  });

  // Спека stepcast-configuration: «sumUsage переносит цену»
  it('parseLine читает цену судьи тем же полем total_cost_usd, что и цену шага', () => {
    const event = adapter.parseLine(resultLine({ tokensIn: 1, costUsd: 0.42 }));
    assert.equal(event.kind, 'result');
    assert.equal(event.usage?.reported_cost_usd, 0.42);
  });

  it('sumUsage складывает цену шага и судьи', () => {
    const step = mergeUsage(emptyUsage('claude', 'sonnet', 0), { reported_cost_usd: 0.1 });
    const judge = mergeUsage(emptyUsage('claude', 'sonnet', 0), { reported_cost_usd: 0.05 });
    const summed = sumUsage(step, judge);
    assert.ok(Math.abs((summed.reported_cost_usd ?? 0) - 0.15) < 1e-9);
  });

  it('sumUsage не теряет цену шага при сложении с судьёй без цены', () => {
    const step = mergeUsage(emptyUsage('claude', 'sonnet', 0), { reported_cost_usd: 0.1 });
    const judgeNoCost = emptyUsage('claude', 'sonnet', 0);
    const summed = sumUsage(step, judgeNoCost);
    assert.equal(summed.reported_cost_usd, 0.1);
  });

  it('sumUsage двух слагаемых без цены даёт запись без поля', () => {
    const a = emptyUsage('claude', 'sonnet', 0);
    const b = emptyUsage('claude', 'sonnet', 0);
    const summed = sumUsage(a, b);
    assert.equal('reported_cost_usd' in summed, false);
  });

  // Сценарий: «Окна лимитов»
  it('сохраняет все окна лимитов', () => {
    const line = JSON.stringify({
      type: 'result',
      usage: { input_tokens: 1 },
      rate_limits: {
        five_hour: { used_percentage: 37, resets_at: 1786000000 },
        seven_day: { used_percentage: 61 },
      },
    });
    const event = adapter.parseLine(line);
    assert.equal(event.kind, 'result');
    assert.equal(event.usage?.rate_limits?.five_hour?.used_pct, 37);
    assert.equal(event.usage?.rate_limits?.seven_day?.used_pct, 61);
  });
});

describe('agent-backend: исполнение шага', () => {
  // Сценарий: «Второй шаг видит первый»
  it('второй шаг общей сессии продолжает диалог первого', async () => {
    const dir = workdir();
    const backend = createFakeBackend({ lines: [initLine(), resultLine({ text: 'ок' })] });
    const sessions = createSessionRegistry();

    for (const id of ['read', 'draft']) {
      await executeAgentStep({
        step: makeAgentStep({ id, session: 'default' }),
        adapter: backend.adapter,
        cwd: dir,
        stepDir: dir,
        sessions,
        buildPrompt: () => 'промпт',
        env: () => ({ PATH: process.env.PATH ?? '' }),
      });
    }

    assert.equal(backend.invocations.length, 2);
    assert.equal(backend.invocations[0]?.resumeSession, false, 'первая начинает сессию');
    assert.equal(backend.invocations[1]?.resumeSession, true, 'вторая продолжает');
    assert.equal(backend.invocations[0]?.sessionId, backend.invocations[1]?.sessionId);
  });

  // Сценарий: «Раздельные сессии»
  it('шаги разных сессий не видят диалог друг друга', async () => {
    const dir = workdir();
    const backend = createFakeBackend({ lines: [resultLine({ text: 'ок' })] });
    const sessions = createSessionRegistry();

    for (const session of ['analysis', 'writing']) {
      await executeAgentStep({
        step: makeAgentStep({ id: session, session }),
        adapter: backend.adapter,
        cwd: dir,
        stepDir: dir,
        sessions,
        buildPrompt: () => 'промпт',
        env: () => ({ PATH: process.env.PATH ?? '' }),
      });
    }

    assert.notEqual(backend.invocations[0]?.sessionId, backend.invocations[1]?.sessionId);
    assert.equal(backend.invocations[1]?.resumeSession, false);
  });

  // Сценарий: «Бэкенд без поддержки сессий»
  it('деградирует до отдельных сессий, когда бэкенд их не умеет', async () => {
    const dir = workdir();
    const backend = createFakeBackend({
      capabilities: { sessions: false },
      lines: [resultLine({ text: 'ок' })],
    });
    const sessions = createSessionRegistry();

    for (const id of ['a', 'b']) {
      await executeAgentStep({
        step: makeAgentStep({ id, session: 'default' }),
        adapter: backend.adapter,
        cwd: dir,
        stepDir: dir,
        sessions,
        buildPrompt: () => 'промпт',
        env: () => ({ PATH: process.env.PATH ?? '' }),
      });
    }

    assert.equal(backend.invocations[0]?.sessionId, undefined);
    assert.equal(backend.invocations[1]?.resumeSession, false);
  });

  it('сохраняет промпт целиком и снимает расход из потока', async () => {
    const dir = workdir();
    const backend = createFakeBackend({
      lines: [initLine({ mcp_servers: [] }), resultLine({ text: 'готово', tokensIn: 120, tokensOut: 30 })],
    });

    const result = await executeAgentStep({
      step: makeAgentStep(),
      adapter: backend.adapter,
      cwd: dir,
      stepDir: dir,
      sessions: createSessionRegistry(),
      buildPrompt: () => 'полный промпт с контекстом',
      env: () => ({ PATH: process.env.PATH ?? '' }),
    });

    assert.equal(result.status, 'success');
    assert.equal(readFileSync(join(dir, 'prompt.txt'), 'utf8'), 'полный промпт с контекстом');
    assert.equal(result.last?.usage.tokens_in, 120);
    assert.equal(result.last?.backendInit?.mcp_servers !== undefined, true);
  });

  it('суммирует уникальные streaming usage и не дублирует один message id', async () => {
    const dir = workdir();
    const assistant = (id: string, tokens: number, tool = false): string =>
      JSON.stringify({
        type: 'assistant',
        message: {
          id,
          content: tool ? [{ type: 'tool_use', name: 'Read', input: { file_path: 'src/a.ts' } }] : [],
          usage: { input_tokens: tokens },
        },
      });
    const backend = createFakeBackend({
      lines: [assistant('msg-1', 60), assistant('msg-1', 60, true), assistant('msg-2', 60), resultLine({ text: 'ок' })],
    });
    const reported: Array<[number, number, number]> = [];

    const result = await executeAgentStep({
      step: makeAgentStep(),
      adapter: backend.adapter,
      cwd: dir,
      stepDir: dir,
      sessions: createSessionRegistry(),
      buildPrompt: () => 'промпт',
      env: () => ({ PATH: process.env.PATH ?? '' }),
      onUsage: (usage, attempt) => reported.push([usage.tokens_in ?? 0, usage.wallclock_ms, attempt]),
    });

    // Два уникальных сообщения дают нарастающий итог 60 и 120; повтор `msg-1`
    // не добавляет ничего. Третья отправка — итоговая, после завершения
    // процесса: те же токены, но уже с измеренной длительностью, ради которой
    // она и делается.
    assert.deepEqual(
      reported.map(([tokens]) => tokens),
      [60, 120, 120],
    );
    assert.deepEqual(
      reported.map(([, , attempt]) => attempt),
      [1, 1, 1],
      'номер попытки сообщается вместе с расходом',
    );
    assert.equal(reported.at(-1)?.[1] !== 0, true, 'итоговая отправка несёт длительность');
    assert.equal(result.last?.usage.tokens_in, 120);
  });

  // Сценарий: «Фиксация инициализации»
  it('записывает наблюдённые входы по вызовам инструментов чтения', async () => {
    const dir = workdir();
    const backend = createFakeBackend({
      lines: [
        toolUseLine('Read', { file_path: 'src/b.ts' }),
        toolUseLine('Read', { file_path: 'src/a.ts' }),
        toolUseLine('Bash', { command: 'ls' }),
        resultLine({ text: 'ок' }),
      ],
    });

    const result = await executeAgentStep({
      step: makeAgentStep(),
      adapter: backend.adapter,
      cwd: dir,
      stepDir: dir,
      sessions: createSessionRegistry(),
      buildPrompt: () => 'промпт',
      env: () => ({ PATH: process.env.PATH ?? '' }),
    });

    assert.deepEqual(result.last?.observedInputs, ['src/a.ts', 'src/b.ts']);
  });

  it('передаёт причину отказа следующей попытке при include_failure', async () => {
    const dir = workdir();
    const backend = createFakeBackend({ lines: [resultLine({ text: 'плохо' })] });
    const seen: Array<string | undefined> = [];

    await executeAgentStep({
      step: makeAgentStep({
        attempts: { max: 2, escalation: [{ includeFailure: true, model: 'opus' }] },
      }),
      adapter: backend.adapter,
      cwd: dir,
      stepDir: dir,
      sessions: createSessionRegistry(),
      buildPrompt: (_plan, previousFailure) => {
        seen.push(previousFailure);
        return 'промпт';
      },
      env: () => ({ PATH: process.env.PATH ?? '' }),
      evaluate: () => [
        { predicate: 'schema', passed: false, hard: true, detail: 'поле tasks отсутствует' },
      ],
    });

    assert.equal(seen.length, 2);
    assert.equal(seen[0], undefined, 'первая попытка идёт как объявлено');
    assert.match(seen[1] ?? '', /поле tasks отсутствует/);
    assert.equal(backend.invocations[1]?.model, 'opus', 'ступень эскалации меняет модель');
  });

  it('пишет логи каждой попытки отдельно', async () => {
    const dir = workdir();
    const backend = createFakeBackend({ lines: [resultLine({ text: 'ок' })], exitCode: 1 });

    await executeAgentStep({
      step: makeAgentStep({ attempts: { max: 2, escalation: [] } }),
      adapter: backend.adapter,
      cwd: dir,
      stepDir: dir,
      sessions: createSessionRegistry(),
      buildPrompt: () => 'промпт',
      env: () => ({ PATH: process.env.PATH ?? '' }),
    });

    assert.ok(existsSync(join(dir, 'prompt.txt')));
    assert.ok(existsSync(join(dir, 'prompt.2.txt')));
    assert.ok(existsSync(join(dir, 'stdout.2.log')));
  });
});

describe('step-context: контекст и общая сессия', () => {
  it('унаследованный контекст уходит только в первое сообщение сессии', async () => {
    // Отслеживание «сессия уже начата» однажды жило внутри шага, и свод правил
    // пайплайна уходил агенту заново на каждом шаге общей сессии.
    const dir = workdir();
    const backend = createFakeBackend({ lines: [resultLine({ text: 'ок' })] });
    const sessions = createSessionRegistry();
    const contextSent = new Set<string>();
    const sentInherited: boolean[] = [];

    for (const id of ['first', 'second']) {
      await executeAgentStep({
        step: makeAgentStep({ id, session: 'default' }),
        adapter: backend.adapter,
        cwd: dir,
        stepDir: dir,
        sessions,
        buildPrompt: () => {
          const first = !contextSent.has('default');
          contextSent.add('default');
          sentInherited.push(first);
          return 'промпт';
        },
        env: () => ({ PATH: process.env.PATH ?? '' }),
      });
    }

    assert.deepEqual(sentInherited, [true, false]);
  });
});
