import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import type { BackendAdapter, BackendRefusal } from '../backend/types.js';
import {
  BACKEND_REFUSAL_PREDICATE,
  describeRefusal,
  emptyUsage,
  mergeUsage,
  messagePrefix,
} from '../backend/types.js';
import { judgeVerdictSchemaPath, parseVerdict } from '../expect/verdict.js';
import type { PredicateResult, Usage } from '../journal/schema.js';
import type { RunJournal } from '../journal/writer.js';
import type { Predicate } from '../pipeline/model.js';
import { runProcess } from './process.js';

/**
 * Второй, асинхронный проход попытки.
 *
 * Синхронный проход (`expect/evaluate.ts`) вычисляет структурные предикаты и
 * оставляет судей заготовками «не вычислен» — он не знает про адаптеры,
 * сессии и журнал. Этот проход вызывает судей по объявленному порядку и
 * подставляет их вердикты на свои места, не трогая позиции остальных
 * предикатов: читающему важен порядок, который он написал.
 *
 * Общий для командного и агентского шага — единственная разница между ними
 * снаружи этого модуля: что именно передано как `text`/`structured`.
 */

type JudgePredicate = Extract<Predicate, { kind: 'judge' }>;

export interface JudgePassOptions {
  readonly predicates: readonly Predicate[];
  /** Результат синхронного прохода — тот же порядок, судьи в нём — заготовки. */
  readonly firstPass: readonly PredicateResult[];
  /** Задание шага без блока контекста: `step.prompt` либо командная строка. */
  readonly task: string;
  readonly text: string;
  /** Для командного шага структурированного вывода нет — его место занимает stdout. */
  readonly structured: unknown;
  readonly cwd: string;
  readonly stepDir: string;
  readonly attempt: number;
  readonly timeoutMs: number;
  readonly stallTimeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly onStall?: (silentMs: number) => void;
  readonly adapterFor: (name: string) => BackendAdapter;
  readonly defaultAgent: string;
  readonly journal: RunJournal;
  /** Сквозной номер вызова в пределах шага: растёт через попытки и предикаты. */
  readonly nextCallIndex: () => number;
  /** Действующий бюджет ещё не исчерпан — проверяется перед каждым вызовом. */
  readonly canCall: () => boolean;
  readonly onUsage: (usage: Usage) => void;
}

export async function runJudgePass(
  options: JudgePassOptions,
): Promise<readonly PredicateResult[]> {
  // Попытка уже отклонена жёстким предиктом, вычисленным без обращения к
  // агенту, — платить токенами и минутами за суждение о ней незачем.
  const hardStructuralFailure = options.firstPass.some(
    (result, index) =>
      options.predicates[index]?.kind !== 'judge' && result.hard && !result.passed,
  );
  if (hardStructuralFailure) return options.firstPass;

  const results = [...options.firstPass];

  for (const [index, predicate] of options.predicates.entries()) {
    if (predicate.kind !== 'judge') continue;

    if (!options.canCall()) {
      results[index] = unevaluated(predicate, 'действующий бюджет уже исчерпан');
      continue;
    }

    const otherResults = results.filter((_, otherIndex) => otherIndex !== index);
    const call = await callJudge({
      predicate,
      task: options.task,
      text: options.text,
      structured: options.structured,
      otherResults,
      cwd: options.cwd,
      stepDir: options.stepDir,
      attempt: options.attempt,
      timeoutMs: options.timeoutMs,
      ...(options.stallTimeoutMs === undefined ? {} : { stallTimeoutMs: options.stallTimeoutMs }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.onStall === undefined ? {} : { onStall: options.onStall }),
      adapter: options.adapterFor(predicate.agent ?? options.defaultAgent),
      journal: options.journal,
      callIndex: options.nextCallIndex(),
    });

    options.onUsage(call.usage);
    results[index] = call.result;
    // Отказ бэкенда на судье — не вердикт: дальнейших судей звать незачем,
    // они уперлись бы в тот же отказ.
    if (call.result.predicate === BACKEND_REFUSAL_PREDICATE) break;
  }

  return results;
}

function unevaluated(predicate: JudgePredicate, reason: string): PredicateResult {
  return {
    predicate: 'judge',
    passed: true,
    hard: false,
    expected: predicate.claim,
    detail: `не вычислен: ${reason}`,
  };
}

interface CallJudgeOptions {
  readonly predicate: JudgePredicate;
  readonly task: string;
  readonly text: string;
  readonly structured: unknown;
  readonly otherResults: readonly PredicateResult[];
  readonly cwd: string;
  readonly stepDir: string;
  readonly attempt: number;
  readonly timeoutMs: number;
  readonly stallTimeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly onStall?: (silentMs: number) => void;
  readonly adapter: BackendAdapter;
  readonly journal: RunJournal;
  readonly callIndex: number;
}

interface CallJudgeResult {
  readonly result: PredicateResult;
  readonly usage: Usage;
}

