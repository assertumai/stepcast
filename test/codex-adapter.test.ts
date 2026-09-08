import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import codexPlugin, { createCodexAdapter, SANDBOX_MODES } from '../src/backends/codex/index.js';
import type { BackendConfig } from '../src/plugin.js';
import type { AgentInvocation, BackendAdapter, BackendEvent } from '../src/core/backend/types.js';
import { createSessionRegistry, executeAgentStep } from '../src/core/exec/agentStep.js';
import { StepcastError } from '../src/core/errors.js';
import type { AgentStep } from '../src/core/pipeline/model.js';
import { tempDir } from './tmp.js';

/**
 * Разбор проверяется на потоке, записанном с настоящего CLI
 * (`test/fixtures/codex/README.md`), — не на сочинённом. Сочинённая строка
 * допустима ровно в одном качестве: заведомо битая.
 */
const FIXTURES = fileURLToPath(new URL('../../test/fixtures/codex/', import.meta.url));

function fixture(name: string): string[] {
  return readFileSync(join(FIXTURES, name), 'utf8').split('\n').filter((line) => line.trim() !== '');
}

const CONFIG: BackendConfig = {
  command: 'codex',
  enabled: true,
  defaultModel: undefined,
  concurrency: 2,
  cacheReadWeight: 0.1,
  sessions: true,
  structuredOutput: true,
  strictPermissions: false,
  mcp: true,
  permissions: undefined,
  env: {},
};

function invocation(overrides: Partial<AgentInvocation> = {}): AgentInvocation {
  return { prompt: 'сделай', cwd: '/tmp/work', resumeSession: false, ...overrides };
}

function events(adapter: BackendAdapter, lines: readonly string[]): BackendEvent[] {
  return lines.map((line) => adapter.parseLine(line));
}

function ofKind<K extends BackendEvent['kind']>(list: readonly BackendEvent[], kind: K): Extract<BackendEvent, { kind: K }>[] {
  return list.filter((event): event is Extract<BackendEvent, { kind: K }> => event.kind === kind);
}

describe('codex-backend: сборка запуска', () => {
  const adapter = createCodexAdapter(CONFIG);

  // Сценарий: «Промпт и схема»
  it('новая нить: exec --json, схема путём, подтверждения выключены, промпт со stdin', () => {
    const launch = adapter.launch(invocation({ outputSchemaPath: '/tmp/schema.json' }));

    assert.deepEqual(launch.command.slice(0, 4), ['codex', 'exec', '--json', '--skip-git-repo-check']);
    assert.ok(launch.command.includes('--output-schema'));
    assert.equal(launch.command[launch.command.indexOf('--output-schema') + 1], '/tmp/schema.json');
    assert.ok(launch.command.includes('approval_policy="never"'));
    assert.equal(launch.command.at(-1), '-', 'промпт читается со stdin');
    assert.equal(launch.stdin, 'сделай');
    assert.ok(!launch.command.includes('resume'));
    assert.ok(!launch.command.includes('-C'), 'рабочий каталог задаёт движок процессом');
  });

  // Сценарий: «Модель шага»
  it('модель шага побеждает умолчание бэкенда и уходит в -m', () => {
    const launch = createCodexAdapter({ ...CONFIG, defaultModel: 'gpt-5' }).launch(invocation({ model: 'o3' }));
    assert.equal(launch.command[launch.command.indexOf('-m') + 1], 'o3');

    const fallback = createCodexAdapter({ ...CONFIG, defaultModel: 'gpt-5' }).launch(invocation());
    assert.equal(fallback.command[fallback.command.indexOf('-m') + 1], 'gpt-5');
  });

  // Сценарий: «Продолжение нити»
  it('продолжение — форма resume с тем же набором флагов', () => {
    const launch = adapter.launch(
      invocation({ sessionId: 'thread-1', resumeSession: true, outputSchemaPath: '/tmp/schema.json', model: 'o3' }),
    );

    assert.deepEqual(launch.command.slice(0, 6), ['codex', 'exec', 'resume', 'thread-1', '--json', '--skip-git-repo-check']);
    assert.ok(launch.command.includes('--output-schema'));
    assert.equal(launch.command[launch.command.indexOf('-m') + 1], 'o3');
    assert.ok(launch.command.includes('approval_policy="never"'));
    for (const absent of ['-s', '-C', '--add-dir']) assert.ok(!launch.command.includes(absent), `у resume нет ${absent}`);
    assert.equal(launch.command.at(-1), '-');
  });

  // Сценарий: «Первый запуск без идентификатора»
  it('без идентификатора формы resume нет', () => {
    const launch = adapter.launch(invocation({ resumeSession: false }));
    assert.ok(!launch.command.includes('resume'));
  });

  it('идентификатор без признака продолжения не передаётся: начать нить с чужим id CLI не умеет', () => {
    const launch = adapter.launch(invocation({ sessionId: 'thread-1', resumeSession: false }));
    assert.ok(!launch.command.includes('thread-1'));
  });

  it('схема не передаётся, если возможность выключена в конфигурации', () => {
    const launch = createCodexAdapter({ ...CONFIG, structuredOutput: false }).launch(
      invocation({ outputSchemaPath: '/tmp/schema.json' }),
    );
    assert.ok(!launch.command.includes('--output-schema'));
  });

  it('окружение бэкенда доходит до запуска', () => {
    const launch = createCodexAdapter({ ...CONFIG, env: { CODEX_HOME: '/opt/codex' } }).launch(invocation());
    assert.deepEqual(launch.env, { CODEX_HOME: '/opt/codex' });
  });
});

