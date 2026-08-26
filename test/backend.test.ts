import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { createClaudeAdapter, parseResetAt } from '../src/core/backend/claude.js';
import {
  authRefusalLine,
  createFakeBackend,
  initLine,
  rateLimitRefusalLine,
  resultLine,
  toolUseLine,
} from '../src/core/backend/fake.js';
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

describe('agent-backend: неустранимый отказ бэкенда', () => {
  const adapter = createClaudeAdapter(BACKEND);

  // Дословный конверт из прогона 2dc340
  // (jobs/plan/steps/01-read-change/stdout.log, запись `result`). Перед ней
  // в том же потоке идёт запись `assistant` с `is_api_error_message: true`,
  // но без `is_error` — как кандидат на классификацию она не рассматривается:
  // признак отказа приходит только с финальной записью `result` (см. задачу
  // 1.2 из tasks.md изменения backend-terminal-errors).
  const RATE_LIMIT_ENVELOPE =
    '{"is_error":true,"duration_api_ms":38573,"num_turns":19,"stop_reason":"stop_sequence","session_id":"a703e098-32b4-4c77-b857-60f5fea5e444","total_cost_usd":1.0312245,"usage":{"input_tokens":20,"cache_creation_input_tokens":70419,"cache_read_input_tokens":509879,"output_tokens":2384,"output_tokens_details":{"thinking_tokens":355},"server_tool_use":{"web_search_requests":0,"web_fetch_requests":0},"service_tier":"standard","cache_creation":{"ephemeral_1h_input_tokens":70419,"ephemeral_5m_input_tokens":0},"inference_geo":"not_available","iterations":[{"input_tokens":2,"output_tokens":147,"cache_read_input_tokens":68596,"cache_creation_input_tokens":1823,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":1823},"type":"message"}],"speed":"standard"},"modelUsage":{"claude-haiku-4-5-20251001":{"inputTokens":12320,"outputTokens":15,"cacheReadInputTokens":0,"cacheCreationInputTokens":0,"webSearchRequests":0,"costUSD":0.012395,"contextWindow":200000,"maxOutputTokens":32000,"canonicalModel":"claude-haiku-4-5","provider":"firstParty","costBasis":"list"},"claude-opus-5":{"inputTokens":20,"outputTokens":2384,"cacheReadInputTokens":509879,"cacheCreationInputTokens":70419,"webSearchRequests":0,"costUSD":1.0188295,"contextWindow":1000000,"maxOutputTokens":64000,"canonicalModel":"claude-opus-5","provider":"firstParty","costBasis":"list"}},"permission_denials":[],"terminal_reason":"api_error","fast_mode_state":"off","fast_mode_disabled_reason":"sdk_opt_in_required","subagent_stats":{"spawned":0,"requested":{"background":0,"foreground":0,"unset":0},"started_in_background":0,"max_depth":0,"spawned_by_subagents":0,"completed":0,"failed":0,"killed":{"parent":0,"user":0,"system":0},"refused":{"depth_limit":0,"concurrency_limit":0,"budget":0},"by_type":{}},"subtype":"success","api_error_status":429,"result":"You\'ve hit your session limit · resets 11pm (Asia/Nicosia)","type":"result","duration_ms":37992,"uuid":"47a102c3-5c79-4168-a6f6-4df76767337e","queued_turn_count":0}';

  // Запись `assistant` из того же потока, непосредственно перед конвертом
  // выше: несёт признак ошибки API, но не `is_error`.
  const RATE_LIMIT_PRECEDING_ASSISTANT =
    '{"type":"assistant","message":{"diagnostics":null,"id":"929d3ce4-4774-424b-8820-47bd282c8604","container":null,"model":"<synthetic>","role":"assistant","stop_details":null,"stop_reason":"stop_sequence","stop_sequence":"","type":"message","usage":{"output_tokens_details":null,"input_tokens":0,"output_tokens":0,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"server_tool_use":{"web_search_requests":0,"web_fetch_requests":0},"service_tier":null,"cache_creation":{"ephemeral_1h_input_tokens":0,"ephemeral_5m_input_tokens":0},"inference_geo":null,"iterations":null,"speed":null},"content":[{"type":"text","text":"You\'ve hit your session limit · resets 11pm (Asia/Nicosia)"}],"context_management":null},"parent_tool_use_id":null,"session_id":"a703e098-32b4-4c77-b857-60f5fea5e444","uuid":"b46c3bdd-feab-4149-8a8e-72d099da6003","timestamp":"2026-08-26T19:01:59.403Z","error":"rate_limit","request_id":"req_011CeRsr24vQUYYFADKxkMyp","is_api_error_message":true}';

  // Дословный конверт из прогона 18f9fc
  // (jobs/propose/steps/03-create-change/stdout.log, запись `result`):
  // отказ аутентификации без кода состояния (`api_error_status: null`).
  const AUTH_ENVELOPE =
    '{"is_error":true,"duration_api_ms":0,"num_turns":1,"stop_reason":"stop_sequence","session_id":"923a8100-557a-43b9-bdea-60b3fb75e4e7","total_cost_usd":0,"usage":{"output_tokens_details":{"thinking_tokens":0},"input_tokens":0,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":0,"server_tool_use":{"web_search_requests":0,"web_fetch_requests":0},"service_tier":"standard","cache_creation":{"ephemeral_1h_input_tokens":0,"ephemeral_5m_input_tokens":0},"inference_geo":"","iterations":[],"speed":"standard"},"modelUsage":{},"permission_denials":[],"terminal_reason":"api_error","fast_mode_state":"off","fast_mode_disabled_reason":"sdk_opt_in_required","subtype":"success","api_error_status":null,"result":"Failed to authenticate: OAuth session expired and could not be refreshed","type":"result","duration_ms":26,"uuid":"053e5e1e-260a-462b-a9f2-e9ba400f84fb"}';

  it('классифицирует упор в лимит подписки по коду состояния 429', () => {
    const event = adapter.parseLine(RATE_LIMIT_ENVELOPE) as { readonly kind: string; readonly refusal?: unknown };
    assert.equal(event.kind, 'result');
    assert.deepEqual(event.refusal, {
      class: 'rate_limit',
      message: "You've hit your session limit · resets 11pm (Asia/Nicosia)",
      statusCode: 429,
      resetAt: parseResetAt("You've hit your session limit · resets 11pm (Asia/Nicosia)"),
    });
  });

  it('запись assistant перед отказом не несёт классификации: у неё нет is_error', () => {
    // См. комментарий у RATE_LIMIT_PRECEDING_ASSISTANT: задача 1.2. Запись не
    // кандидат на классификацию — `is_api_error_message` не заменяет
    // `is_error`, и разбирается она как обычная запись без вызова инструмента,
    // то есть как нулевой расход (`kind: 'usage'`), не как отказ.
    const event = adapter.parseLine(RATE_LIMIT_PRECEDING_ASSISTANT) as {
      readonly kind: string;
      readonly refusal?: unknown;
    };
    assert.equal(event.kind, 'usage');
    assert.equal(event.refusal, undefined);
  });

  it('классифицирует отказ аутентификации по телу ответа, когда кода состояния нет', () => {
    const event = adapter.parseLine(AUTH_ENVELOPE) as { readonly kind: string; readonly refusal?: unknown };
    assert.equal(event.kind, 'result');
    assert.deepEqual(event.refusal, {
      class: 'unauthenticated',
      message: 'Failed to authenticate: OAuth session expired and could not be refreshed',
    });
  });

  it('is_error без кода состояния и без terminal_reason не классифицируется', () => {
    const event = adapter.parseLine(
      JSON.stringify({ type: 'result', is_error: true, result: 'что-то пошло не так' }),
    ) as { readonly kind: string; readonly refusal?: unknown; readonly failed?: boolean };
    assert.equal(event.refusal, undefined);
    assert.equal(event.failed, true, 'обычным отказом шага запись остаётся');
  });

  it('is_error с признаком ошибки API, но без узнаваемой формулировки, не классифицируется', () => {
    const event = adapter.parseLine(
      JSON.stringify({
        type: 'result',
        is_error: true,
        terminal_reason: 'api_error',
        result: 'что-то внутреннее сломалось',
      }),
    ) as { readonly kind: string; readonly refusal?: unknown };
    assert.equal(event.refusal, undefined);
  });

  it('успешный ответ с формулировкой про лимит в тексте не классифицируется', () => {
    const event = adapter.parseLine(resultLine({ text: 'мы обсудили лимит подписки и решили подождать' })) as {
      readonly kind: string;
      readonly refusal?: unknown;
      readonly failed?: boolean;
    };
    assert.equal(event.refusal, undefined);
    assert.equal(event.failed, undefined);
  });

  it('запись без is_error не классифицируется', () => {
    const event = adapter.parseLine(
      JSON.stringify({ type: 'result', api_error_status: 429, result: 'мимо' }),
    ) as { readonly kind: string; readonly refusal?: unknown };
    assert.equal(event.refusal, undefined);
  });

  it('фейковый бэкенд воспроизводит оба конверта тем же путём разбора', () => {
    assert.deepEqual(
      (adapter.parseLine(rateLimitRefusalLine()) as { readonly refusal?: unknown }).refusal,
      {
        class: 'rate_limit',
        message: "You've hit your session limit · resets 11pm (Asia/Nicosia)",
        statusCode: 429,
        resetAt: parseResetAt("You've hit your session limit · resets 11pm (Asia/Nicosia)"),
      },
    );
    assert.deepEqual((adapter.parseLine(authRefusalLine()) as { readonly refusal?: unknown }).refusal, {
      class: 'unauthenticated',
      message: 'Failed to authenticate: OAuth session expired and could not be refreshed',
    });
  });
});

