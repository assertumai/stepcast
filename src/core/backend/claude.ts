import { readFileSync } from 'node:fs';

import type { BackendConfig } from '../config/resolve.js';
import type { AgentInvocation, BackendAdapter, BackendEvent, LaunchSpec } from './types.js';

/**
 * Адаптер Claude Code.
 *
 * Запуск неинтерактивный, через каналы, с потоковым структурированным
 * выводом. Промпт уходит на stdin. Политика доступа транслируется в флаги:
 * без неё шаг упрётся в отказ на первой же записи файла, потому что
 * неинтерактивный режим разрешений не спрашивает и не выдаёт.
 */
export function createClaudeAdapter(config: BackendConfig): BackendAdapter {
  return {
    name: 'claude',
    capabilities: {
      sessions: config.sessions,
      structuredOutput: config.structuredOutput,
    },

    launch(invocation: AgentInvocation): LaunchSpec {
      const command = [config.command, '--print', '--output-format', 'stream-json', '--verbose'];

      const model = invocation.model ?? config.defaultModel;
      if (model !== undefined) command.push('--model', model);

      if (invocation.sessionId !== undefined && config.sessions) {
        command.push(invocation.resumeSession ? '--resume' : '--session-id', invocation.sessionId);
      }

      if (invocation.outputSchemaPath !== undefined && config.structuredOutput) {
        command.push('--json-schema', readFileSync(invocation.outputSchemaPath, 'utf8'));
      }

      const permissions = invocation.permissions ?? config.permissions;
      if (permissions?.mode !== undefined) command.push('--permission-mode', permissions.mode);
      if (permissions?.allow !== undefined && permissions.allow.length > 0) {
        command.push('--allowedTools', permissions.allow.join(' '));
      }
      if (permissions?.deny !== undefined && permissions.deny.length > 0) {
        command.push('--disallowedTools', permissions.deny.join(' '));
      }

      return { command, stdin: invocation.prompt, env: config.env };
    },

    parseLine(line: string): BackendEvent {
      const trimmed = line.trim();
      if (trimmed === '') return { kind: 'ignored' };

      let record: Record<string, unknown>;
      try {
        record = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        return { kind: 'unparsed', line: trimmed };
      }

      const type = record.type;

      if (type === 'system' && record.subtype === 'init') {
        return { kind: 'init', data: record };
      }

      if (type === 'assistant') {
        const message = record.message as Record<string, unknown> | undefined;
        const tool = firstToolUse(message);
        if (tool !== undefined) return tool;
        const usage = readUsage(message?.usage);
        if (usage !== undefined) return { kind: 'usage', usage };
        return { kind: 'ignored' };
      }

      if (type === 'result') {
        const usage = readUsage(record.usage);
        return {
          kind: 'result',
          ...(typeof record.result === 'string' ? { text: record.result } : {}),
          ...(record.structured_output === undefined
            ? {}
            : { structured: record.structured_output }),
          ...(usage === undefined
            ? {}
            : {
                usage: {
                  ...usage,
                  ...(typeof record.total_cost_usd === 'number'
                    ? { reported_cost_usd: record.total_cost_usd }
                    : {}),
                  ...readRateLimits(record),
                },
              }),
          ...(record.is_error === true || record.subtype === 'error' ? { failed: true } : {}),
        };
      }

      return { kind: 'ignored' };
    },
  };
}

function firstToolUse(message: Record<string, unknown> | undefined): BackendEvent | undefined {
  const content = message?.content;
  if (!Array.isArray(content)) return undefined;
  for (const block of content) {
    const item = block as Record<string, unknown>;
    if (item.type === 'tool_use' && typeof item.name === 'string') {
      return { kind: 'tool_use', name: item.name, input: item.input };
    }
  }
  return undefined;
}

/** Привести расход к общему виду. Несообщённое поле остаётся отсутствующим. */
function readUsage(raw: unknown): Record<string, number> | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const source = raw as Record<string, unknown>;

  const mapping: Array<readonly [string, string]> = [
    ['input_tokens', 'tokens_in'],
    ['output_tokens', 'tokens_out'],
    ['cache_read_input_tokens', 'cache_read'],
    ['cache_creation_input_tokens', 'cache_write'],
  ];

  const out: Record<string, number> = {};
  for (const [from, to] of mapping) {
    const value = source[from];
    if (typeof value === 'number') out[to] = value;
  }

  return Object.keys(out).length === 0 ? undefined : out;
}

/** Окон лимитов у подписки несколько, и ночной прогон упирается в недельное. */
function readRateLimits(record: Record<string, unknown>): {
  rate_limits?: Record<string, { used_pct: number; resets_at?: number }>;
} {
  const raw = record.rate_limits;
  if (typeof raw !== 'object' || raw === null) return {};

  const out: Record<string, { used_pct: number; resets_at?: number }> = {};
  for (const [window, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null) continue;
    const item = value as Record<string, unknown>;
    const used = item.used_percentage ?? item.used_pct;
    if (typeof used !== 'number') continue;
    out[window] = {
      used_pct: used,
      ...(typeof item.resets_at === 'number' ? { resets_at: item.resets_at } : {}),
    };
  }

  return Object.keys(out).length === 0 ? {} : { rate_limits: out };
}