describe('codex-backend: перевод политики доступа', () => {
  const adapter = createCodexAdapter(CONFIG);

  // Сценарий: «Режим переводится»
  it('mode из словаря CLI уходит в -c sandbox_mode', () => {
    for (const mode of SANDBOX_MODES) {
      const launch = adapter.launch(invocation({ permissions: { mode } }));
      assert.ok(launch.command.includes(`sandbox_mode="${mode}"`), mode);
    }
  });

  it('без политики ни песочницы, ни отказа', () => {
    const launch = adapter.launch(invocation());
    assert.ok(!launch.command.some((arg) => arg.startsWith('sandbox_mode=')));
  });

  // Сценарий: «Режим вне словаря бэкенда»
  it('режим Claude Code отказывает, называя словарь Codex', () => {
    assert.throws(
      () => adapter.launch(invocation({ permissions: { mode: 'acceptEdits' } })),
      (error: unknown) =>
        error instanceof StepcastError &&
        /codex/.test(error.message) &&
        /acceptEdits/.test(error.message) &&
        /read-only, workspace-write, danger-full-access/.test(error.hint ?? ''),
    );
  });

  // Сценарий: «Списки не переводятся»
  it('allow и deny отказывают до запуска процесса, называя списки', () => {
    for (const permissions of [{ allow: ['Bash(git *)'] }, { deny: ['Write'] }, { mode: 'read-only', allow: ['Read'] }]) {
      assert.throws(
        () => adapter.launch(invocation({ permissions })),
        (error: unknown) =>
          error instanceof StepcastError &&
          /codex/.test(error.message) &&
          /пооперационных списков/.test(error.message) &&
          new RegExp((permissions.allow ?? permissions.deny ?? [])[0]!.replace(/[()*]/g, '.')).test(error.message),
        JSON.stringify(permissions),
      );
    }
  });

  it('политика из конфигурации бэкенда действует как база', () => {
    const withBase = createCodexAdapter({ ...CONFIG, permissions: { mode: 'workspace-write' } });
    assert.ok(withBase.launch(invocation()).command.includes('sandbox_mode="workspace-write"'));
    assert.ok(
      withBase.launch(invocation({ permissions: { mode: 'read-only' } })).command.includes('sandbox_mode="read-only"'),
      'ближайшее объявление побеждает целиком',
    );
  });

  it('enforce: strict отказывает и в адаптере, не только в предстартовом гейте', () => {
    assert.throws(
      () => adapter.launch(invocation({ permissions: { mode: 'read-only', enforce: 'strict' } })),
      (error: unknown) => error instanceof StepcastError && /enforce: strict/.test(error.message),
    );
  });
});