describe('agent-backend: момент сброса окна лимита', () => {
  const NOW = Date.parse('2026-08-26T19:00:00.000Z'); // 22:00 в Asia/Nicosia (UTC+3)

  it('час ещё не наступил сегодня в названном поясе', () => {
    const resetAt = parseResetAt('resets 11pm (Asia/Nicosia)', NOW);
    assert.equal(resetAt, Date.parse('2026-08-26T20:00:00.000Z'));
  });

  it('час уже прошёл сегодня — берётся ближайшее будущее наступление, завтра', () => {
    const resetAt = parseResetAt('resets 9pm (Asia/Nicosia)', NOW);
    assert.equal(resetAt, Date.parse('2026-08-27T18:00:00.000Z'));
  });

  it('минуты и часовой пояс с получасовым смещением', () => {
    // Asia/Kolkata: UTC+5:30. NOW = 2026-08-27T00:30 IST.
    const resetAt = parseResetAt('resets 11:15pm (Asia/Kolkata)', NOW);
    assert.equal(resetAt, Date.parse('2026-08-27T17:45:00.000Z'));
  });

  it('неизвестный часовой пояс не даёт момента', () => {
    assert.equal(parseResetAt('resets 11pm (Mars/Colony)', NOW), undefined);
  });

  it('метка ISO 8601 со смещением разбирается напрямую', () => {
    const resetAt = parseResetAt('resets 2026-08-27T21:00:00+03:00', NOW);
    assert.equal(resetAt, Date.parse('2026-08-27T18:00:00.000Z'));
  });

  it('метка ISO 8601 с Z разбирается напрямую', () => {
    const resetAt = parseResetAt('resets 2026-08-27T18:00:00Z', NOW);
    assert.equal(resetAt, Date.parse('2026-08-27T18:00:00.000Z'));
  });

  it('метка ISO 8601 в прошлом не даёт момента', () => {
    // Иначе ожидание по ней длится нуль миллисекунд, и прогон крутит
    // «переисполнить шаг → тот же отказ» без сна и без предела max_wait.
    assert.equal(parseResetAt('resets 2026-08-26T18:00:00Z', NOW), undefined);
    assert.equal(parseResetAt('resets 2026-08-26T19:00:00.000Z', NOW), undefined);
  });

  it('нераспознанная форма и мусор не дают момента', () => {
    assert.equal(parseResetAt('resets soon', NOW), undefined);
    assert.equal(parseResetAt('полная бессмыслица', NOW), undefined);
  });

  it('отсутствие упоминания сброса не даёт момента', () => {
    assert.equal(parseResetAt("You've hit your session limit", NOW), undefined);
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

describe('step-execution: отказ бэкенда прекращает попытки', () => {
  it('отказ аутентификации на первой попытке не расходует оставшиеся', async () => {
    const dir = workdir();
    const backend = createFakeBackend({ lines: [authRefusalLine()], exitCode: 1 });

    const result = await executeAgentStep({
      step: makeAgentStep({ attempts: { max: 3, escalation: [] } }),
      adapter: backend.adapter,
      cwd: dir,
      stepDir: dir,
      sessions: createSessionRegistry(),
      buildPrompt: () => 'промпт',
      env: () => ({ PATH: process.env.PATH ?? '' }),
    });

    assert.equal(backend.invocations.length, 1, 'запущен ровно один процесс бэкенда');
    assert.equal(result.attempts.length, 1, 'записана ровно одна попытка');
    assert.equal(result.status, 'failed');
    assert.equal(result.last?.refusal?.class, 'unauthenticated');
  });

  it('упор в лимит подписки тоже прекращает попытки немедленно', async () => {
    const dir = workdir();
    const backend = createFakeBackend({ lines: [rateLimitRefusalLine()], exitCode: 1 });

    const result = await executeAgentStep({
      step: makeAgentStep({ attempts: { max: 3, escalation: [] } }),
      adapter: backend.adapter,
      cwd: dir,
      stepDir: dir,
      sessions: createSessionRegistry(),
      buildPrompt: () => 'промпт',
      env: () => ({ PATH: process.env.PATH ?? '' }),
    });

    assert.equal(backend.invocations.length, 1);
    assert.equal(result.attempts.length, 1);
    assert.equal(result.last?.refusal?.class, 'rate_limit');
    assert.equal(result.last?.refusal?.statusCode, 429);
  });

  it('нераспознанный отказ бэкенда по-прежнему повторяется по attempts.max', async () => {
    const dir = workdir();
    const backend = createFakeBackend({ lines: [resultLine({ text: 'плохо' })], exitCode: 1 });

    const result = await executeAgentStep({
      step: makeAgentStep({ attempts: { max: 3, escalation: [] } }),
      adapter: backend.adapter,
      cwd: dir,
      stepDir: dir,
      sessions: createSessionRegistry(),
      buildPrompt: () => 'промпт',
      env: () => ({ PATH: process.env.PATH ?? '' }),
    });

    assert.equal(backend.invocations.length, 3, 'отказ без классификации тратит все попытки как раньше');
    assert.equal(result.last?.refusal, undefined);
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