async function callJudge(options: CallJudgeOptions): Promise<CallJudgeResult> {
  const { predicate, adapter } = options;
  const prompt = buildPrompt(options);

  const launch = adapter.launch({
    prompt,
    cwd: options.cwd,
    ...(predicate.model === undefined ? {} : { model: predicate.model }),
    // Свежий идентификатор, продолжение выключено: судья не должен ни
    // попасть в сессию шага, ни начать общую с другим вызовом.
    sessionId: randomUUID(),
    resumeSession: false,
    outputSchemaPath: judgeVerdictSchemaPath(),
  });

  const dir = options.journal.prepareJudgeCall(options.stepDir, options.callIndex);
  options.journal.writeStepFile(dir, 'prompt.txt', prompt);

  let usage = emptyUsage(adapter.name, predicate.model, 0);
  let structured: unknown;
  let refusal: BackendRefusal | undefined;
  let carry = '';

  const consume = (chunk: string): void => {
    carry += chunk;
    const lines = carry.split('\n');
    carry = lines.pop() ?? '';
    for (const line of lines) handle(line);
  };

  const recordMessageUsage = (delta: Partial<Usage> | undefined): void => {
    if (delta === undefined) return;
    // Пик — величина этого сообщения; итоговая `result` ниже несёт
    // накопительный итог вызова, а не одно сообщение, и в пик не годится.
    const peak = messagePrefix(delta);
    usage = mergeUsage(usage, peak === undefined ? delta : { ...delta, peak_prefix_tokens: peak });
  };

  const handle = (line: string): void => {
    const event = adapter.parseLine(line);
    // Сообщение с вызовом инструмента адаптер отдаёт как `tool_use`, а не как
    // `usage`, хотя расход в нём тот же (см. `src/core/backend/claude.ts`).
    // Пропустить его значило бы занижать пик тем сильнее, чем больше судья
    // звал инструментов, — и терять при этом самые поздние, самые большие
    // обращения.
    if (event.kind === 'usage' || event.kind === 'tool_use') {
      recordMessageUsage(event.usage);
    } else if (event.kind === 'result') {
      if (event.structured !== undefined) structured = event.structured;
      usage = mergeUsage(usage, event.usage);
      if (event.refusal !== undefined) refusal = event.refusal;
    }
  };

  const process_ = await runProcess({
    command: launch.command,
    cwd: options.cwd,
    env: launch.env ?? {},
    stdin: launch.stdin,
    timeoutMs: options.timeoutMs,
    ...(options.stallTimeoutMs === undefined ? {} : { stallTimeoutMs: options.stallTimeoutMs }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.onStall === undefined ? {} : { onStall: options.onStall }),
    stdoutPath: join(dir, 'stdout.log'),
    stderrPath: join(dir, 'stderr.log'),
    onStdout: consume,
  });

  if (carry.trim() !== '') handle(carry);
  usage = { ...usage, wallclock_ms: process_.wallclockMs };

  const verdict = process_.outcome === 'exited' ? parseVerdict(structured) : undefined;

  // Отказ бэкенда проверяется раньше разбора вердикта: и лимит подписки, и
  // отказ аутентификации оставляют структурированный вывод пустым, и без этой
  // проверки они попали бы в «судья не вернул вердикт по схеме» — отказ
  // бэкенда, а не судьи.
  const result: PredicateResult =
    refusal !== undefined
      ? {
          predicate: BACKEND_REFUSAL_PREDICATE,
          passed: false,
          hard: true,
          detail: describeRefusal(refusal),
          actual: refusal,
        }
      : verdict !== undefined
        ? {
            predicate: 'judge',
            passed: verdict.pass,
            hard: predicate.hard,
            expected: predicate.claim,
            detail: verdict.reason,
          }
        : {
            predicate: 'judge',
            passed: false,
            hard: predicate.hard,
            expected: predicate.claim,
            detail: describeFailure(process_.outcome, options.timeoutMs),
          };

  options.journal.writeStepJson(dir, 'verdict.json', {
    attempt: options.attempt,
    claim: predicate.claim,
    pass: verdict?.pass ?? null,
    reason: verdict?.reason ?? null,
  });
  options.journal.writeStepJson(dir, 'usage.json', usage);

  return { result, usage };
}

function describeFailure(outcome: string, timeoutMs: number): string {
  switch (outcome) {
    case 'timeout':
      return `Судья не завершился за ${timeoutMs} мс`;
    case 'canceled':
      return 'Прогон отменён';
    case 'spawn_failed':
      return 'Процесс судьи не удалось запустить';
    default:
      return 'Судья не вернул вердикт по схеме';
  }
}

function buildPrompt(options: {
  readonly predicate: JudgePredicate;
  readonly task: string;
  readonly text: string;
  readonly structured: unknown;
  readonly otherResults: readonly PredicateResult[];
}): string {
  const parts = [
    `# Утверждение для проверки\n\n${options.predicate.claim}`,
    `# Задание шага\n\n${options.task}`,
    `# Текстовый результат шага\n\n${options.text === '' ? '(пусто)' : options.text}`,
    `# Структурированный вывод шага\n\n${
      options.structured === undefined ? '(отсутствует)' : JSON.stringify(options.structured, null, 2)
    }`,
  ];

  if (options.otherResults.length > 0) {
    const lines = options.otherResults.map(
      (result) =>
        `- ${result.predicate}: ${result.passed ? 'пройдена' : 'не пройдена'}${
          result.detail === undefined ? '' : ` — ${result.detail}`
        }`,
    );
    parts.push(`# Результаты остальных проверок\n\n${lines.join('\n')}`);
  }

  parts.push('Верни вердикт строго структурой { pass: boolean, reason: string } по переданной схеме.');
  return parts.join('\n\n');
}