describe('codex-backend: перевод объявления MCP-серверов', () => {
  const adapter = createCodexAdapter(CONFIG);

  // Сценарий: «Процессный сервер»
  it('процессный сервер — command, args, env переопределениями -c', () => {
    const launch = adapter.launch(
      invocation({ mcpServers: { probe: { command: ['npx', '-y', 'srv'], env: { TOKEN_FILE: '/run/t' } } } }),
    );
    const overrides = launch.command.filter((_, index) => launch.command[index - 1] === '-c');
    assert.ok(overrides.includes('mcp_servers.probe.command="npx"'));
    assert.ok(overrides.includes('mcp_servers.probe.args=["-y","srv"]'));
    assert.ok(overrides.includes('mcp_servers.probe.env={ "TOKEN_FILE" = "/run/t" }'), 'таблица TOML, не JSON');
  });

  it('HTTP-сервер — url и http_headers', () => {
    const launch = adapter.launch(
      invocation({ mcpServers: { remote: { url: 'https://mcp.example/x', headers: { Authorization: 'Bearer t' } } } }),
    );
    assert.ok(launch.command.includes('mcp_servers.remote.url="https://mcp.example/x"'));
    assert.ok(launch.command.includes('mcp_servers.remote.http_headers={ "Authorization" = "Bearer t" }'));
  });

  it('имя сервера вне голого ключа TOML берётся в кавычки', () => {
    const launch = adapter.launch(invocation({ mcpServers: { 'my.server': { command: ['x'] } } }));
    assert.ok(launch.command.includes('mcp_servers."my.server".command="x"'));
  });

  it('при mcp: false переопределения не собираются', () => {
    const launch = createCodexAdapter({ ...CONFIG, mcp: false }).launch(
      invocation({ mcpServers: { probe: { command: ['npx'] } } }),
    );
    assert.ok(!launch.command.some((arg) => arg.startsWith('mcp_servers.')));
  });
});

describe('codex-backend: разбор записанного потока', () => {
  const adapter = createCodexAdapter(CONFIG);

  // Сценарий: «Начало нити»
  it('run1: thread.started — init с идентификатором сессии и без состава серверов', () => {
    const [first] = events(adapter, fixture('run1.jsonl'));
    assert.equal(first?.kind, 'init');
    if (first?.kind !== 'init') return;
    assert.equal(first.sessionId, '01a07fb9-5e9f-74d0-8e7f-ea9dbfecdda3');
    assert.equal(first.mcpServers, undefined, 'поток состав серверов не сообщает — сличения нет');
    assert.equal(first.data.type, 'thread.started');
  });

  // Сценарий: «Вызов инструмента»
  it('run1: command_execution даёт tool_use один раз — на item.completed, без вывода команды', () => {
    const list = events(adapter, fixture('run1.jsonl'));
    const tools = ofKind(list, 'tool_use');
    assert.equal(tools.length, 1);
    assert.equal(tools[0]?.name, 'command_execution');
    const input = tools[0]?.input as Record<string, unknown>;
    assert.equal(typeof input.command, 'string');
    assert.ok(!('aggregated_output' in input), 'вывод команды — не вход вызова');
    // `item.started` той же записи — пропущено, `turn.started` — тоже.
    assert.equal(list[1]?.kind, 'ignored');
    assert.equal(list[3]?.kind, 'ignored');
  });

  // Сценарий: «Структурированный вывод»
  it('run1: оба agent_message дают result с текстом и разобранной структурой; последнее побеждает у движка', () => {
    const results = ofKind(events(adapter, fixture('run1.jsonl')), 'result');
    assert.equal(results.length, 2);
    assert.deepEqual(results[1]?.structured, { answer: 'Два плюс два — четыре.', n: 4 });
    assert.equal(results[1]?.text, '{"answer":"Два плюс два — четыре.","n":4}');
    assert.equal(results[0]?.failed, undefined);
  });

  // Сценарий: «Расход турна»
  it('run1: turn.completed — расход с вычетом кеша из входных, без стоимости и окон', () => {
    const [usage] = ofKind(events(adapter, fixture('run1.jsonl')), 'usage');
    assert.deepEqual(usage?.usage, { tokens_in: 35240 - 16640, cache_read: 16640, cache_write: 0, tokens_out: 303 });
    assert.equal(usage?.messageId, undefined);
  });

  it('run2 и run4: продолжение нити сообщает тот же thread_id', () => {
    for (const name of ['run2.jsonl', 'run4.jsonl']) {
      const [first] = events(adapter, fixture(name));
      assert.equal(first?.kind === 'init' ? first.sessionId : undefined, '01a07fb9-5e9f-74d0-8e7f-ea9dbfecdda3', name);
    }
  });

  it('mcp: mcp_tool_call даёт tool_use с именем mcp__<server>__<tool> и аргументами', () => {
    const tools = ofKind(events(adapter, fixture('mcp.jsonl')), 'tool_use');
    assert.deepEqual(
      tools.map((tool) => [tool.name, tool.input]),
      [['mcp__probe__echo', { message: 'ping' }]],
    );
    // Плоский текст без схемы — result без структуры.
    const results = ofKind(events(adapter, fixture('mcp.jsonl')), 'result');
    assert.equal(results.at(-1)?.text, 'ping');
    assert.equal(results.at(-1)?.structured, undefined);
  });

  // Сценарий: «Ошибка без класса»
  it('run3: предупреждение пропущено, error и turn.failed — отказ без класса с сообщением как есть', () => {
    const list = events(adapter, fixture('run3.jsonl'));
    assert.equal(list[1]?.kind, 'ignored', 'item.completed типа error — предупреждение');
    const results = ofKind(list, 'result');
    assert.equal(results.length, 2);
    for (const result of results) {
      assert.equal(result.failed, true);
      assert.equal(result.refusal, undefined, 'код 400 — не лимит и не аутентификация');
      assert.match(result.text ?? '', /"status":400/);
      assert.match(result.text ?? '', /not supported when using Codex/);
    }
  });

  // Сценарий: «Битая строка»
  it('битая и пустая строки, reasoning и todo_list', () => {
    assert.deepEqual(adapter.parseLine('{не json'), { kind: 'unparsed', line: '{не json' });
    assert.deepEqual(adapter.parseLine('   '), { kind: 'ignored' });
    assert.deepEqual(adapter.parseLine('{"type":"turn.started"}'), { kind: 'ignored' });
    assert.deepEqual(
      adapter.parseLine('{"type":"item.completed","item":{"id":"i","type":"reasoning","text":"…"}}'),
      { kind: 'ignored' },
    );
    assert.deepEqual(
      adapter.parseLine('{"type":"item.completed","item":{"id":"i","type":"todo_list","items":[]}}'),
      { kind: 'ignored' },
    );
  });
});

describe('codex-backend: классификация отказов', () => {
  const adapter = createCodexAdapter(CONFIG);
  const failed = fixture('run3.jsonl').find((line) => line.includes('"turn.failed"')) as string;

  function withStatus(status: number): string {
    // Живой записи 429/401 нет (README фикстур): код подменяется в записанном
    // 400 — единственное отступление от «только записанное», и оно названо.
    return failed.replace('\\"status\\":400', `\\"status\\":${status}`);
  }

  // Сценарий: «Отказ по лимиту»
  it('ПОДМЕНА КОДА: status 429 в записанном turn.failed — rate_limit с сообщением как есть', () => {
    const event = adapter.parseLine(withStatus(429));
    assert.equal(event.kind, 'result');
    if (event.kind !== 'result') return;
    assert.equal(event.refusal?.class, 'rate_limit');
    assert.equal(event.refusal?.statusCode, 429);
    assert.equal(event.refusal?.resetAt, undefined, 'момент сброса не выдумывается');
    assert.equal(event.refusal?.message, event.text);
  });

  it('ПОДМЕНА КОДА: 401 и 403 — unauthenticated', () => {
    for (const status of [401, 403]) {
      const event = adapter.parseLine(withStatus(status));
      assert.equal(event.kind === 'result' ? event.refusal?.class : undefined, 'unauthenticated', String(status));
    }
  });

  it('без разборного кода класс решает закрытый перечень формулировок', () => {
    const limit = adapter.parseLine(JSON.stringify({ type: 'turn.failed', error: { message: 'You have hit your usage limit.' } }));
    assert.equal(limit.kind === 'result' ? limit.refusal?.class : undefined, 'rate_limit');
    const auth = adapter.parseLine(JSON.stringify({ type: 'error', message: 'Not logged in. Run codex login.' }));
    assert.equal(auth.kind === 'result' ? auth.refusal?.class : undefined, 'unauthenticated');
    const other = adapter.parseLine(JSON.stringify({ type: 'turn.failed', error: { message: 'stream disconnected' } }));
    assert.equal(other.kind === 'result' ? other.refusal : undefined, undefined);
    assert.equal(other.kind === 'result' ? other.failed : undefined, true);
  });

  it('момент сброса заполняется только из полей ответа', () => {
    const body = (extra: Record<string, unknown>): string =>
      JSON.stringify({
        type: 'turn.failed',
        error: { message: JSON.stringify({ type: 'error', status: 429, error: { type: 'rate_limit', message: 'slow down', ...extra } }) },
      });
    const iso = adapter.parseLine(body({ resets_at: '2026-09-08T12:00:00Z' }));
    assert.equal(iso.kind === 'result' ? iso.refusal?.resetAt : undefined, Date.parse('2026-09-08T12:00:00Z'));
    const epoch = adapter.parseLine(body({ resets_at: 1_800_000_000 }));
    assert.equal(epoch.kind === 'result' ? epoch.refusal?.resetAt : undefined, 1_800_000_000_000);
    const before = Date.now();
    const relative = adapter.parseLine(body({ resets_in_seconds: 60 }));
    const at = relative.kind === 'result' ? relative.refusal?.resetAt ?? 0 : 0;
    assert.ok(at >= before + 60_000 && at <= Date.now() + 60_000);
  });
});

describe('codex-backend: возможности и манифест плагина', () => {
  // Сценарий: «Направление идентификатора»
  it('возможности берутся из конфигурации, направление — backend', () => {
    const adapter = createCodexAdapter({ ...CONFIG, sessions: false, mcp: false });
    assert.deepEqual(adapter.capabilities, {
      sessions: false,
      structuredOutput: true,
      strictPermissions: false,
      mcp: false,
      sessionIdSource: 'backend',
    });
  });

  it('манифест объявляет вклад codex с умолчаниями', () => {
    assert.equal(codexPlugin.name, 'codex');
    assert.deepEqual(codexPlugin.backends?.codex?.defaults, {
      command: 'codex',
      default_model: 'gpt-5.6-terra',
      sessions: true,
      structured_output: true,
      strict_permissions: false,
      mcp: true,
      concurrency: 2,
      cache_read_weight: 0.1,
    });
    assert.equal(codexPlugin.backends?.codex?.create(CONFIG).name, 'codex');
  });

  it('подпуть пакета ведёт на собранный модуль', () => {
    const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8')) as {
      exports: Record<string, string>;
    };
    assert.equal(pkg.exports['./backends/codex'], './dist/src/backends/codex/index.js');
    assert.ok(existsSync(fileURLToPath(new URL('../../dist/src/backends/codex/index.js', import.meta.url))));
  });
});

describe('codex-backend: исполнение шага на записанном потоке', () => {
  /** Адаптер Codex, чей запуск печатает записанный поток вместо вызова CLI. */
  function replaying(lines: (invocationIndex: number) => readonly string[]): {
    readonly adapter: BackendAdapter;
    readonly launches: AgentInvocation[];
  } {
    const real = createCodexAdapter(CONFIG);
    const launches: AgentInvocation[] = [];
    const adapter: BackendAdapter = {
      ...real,
      launch(invocation) {
        // Настоящая сборка запуска проверяется вместе с исполнением: форма
        // команды записывается, а исполняется подменённый процесс.
        launches.push(invocation);
        real.launch(invocation);
        const payload = JSON.stringify(lines(launches.length - 1).map((line) => `${line}\n`).join(''));
        return {
          command: [process.execPath, '-e', `process.stdout.write(${payload}, () => process.exit(0));`],
          stdin: invocation.prompt,
        };
      },
    };
    return { adapter, launches };
  }

  function step(overrides: Partial<AgentStep>): AgentStep {
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
      agent: 'codex',
      session: 'default',
      prompt: 'сделай',
      ...overrides,
    } as AgentStep;
  }

  it('сессия шага равна thread_id, структура — из последнего сообщения, второй шаг продолжает нить', async () => {
    const dir = tempDir('codex-');
    const backend = replaying((index) => fixture(index === 0 ? 'run1.jsonl' : 'run2.jsonl'));
    const sessions = createSessionRegistry();

    const first = await executeAgentStep({
      step: step({ id: 'first', outputSchemaPath: join(FIXTURES, 'schema.json') }),
      adapter: backend.adapter,
      cwd: dir,
      stepDir: dir,
      sessions,
      buildPrompt: () => 'промпт',
      env: () => ({ PATH: process.env.PATH ?? '' }),
    });

    assert.equal(first.sessionId, '01a07fb9-5e9f-74d0-8e7f-ea9dbfecdda3');
    assert.deepEqual(first.last?.structured, { answer: 'Два плюс два — четыре.', n: 4 });
    assert.equal(first.last?.usage.tokens_in, 35240 - 16640);
    assert.equal(first.last?.usage.cache_read, 16640);
    assert.deepEqual(first.last?.backendInit?.type, 'thread.started');
    assert.equal(backend.launches[0]?.sessionId, undefined);

    const second = await executeAgentStep({
      step: step({ id: 'second' }),
      adapter: backend.adapter,
      cwd: dir,
      stepDir: dir,
      sessions,
      buildPrompt: () => 'промпт',
      env: () => ({ PATH: process.env.PATH ?? '' }),
    });

    assert.equal(backend.launches[1]?.sessionId, '01a07fb9-5e9f-74d0-8e7f-ea9dbfecdda3');
    assert.equal(backend.launches[1]?.resumeSession, true);
    assert.equal(second.sessionId, '01a07fb9-5e9f-74d0-8e7f-ea9dbfecdda3');
  });
});
